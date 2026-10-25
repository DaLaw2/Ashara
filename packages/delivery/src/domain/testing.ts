/**
 * The board's test support, reached as `@ashara/delivery/board-testing` and re-exported by
 * `@ashara/delivery/testing`: only a test file, the test harness or another test-only entry may
 * import it (test-only-subpaths in boundary-rules.toml), so no production path is built on an inert
 * repository. It sits with the board so a test of any module may stand its work items in with it.
 */

import { notExercised } from "@ashara/shared/testing";
import type { LockedChargeLedger, WorkItemRepository } from "./repository.js";

/**
 * A work-item repository whose every member throws NotExercised, but those `overrides` supply: the
 * unit tests' stand-in for production's adaptWorkItemRepo, and the inert loop's.
 */
export function inertWorkItemRepo(overrides: Partial<WorkItemRepository> = {}): WorkItemRepository {
  return {
    create: notExercised("workItemRepo.create"),
    findById: notExercised("workItemRepo.findById"),
    listByProject: notExercised("workItemRepo.listByProject"),
    findByProjectAndStatus: notExercised("workItemRepo.findByProjectAndStatus"),
    projectIdsWithStatus: notExercised("workItemRepo.projectIdsWithStatus"),
    listIdsByStatus: notExercised("workItemRepo.listIdsByStatus"),
    save: notExercised("workItemRepo.save"),
    incrementDispatchCount: notExercised("workItemRepo.incrementDispatchCount"),
    saveRefundedOverflow: notExercised("workItemRepo.saveRefundedOverflow"),
    recordCrashOrphan: notExercised("workItemRepo.recordCrashOrphan"),
    saveOrphanExit: notExercised("workItemRepo.saveOrphanExit"),
    saveRefunded: notExercised("workItemRepo.saveRefunded"),
    recordMergeCommit: notExercised("workItemRepo.recordMergeCommit"),
    addDependency: notExercised("workItemRepo.addDependency"),
    getDependencies: notExercised("workItemRepo.getDependencies"),
    findChildren: notExercised("workItemRepo.findChildren"),
    listDependenciesByProject: notExercised("workItemRepo.listDependenciesByProject"),
    listCorrectionHeld: notExercised("workItemRepo.listCorrectionHeld"),
    withTransaction: notExercised("workItemRepo.withTransaction"),
    withItemLocked: notExercised("workItemRepo.withItemLocked"),
    ...overrides,
  };
}

/**
 * withItemLocked over a unit test's own stand-ins: the item read by `findById`, the charge written
 * through `ledger`. No lock is held; the interleaving the lock serializes is tested over a database.
 * @testseam the unit tests of a charge stand its locked transaction in with it; production's is adaptWorkItemRepo's
 */
export function itemLockOver(findById: WorkItemRepository["findById"], ledger: LockedChargeLedger): WorkItemRepository["withItemLocked"] {
  return async (item, fn) => fn(await findById(item.id), ledger);
}
