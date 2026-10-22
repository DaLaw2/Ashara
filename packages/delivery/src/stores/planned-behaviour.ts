import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { recordPlannedBehaviour } from "../acl/engagement-acl.js";
import type { PlannedAssumption } from "../decomposition-types.js";

/**
 * Records the behaviour a plan adds beyond what the contract states on the contract, through
 * Engagement, inside the plan's own transaction: no task citing one is written without it. A plan
 * that adds none records nothing.
 */
export async function recordPlannedAssumptions(
  tx: DbHandle,
  projectId: ProjectId,
  planRevision: number,
  assumptions: readonly PlannedAssumption[],
): Promise<void> {
  const [first, ...rest] = assumptions;
  if (first === undefined) return;
  await recordPlannedBehaviour(tx, { projectId, planRevision, planned: [first, ...rest] });
}
