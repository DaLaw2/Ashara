import { parseProjectId } from "@ashara/shared";
import type { ProductObservation, ProjectContract, ProjectId, StoredTaskSpec } from "@ashara/shared";
import type { AcceptanceLLM, EndpointCoverageGap, AcceptanceVerdict, AcceptanceGap, StopReason, TerminationPlanExhausted, CompletionFigure } from "./acl/planning-acl.js";
import {
  assembleRunSummaryItems,
  evaluate,
  buildRunSummary,
  computeCoverageGaps,
  isBlockingCoverageGap,
  assessProductObservation,
  buildVisionGaps,
  buildAcceptanceVerdict,
  buildUnverifiedVerdict,
  createPendingWorkItem,
  computeCompletionFigure,
} from "./acl/planning-acl.js";
import type { CoreLoopDeps, TerminationOutcome } from "./types.js";

export async function evaluateRunTermination(
  deps: CoreLoopDeps,
  budgetExhausted: boolean,
  runScope: string,
): Promise<TerminationOutcome> {
  const items = await assembleRunSummaryItems({
    workItemRepo: deps.workItemRepo,
    replanBound: deps.failureRouter.replanBound,
  });
  const endpointGaps = await currentCoverageGaps(deps);
  const openCoverageGaps = deps.config.coverageEnforcing
    ? endpointGaps.filter(isBlockingCoverageGap).length
    : 0;
  const decision = evaluate({ items, budgetExhausted, openCoverageGaps });

  if (decision.decision === "continue") {
    return { decision, summary: null };
  }

  // Resolve the contract once for both the completion figure and downstream
  // consumers. Empty evidence is honest: at termination time no probes,
  // checks, or file-existence queries have been run, so the figure reports
  // the declared surface size (denominator) with zero verified (numerator).
  const contract = await resolveFirstContract(deps);
  const completionFigure = computeCompletionFigure(contract, {});

  if (decision.decision === "stop") {
    const summary = buildRunSummary({ items, endpointGaps, completionFigure, currentRunScope: runScope }, decision);
    return { decision, summary };
  }

  return handlePlanExhausted(deps, decision, items, endpointGaps, runScope, completionFigure);
}

async function handlePlanExhausted(
  deps: CoreLoopDeps,
  decision: TerminationPlanExhausted,
  items: Awaited<ReturnType<typeof assembleRunSummaryItems>>,
  endpointGaps: EndpointCoverageGap[],
  runScope: string,
  completionFigure: CompletionFigure,
): Promise<TerminationOutcome> {
  const acceptance = await runAcceptanceCheck(deps, items);

  if (acceptance.outcome === "rejected") {
    const maxGapAttempts = deps.config.maxGapAttempts;
    if (deps.acceptanceAttempts < maxGapAttempts) {
      await createGapTasks(deps, acceptance.gaps, runScope);
      return { decision: { decision: "continue", counts: decision.counts }, summary: null };
    }
  }

  const stopReason: StopReason = deriveStopReason(acceptance);

  const stopDecision = {
    decision: "stop" as const,
    reason: stopReason,
    counts: decision.counts,
    stalled: [...decision.stalled],
    abandonedRoots: [] as string[],
  };

  const summary = buildRunSummary({ items, endpointGaps, acceptance, completionFigure, currentRunScope: runScope }, decision);

  return { decision: stopDecision, summary };
}

function deriveStopReason(acceptance: AcceptanceVerdict): StopReason {
  switch (acceptance.outcome) {
    case "accepted":
      return "accepted";
    case "unverified":
      return "unverified";
    case "rejected":
    case "accepted-with-caveats":
      return "accepted-with-caveats";
  }
}

/**
 * The slice of {@link CoreLoopDeps} the acceptance check reads. Declared narrowly so
 * the check is exercisable against a small double — `CoreLoopDeps` satisfies it
 * structurally, so there is no second wiring to keep in step.
 */
