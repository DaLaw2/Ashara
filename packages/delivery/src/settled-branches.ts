import type { Logger, ProjectId } from "@ashara/shared";
import type { WorkItemRepository } from "./domain/index.js";
import { SETTLED_WORK_ITEM_STATUSES } from "./work-item-language/work-item-status.js";
import { assertValidTargetProjectPath } from "./acl/execution-infra-acl.js";
import { releaseSettledBranches } from "./acl/quality-acl.js";

type Target = { readonly id: ProjectId; readonly workspacePath: string };

/** The projects with a target workspace recorded, whatever their status; ProjectRepository satisfies it. */
export interface SettledTargets {
  listWithWorkspace(): Promise<readonly Target[]>;
}

interface SettledBranchDeps {
  readonly workItemRepo: Pick<WorkItemRepository, "listIdsByStatus">;
  readonly projects: SettledTargets;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

interface SettledBranchSummary {
  readonly released: number;
  /** Branches of settled tasks, and throwaway checkouts, still in a target. */
  readonly left: number;
  /** Throwaway checkouts a crash or a faulted cleanup left, removed. */
  readonly checkouts: number;
  /** Targets whose branches could not be listed, or whose stored path was refused. */
  readonly targetsFailed: number;
}

/**
 * Releases the branches (and worktree slots) of every settled task in every target, and every
 * throwaway checkout a target still has registered, run at startup and each cycle while no attempt
 * is in flight: a checkout outlives its check only when a crash or a faulted cleanup cut it short.
 * Release follows the settled status itself, not the path that reached it: every path that gives a
 * task up or completes it is covered, a new one included, and a release a settle path tried and
 * failed is retried here. A settled task's branch is one nothing reads: no attempt runs for it, and
 * the next one, if any, starts fresh. Abandoned is terminal. A Completed task's work is on main (its
 * branch merged, or discarded as already delivered there), and the one edge out of Completed reopens
 * a check task, whose attempt drops its throwaway branch before it starts. A leftover is logged at
 * warn, never a verdict; a store that cannot be read releases nothing this pass, and the next retries.
 */
export async function releaseBranchesOfSettledTasks(deps: SettledBranchDeps): Promise<SettledBranchSummary> {
  let settled: ReadonlySet<string>;
  let targets: readonly Target[];
  try {
    settled = new Set(await deps.workItemRepo.listIdsByStatus(SETTLED_WORK_ITEM_STATUSES));
    targets = await deps.projects.listWithWorkspace();
  } catch (err) {
    deps.logger.warn("delivery.settled-branches-unread", "the settled tasks or the targets could not be read; no branch is released this pass", {}, err);
    return { released: 0, left: 0, checkouts: 0, targetsFailed: 0 };
  }
  let released = 0;
  let left = 0;
  let checkouts = 0;
  let targetsFailed = 0;
  for (const target of targets) {
    try {
      await assertValidTargetProjectPath(target.workspacePath, deps.workdirBase);
      const result = await releaseSettledBranches(deps.workdirBase, target.workspacePath, settled, deps.logger);
      released += result.released;
      left += result.left;
      checkouts += result.checkouts;
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: branch release is cleanup of settled tasks: the target is counted in targetsFailed and the next pass retries it
      targetsFailed += 1;
      deps.logger.warn(
        "delivery.settled-branches-unlisted",
        `the branches of ${target.workspacePath} could not be listed; none is released this pass`,
        { projectId: target.id, targetPath: target.workspacePath },
        err,
      );
    }
  }
  if (released > 0 || left > 0 || checkouts > 0 || targetsFailed > 0) {
    deps.logger.info(
      "delivery.settled-branches-released",
      `released ${released} branch(es) of settled tasks and ${checkouts} throwaway checkout(s) a cut-short check left; ` +
        `${left} left, ${targetsFailed} target(s) not read`,
      { released, checkouts, left, targetsFailed },
    );
  }
  return { released, left, checkouts, targetsFailed };
}
