import type { EndpointCoverageGap } from "@ashara/planning";
import { parseProjectId } from "@ashara/shared";
import {
  assembleRunSummaryItems,
  evaluate,
  buildRunSummary,
  computeCoverageGaps,
  isBlockingCoverageGap,
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
  const summary = decision.decision === "stop" ? buildRunSummary({ items, endpointGaps }, decision) : null;
  return { decision, summary };
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