export interface AcceptanceCheckDeps {
  readonly config: { readonly maxAcceptanceAttempts: number };
  readonly visionRepo: {
    getLatest(): Promise<{ readonly visionText: string; readonly projectPath: string | null } | null>;
  };
  readonly workItemRepo: {
    listAll(): Promise<ReadonlyArray<{ readonly id: string; readonly parentId?: string }>>;
  };
  readonly contractRepo?: { getLatest(projectId: ProjectId): Promise<ProjectContract | null> };
  readonly acceptanceLlm?: AcceptanceLLM;
  readonly observeProduct?: (input: {
    readonly targetPath: string;
    readonly contract: ProjectContract | null;
  }) => Promise<ProductObservation>;
  acceptanceAttempts: number;
  lastAcceptanceVerdict?: AcceptanceVerdict;
}

export interface AcceptanceCheckItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * Run both acceptance tiers and return a verdict that distinguishes "checked and
 * fine" from "did not check". Every early return below is an epistemic state, and
 * none of them may borrow `accepted`'s meaning.
 */
export async function runAcceptanceCheck(
  deps: AcceptanceCheckDeps,
  items: readonly AcceptanceCheckItem[],
): Promise<AcceptanceVerdict> {
  const maxAttempts = deps.config.maxAcceptanceAttempts;
  // POLICY default: no prior verdict → no prior gaps to carry. The epistemic
  // state is outcome:"unverified" (acceptance.ts:318-321), not the array length.
  // A termination can be superseded by a NOTIFY and re-entered (runner.ts
  // handleTermination), and on re-entry the cap below may leave nothing to
  // recompute; carrying these forward is the difference between reporting the
  // last known gaps and reporting none at all.
  const priorGaps = deps.lastAcceptanceVerdict?.gaps ?? [];

  if (!deps.acceptanceLlm && !deps.observeProduct) {
    return buildUnverifiedVerdict({
      cause: "no-checker-configured",
      detail: "neither an acceptance LLM nor a product observer is wired into the core loop",
      attempt: deps.acceptanceAttempts,
      maxAttempts,
      priorGaps,
    });
  }

  if (deps.acceptanceAttempts >= maxAttempts) {
    // Running out of chances to look is not a clean bill of health. This used to
    // hand an empty gap list to buildAcceptanceVerdict, where `gaps.length === 0`
    // meant `accepted` — the Run 39 line that told an owner all requirements were
    // met while listing the ones that were not.
    return buildUnverifiedVerdict({
      cause: "attempts-exhausted",
      detail:
        `the acceptance check had already run ${deps.acceptanceAttempts} time(s) against a cap of ${maxAttempts}, ` +
        "so this termination was never checked" +
        (priorGaps.length > 0
          ? `. The last completed check left ${priorGaps.length} gap(s) open, carried below`
          : " and no earlier check left findings to fall back on"),
      attempt: deps.acceptanceAttempts,
      maxAttempts,
      priorGaps,
    });
  }

  try {
    const vision = await deps.visionRepo.getLatest();
    if (!vision) {
      return buildUnverifiedVerdict({
        cause: "no-vision",
        detail: "no vision record exists, so there is nothing to check the product against",
        attempt: deps.acceptanceAttempts,
        maxAttempts,
        priorGaps,
      });
    }

    const allGaps: AcceptanceGap[] = [];
    const unchecked: string[] = [];

    // Deterministic tier. Its absence used to leave no trace at all, and the verdict
    // was then computed from the LLM tier alone as though this tier had passed.
    if (!deps.observeProduct) {
      unchecked.push(
        "no product observer is wired into the core loop, so the deterministic tier never ran and nothing looked at the built product",
      );
    } else if (vision.projectPath === null) {
      unchecked.push(
        "the vision record carries no projectPath, so the deterministic tier had no product to observe",
      );
    } else {
      // Resolved once and used twice: the observer needs it to know what to probe,
      // the assessment needs it to know what was promised. Reading it separately
      // was how the observer ended up judging a product it was never told about.
      const contract = await latestContract(deps);
      const observation = await deps.observeProduct({ targetPath: vision.projectPath, contract });
      const assessment = assessProductObservation(observation, contract);
      allGaps.push(...assessment.gaps);
      unchecked.push(...assessment.unchecked);
    }

    // Vision-gap tier. Same rule as above: an absent tier is recorded, never assumed.
    if (!deps.acceptanceLlm) {
      unchecked.push(
        "no acceptance LLM is wired into the core loop, so the vision was never compared against the work that shipped",
      );
    } else if (vision.visionText.length === 0) {
      unchecked.push(
        "the vision record carries no vision text, so there was nothing to compare the shipped work against",
      );
    } else {
      const visionText = vision.visionText;
      const visionGapResult = await deps.acceptanceLlm.checkVisionGaps({
        visionText,
        items: items.map((i) => ({ id: i.id, title: i.title, status: i.status })),
      });
      allGaps.push(...buildVisionGaps(visionGapResult, visionText));
    }

    deps.acceptanceAttempts += 1;
    const verdict = buildAcceptanceVerdict(allGaps, unchecked, deps.acceptanceAttempts, maxAttempts);
    deps.lastAcceptanceVerdict = verdict;
    return verdict;
  } catch (e) {
    console.error(
      `Acceptance check threw at attempt ${deps.acceptanceAttempts + 1}/${maxAttempts} — run will stop as unverified:`,
      e,
    );
    return buildUnverifiedVerdict({
      cause: "check-threw",
      detail: e,
      attempt: deps.acceptanceAttempts,
      maxAttempts,
      priorGaps,
    });
  }
}

