import type { EventStoreRepository } from "@ashara/db";
import type { Logger } from "@ashara/shared";
import type { WorkItemRepository } from "../domain/index.js";
import type { DispatchRunDeps, DispatchSteps, LoopCore } from "../types.js";
import type { TargetPathSource } from "../orphan-merge.js";

/** What routing a dispatch's result reads and writes. */
export interface ExecutionRoutingDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly spendCap: LoopCore["spendCap"];
  /**
   * Blocks a project whose configuration refused a model call, or halts it on infrastructure;
   * `get` names the target whose main a faulted dispatch's merge is read from.
   */
  readonly projects: Pick<LoopCore["projectRepo"], "block"> & TargetPathSource;
  readonly checkDisputes: DispatchSteps["checkDisputes"];
  readonly suiteReviewFindings: DispatchSteps["suiteReviewFindings"];
  readonly environmentOwner: DispatchSteps["environmentOwner"];
  readonly clientQuestions: DispatchSteps["clientQuestions"];
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

export function routingDepsOf(deps: DispatchRunDeps): ExecutionRoutingDeps {
  return {
    workItemRepo: deps.loop.workItemRepo,
    eventStore: deps.loop.eventStore,
    spendCap: deps.loop.spendCap,
    projects: deps.loop.projectRepo,
    checkDisputes: deps.dispatch.checkDisputes,
    suiteReviewFindings: deps.dispatch.suiteReviewFindings,
    environmentOwner: deps.dispatch.environmentOwner,
    clientQuestions: deps.dispatch.clientQuestions,
    workdirBase: deps.loop.config.workdirBase,
    logger: deps.loop.logger,
  };
}
