import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { DomainEvent } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository, FailureRouter, RawFailureContext, FailureRecoveryDeps } from "./acl/planning-acl.js";
import { requeueWorkItem, takeEvents, recoverFailedItem } from "./acl/planning-acl.js";

const execFileAsync = promisify(execFile);

export interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  readonly workdirBase?: string;
  readonly targetProjectPath?: string;
}

export interface ReconcileSummary {
  readonly orphansRequeued: number;
  readonly orphansErrored: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  readonly failedSubstituted: number;
  readonly failedErrored: number;
  readonly worktreesCleaned: number;
}

export async function reconcileOnStartup(deps: StartupReconcilerDeps): Promise<ReconcileSummary> {
  let orphansRequeued = 0;
  let orphansErrored = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
  let failedSubstituted = 0;
  let failedErrored = 0;

  const orphans = await deps.workItemRepo.findByStatus("InProgress");
  for (const orphan of orphans) {
    try {
      await requeueOrphan(deps, orphan);
      orphansRequeued += 1;
    } catch (error) {
      orphansErrored += 1;
      console.warn(
        `[startup-reconciler] failed to requeue crash-orphaned InProgress item ${orphan.id}; left InProgress for the next reconcile:`,
        error,
      );
    }
  }

  const recoveryDeps: FailureRecoveryDeps = {
    workItemRepo: deps.workItemRepo,
    eventPublisher: deps.eventStore,
    failureRouter: deps.failureRouter,
  };

  const parkedFailed = await deps.workItemRepo.findByStatus("Failed");
  for (const failed of parkedFailed) {
    try {
      const action = await recoverFailedItem(recoveryDeps, failed, reconstructFailure(failed));
      if (action === "replan") failedReplanned += 1;
      else if (action === "substitute") failedSubstituted += 1;
      else failedAbandoned += 1;
    } catch (error) {
      failedErrored += 1;
      console.warn(
        `[startup-reconciler] failed to route parked Failed item ${failed.id}; left Failed for the next reconcile:`,
        error,
      );
    }
  }

  let worktreesCleaned = 0;
  if (deps.targetProjectPath) {
    worktreesCleaned = await cleanOrphanedGitWorktrees(deps.targetProjectPath, deps.workItemRepo);
  } else if (deps.workdirBase) {
    worktreesCleaned = await cleanOrphanedWorktrees(deps.workdirBase, deps.workItemRepo);
  }

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansErrored,
    failedReplanned,
    failedAbandoned,
    failedSubstituted,
    failedErrored,
    worktreesCleaned,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} errored=${orphansErrored}; ` +
      `parked Failed routed=${parkedFailed.length} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `substitute=${failedSubstituted} errored=${failedErrored}); worktrees cleaned=${worktreesCleaned}`,
  );
  return summary;
}

async function requeueOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<void> {
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  await deps.workItemRepo.save(orphan, previousStatus);
  await publishBestEffort(deps.eventStore, takeEvents(orphan), orphan.id);
}

function reconstructFailure(item: WorkItem): RawFailureContext {
  const raw = item.blockedReason ?? {};
  const reason = raw["reason"];
  const detail =
    typeof reason === "string" ? reason : "parked Failed item recovered by startup reconciler";
  return { detail, raw };
}

async function publishBestEffort(
  eventStore: Pick<EventStoreRepository, "publish">,
  events: DomainEvent[],
  itemId: string,
): Promise<void> {
  for (const event of events) {
    try {
      await eventStore.publish(event, "Internal");
    } catch (error) {
      console.warn(
        `[startup-reconciler] failed to publish audit event for ${itemId} (transition already committed):`,
        error,
      );
    }
  }
}

async function cleanOrphanedWorktrees(
  workdirBase: string,
  workItemRepo: WorkItemRepository,
): Promise<number> {
  let cleaned = 0;
  try {
    const entries = await fs.readdir(workdirBase, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0) return 0;

    const [pending, inProgress, blocked] = await Promise.all([
      workItemRepo.findByStatus("Pending"),
      workItemRepo.findByStatus("InProgress"),
      workItemRepo.findByStatus("Blocked"),
    ]);
    const activeIds = new Set<string>(
      [...pending, ...inProgress, ...blocked].map((item) => String(item.id)),
    );

    for (const dir of dirs) {
      if (activeIds.has(dir)) continue;
      try {
        await fs.rm(path.join(workdirBase, dir), { recursive: true, force: true });
        cleaned += 1;
      } catch (err) {
        console.warn(
          `[startup-reconciler] failed to remove orphaned worktree ${dir}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn("[startup-reconciler] worktree cleanup skipped:", err);
  }
  return cleaned;
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== null) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    }
  }
  if (currentPath !== null) {
    entries.push({ path: currentPath, branch: currentBranch });
  }
  return entries;
}

async function cleanOrphanedGitWorktrees(
  targetProjectPath: string,
  workItemRepo: WorkItemRepository,
): Promise<number> {
  let cleaned = 0;
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: targetProjectPath,
    });
    const worktrees = parseWorktreeList(stdout);

    const [pending, inProgress, blocked] = await Promise.all([
      workItemRepo.findByStatus("Pending"),
      workItemRepo.findByStatus("InProgress"),
      workItemRepo.findByStatus("Blocked"),
    ]);
    const activeIds = new Set<string>(
      [...pending, ...inProgress, ...blocked].map((item) => String(item.id)),
    );

    for (const wt of worktrees) {
      if (!wt.branch?.startsWith("task/")) continue;
      const taskId = wt.branch.slice("task/".length);
      if (activeIds.has(taskId)) continue;

      try {
        await execFileAsync("git", ["worktree", "remove", wt.path, "--force"], {
          cwd: targetProjectPath,
        });
        await execFileAsync("git", ["branch", "-D", wt.branch], {
          cwd: targetProjectPath,
        }).catch(() => {});
        cleaned += 1;
      } catch (err) {
        console.warn(
          `[startup-reconciler] failed to remove orphaned git worktree ${wt.path}:`,
          err,
        );
      }
    }

    await execFileAsync("git", ["worktree", "prune"], { cwd: targetProjectPath }).catch(() => {});
  } catch (err) {
    console.warn("[startup-reconciler] git worktree cleanup skipped:", err);
  }
  return cleaned;
}