async function latestContract(deps: AcceptanceCheckDeps): Promise<ProjectContract | null> {
  const contractRepo = deps.contractRepo;
  if (!contractRepo) return null;
  const roots = (await deps.workItemRepo.listAll()).filter((i) => i.parentId === undefined);
  for (const root of roots) {
    const contract = await contractRepo.getLatest(parseProjectId(root.id));
    if (contract) return contract;
  }
  return null;
}

/**
 * Resolve the first available ProjectContract for the completion figure.
 * Structurally identical to `latestContract` but accepts CoreLoopDeps so
 * it can be called outside the acceptance-check scope.
 */
async function resolveFirstContract(deps: CoreLoopDeps): Promise<ProjectContract | null> {
  if (!deps.contractRepo) return null;
  const items = await deps.workItemRepo.listAll();
  const roots = items.filter((i) => i.parentId === undefined);
  for (const root of roots) {
    const contract = await deps.contractRepo.getLatest(parseProjectId(root.id));
    if (contract) return contract;
  }
  return null;
}

async function createGapTasks(
  deps: CoreLoopDeps,
  gaps: readonly AcceptanceGap[],
  runScope: string,
): Promise<void> {
  if (gaps.length === 0) return;

  const allItems = await deps.workItemRepo.listAll();
  const root = allItems.find((i) => i.parentId === undefined);
  if (!root) return;

  const existingTitles = new Set(
    allItems
      .filter((i) => i.status === "Pending" || i.status === "InProgress")
      .map((i) => i.title.toLowerCase()),
  );

  for (const gap of gaps) {
    const title = `[acceptance] ${gap.expected}`;
    if (existingTitles.has(title.toLowerCase())) continue;

    const taskSpec: StoredTaskSpec = {
      goal: gap.expected,
      endState: gap.expected,
      checks: [],
      deliverables: [],
      origin: "acceptance-gap",
    };
    if (gap.lesson) taskSpec.lesson = gap.lesson;
    if (gap.suggestedApproach) taskSpec.suggestedApproach = gap.suggestedApproach;
    if (gap.supersedes) taskSpec.supersedes = gap.supersedes;

    const item = createPendingWorkItem("Task", title, runScope, root.id, gap.observed, taskSpec);
    await deps.workItemRepo.create(item);
  }
}

async function currentCoverageGaps(deps: CoreLoopDeps): Promise<EndpointCoverageGap[]> {
  if (!deps.contractRepo) return [];
  const items = await deps.workItemRepo.listAll();
  const roots = items.filter((item) => item.parentId === undefined);
  const gaps: EndpointCoverageGap[] = [];
  for (const root of roots) {
    const contract = await deps.contractRepo.getLatest(parseProjectId(root.id));
    gaps.push(...computeCoverageGaps(contract, items));
  }
  return gaps;
}
