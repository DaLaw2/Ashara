import type { EventStoreRepository } from "@ashara/db";
import type { Logger } from "@ashara/shared";
import type { WorkItemRepository } from "../domain/index.js";
import type { CoreLoopDeps } from "../types.js";
import type { TargetPathSource } from "../orphan-merge.js";

/** What routing a dispatch's result reads and writes. */
export interface ExecutionRoutingDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly spendCap: CoreLoopDeps["spendCap"];
  /**
   * Blocks a project whose configuration refused a model call, or halts it on infrastructure;
   * `get` names the target whose main a faulted dispatch's merge is read from.
   */
  readonly projects: Pick<CoreLoopDeps["projectRepo"], "block"> & TargetPathSource;
  readonly checkDisputes: CoreLoopDeps["checkDisputes"];
  readonly suiteReviewFindings: CoreLoopDeps["suiteReviewFindings"];
  readonly environmentOwner: CoreLoopDeps["environmentOwner"];
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

export function routingDepsOf(deps: CoreLoopDeps): ExecutionRoutingDeps {
  return {
    workItemRepo: deps.workItemRepo,
    eventStore: deps.eventStore,
    spendCap: deps.spendCap,
    projects: deps.projectRepo,
    checkDisputes: deps.checkDisputes,
    suiteReviewFindings: deps.suiteReviewFindings,
    environmentOwner: deps.environmentOwner,
    workdirBase: deps.config.workdirBase,
    logger: deps.logger,
  };
}
