import type { Database } from "../connection.js";
import { WorkItemRepository } from "./work-item.js";
import { ContractRepository } from "./contract.js";

/**
 * Repos scoped to ONE shared database transaction (ADR-028 + ADR-029, mig-phase-9).
 * Both the WorkItemRepository and ContractRepository handed to `fn` wrap the SAME
 * transaction handle, so a decomposition's item-creation loop and its derived
 * ProjectContract write commit or roll back together: a ContractConflict (or any
 * DB failure) on either half undoes the other, instead of leaving orphan work
 * items with no matching contract entry or vice versa.
 */
export interface PlanningTransactionRepos {
  readonly workItemRepo: WorkItemRepository;
  readonly contractRepo: ContractRepository;
}

export async function withPlanningTransaction<T>(
  db: Database,
  fn: (repos: PlanningTransactionRepos) => Promise<T>,
): Promise<T> {
  return db.transaction((tx) => fn({ workItemRepo: new WorkItemRepository(tx), contractRepo: new ContractRepository(tx) }));
}
