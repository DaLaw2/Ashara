import type { WorkItemRepository } from "./work-item.js";
import type { ContractRepository } from "./contract.js";

/**
 * Repos scoped to ONE shared database transaction (ADR-028 + ADR-029, mig-phase-9).
 * Both the WorkItemRepository and ContractRepository handed to `fn` wrap the SAME
 * transaction handle, so a bulk plan's item-creation loop and its ProjectContract
 * write commit or roll back together: a DB failure on either half undoes the
 * other, instead of leaving orphan work items with no matching contract entry or
 * vice versa.
 */
export interface PlanningTransactionRepos {
  readonly workItemRepo: WorkItemRepository;
  readonly contractRepo: ContractRepository;
}
