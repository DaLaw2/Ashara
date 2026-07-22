import type { EndpointCoverageGap, AcceptanceVerdict, TerminationPlanExhausted } from "@ashara/planning";
import { parseProjectId } from "@ashara/shared";
import type { ProjectContract } from "@ashara/shared";
import {
  assembleRunSummaryItems,
  evaluate,
  buildRunSummary,
  computeCoverageGaps,
  isBlockingCoverageGap,
  buildDeterministicGaps,
  buildVisionGaps,
  buildAcceptanceVerdict,
} from "@ashara/planning";

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

  if (acceptance && acceptance.outcome === "rejected") {
    const maxGapAttempts = deps.config.maxGapAttempts ?? 2;
    if (deps.acceptanceAttempts < maxGapAttempts) {
      return { decision: { decision: "continue", counts: decision.counts }, summary: null };
    }
  }

  const stopReason = acceptance?.outcome === "accepted"
    ? "accepted" as const
    : acceptance?.outcome === "accepted-with-caveats"
      ? "accepted-with-caveats" as const
      : "accepted" as const;

  const stopDecision = {
    decision: "stop" as const,
    reason: stopReason,
    counts: decision.counts,
    stalled: [...decision.stalled],
    abandonedRoots: [] as string[],
  };

  const summary = buildRunSummary(
    { items, endpointGaps, acceptance: acceptance ?? undefined },
    decision,
  );

  return { decision: stopDecision, summary };
}

async function runAcceptanceCheck(
  deps: CoreLoopDeps,
  items: Awaited<ReturnType<typeof assembleRunSummaryItems>>,
): Promise<AcceptanceVerdict | null> {
  if (!deps.acceptanceLlm && !deps.observeProduct) return null;

  const maxAttempts = deps.config.maxAcceptanceAttempts;
  if (deps.acceptanceAttempts >= maxAttempts) {
    return buildAcceptanceVerdict([], deps.acceptanceAttempts, maxAttempts);
  }

  try {
    const vision = await deps.visionRepo.getLatest();
    if (!vision) return null;

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
    console.warn("Acceptance check failed — skipping (fail-closed to completeness):", e);
    return null;
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
