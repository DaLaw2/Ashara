import { parseProjectId } from "@ashara/shared";
import type { ProjectContract } from "@ashara/shared";
import type { EndpointCoverageGap, AcceptanceVerdict, AcceptanceGap, StopReason, TerminationPlanExhausted } from "./acl/planning-acl.js";
import {
  assembleRunSummaryItems,
  evaluate,
  buildRunSummary,
  computeCoverageGaps,
  isBlockingCoverageGap,
  buildDeterministicGaps,
  buildVisionGaps,
  buildAcceptanceVerdict,
  buildUnverifiedVerdict,
  createPendingWorkItem,
} from "./acl/planning-acl.js";

import type { CoreLoopDeps, TerminationOutcome } from "./types.js";

export async function evaluateRunTermination(
  deps: CoreLoopDeps,
  budgetExhausted: boolean,
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

  if (decision.decision === "stop") {
    const summary = buildRunSummary({ items, endpointGaps }, decision);
    return { decision, summary };
  }

  return handlePlanExhausted(deps, decision, items, endpointGaps);
}

async function handlePlanExhausted(
  deps: CoreLoopDeps,
  decision: TerminationPlanExhausted,
  items: Awaited<ReturnType<typeof assembleRunSummaryItems>>,
  endpointGaps: EndpointCoverageGap[],
): Promise<TerminationOutcome> {
  const acceptance = await runAcceptanceCheck(deps, items);

  if (acceptance.outcome === "rejected") {
    const maxGapAttempts = deps.config.maxGapAttempts ?? 2;
    if (deps.acceptanceAttempts < maxGapAttempts) {
      await createGapTasks(deps, acceptance.gaps);
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

  const summary = buildRunSummary({ items, endpointGaps, acceptance }, decision);

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

async function runAcceptanceCheck(
  deps: CoreLoopDeps,
  items: Awaited<ReturnType<typeof assembleRunSummaryItems>>,
): Promise<AcceptanceVerdict> {
  const maxAttempts = deps.config.maxAcceptanceAttempts;

  if (!deps.acceptanceLlm && !deps.observeProduct) {
    return buildUnverifiedVerdict(
      "no-checker-configured",
      "neither an acceptance LLM nor a product observer is wired into the core loop",
      deps.acceptanceAttempts,
      maxAttempts,
    );
  }

  if (deps.acceptanceAttempts >= maxAttempts) {
    return buildAcceptanceVerdict([], deps.acceptanceAttempts, maxAttempts);
  }

  try {
    const vision = await deps.visionRepo.getLatest();
    if (!vision) {
      return buildUnverifiedVerdict(
        "no-vision",
        "no vision record exists, so there is nothing to check the product against",
        deps.acceptanceAttempts,
        maxAttempts,
      );
    }

    const allGaps = [];

    if (deps.observeProduct && vision.projectPath) {
      const observation = await deps.observeProduct(vision.projectPath);
      let contract: ProjectContract | null = null;
      if (deps.contractRepo) {
        const roots = (await deps.workItemRepo.listAll()).filter((i) => i.parentId === undefined);
        for (const root of roots) {
          contract = await deps.contractRepo.getLatest(parseProjectId(root.id));
          if (contract) break;
        }
      }
      allGaps.push(...buildDeterministicGaps(observation, contract));
    }

    if (deps.acceptanceLlm && vision.visionText) {
      const summaries = items.map((i) => ({ id: i.id, title: i.title, status: i.status }));
      const visionGapResult = await deps.acceptanceLlm.checkVisionGaps({
        visionText: vision.visionText,
        items: summaries,
      });
      allGaps.push(...buildVisionGaps(visionGapResult, vision.visionText));
    }

    deps.acceptanceAttempts += 1;
    return buildAcceptanceVerdict(allGaps, deps.acceptanceAttempts, maxAttempts);
  } catch (e) {
    console.error(
      `Acceptance check threw at attempt ${deps.acceptanceAttempts + 1}/${maxAttempts} — run will stop as unverified:`,
      e,
    );
    return buildUnverifiedVerdict("check-threw", e, deps.acceptanceAttempts, maxAttempts);
  }
}

async function createGapTasks(
  deps: CoreLoopDeps,
  gaps: readonly AcceptanceGap[],
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

    const taskSpec: Record<string, unknown> = {
      goal: gap.expected,
      endState: gap.expected,
      checks: [],
      deliverables: [],
      origin: "acceptance-gap",
    };
    if (gap.lesson) taskSpec.lesson = gap.lesson;
    if (gap.suggestedApproach) taskSpec.suggestedApproach = gap.suggestedApproach;
    if (gap.supersedes) taskSpec.supersedes = gap.supersedes;

    const item = createPendingWorkItem("Task", title, root.id, gap.observed, taskSpec);
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
