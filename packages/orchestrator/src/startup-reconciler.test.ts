import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProjectBlockCause } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { FailureRouter, WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import type { StartupReconcilerDeps } from "./startup-reconciler.js";
import { reconcileOnStartup } from "./startup-reconciler.js";

interface FailStaleCall {
  readonly reason: unknown;
}

/** No work items to reconcile — these tests are about the session pass only. */
function emptyWorkItemRepo(): WorkItemRepository {
  const unused = (method: string) => (): never => {
    throw new Error(`WorkItemRepository.${method} is not exercised by this test`);
  };
  return {
    create: unused("create"),
    findById: unused("findById"),
    listByProject: unused("listByProject"),
    findByProjectAndStatus: unused("findByProjectAndStatus"),
    projectIdsWithStatus: async () => [],
    listIdsByStatus: async () => [],
    save: unused("save"),
    incrementDispatchCount: unused("incrementDispatchCount"),
    recordInfrastructureFault: unused("recordInfrastructureFault"),
    refundDispatchCount: unused("refundDispatchCount"),
    recordMergeCommit: unused("recordMergeCommit"),
    addDependency: unused("addDependency"),
    getDependencies: unused("getDependencies"),
    findChildren: unused("findChildren"),
    listDependenciesByProject: unused("listDependenciesByProject"),
    withTransaction: unused("withTransaction"),
  };
}

async function unusedBlock(): Promise<never> {
  throw new Error("ProjectRepository.block is not exercised by this test");
}

function buildDeps(overrides: Partial<StartupReconcilerDeps> = {}): {
  deps: StartupReconcilerDeps;
  failStaleCalls: FailStaleCall[];
} {
  const failStaleCalls: FailStaleCall[] = [];

  const deps: StartupReconcilerDeps = {
    workItemRepo: emptyWorkItemRepo(),
    projects: { block: unusedBlock, get: async () => ({ workspacePath: null }) },
    eventStore: { publish: async () => undefined },
    // Provably never invoked: projectIdsWithStatus("Failed") returns [], so no item is
    // routed. FailureRouter has private members, so a structural double cannot
    // satisfy it; the throwing stub is what makes the "never invoked" claim
    // testable rather than assumed.
    failureRouter: {
      route: () => {
        throw new Error("FailureRouter.route is not exercised by this test");
      },
    } as unknown as FailureRouter,
    devSessionStore: {
      failStale: async (reason: unknown) => {
        failStaleCalls.push({ reason });
        return 6;
      },
      dispatchEvidence: async () => {
        throw new Error("dispatchEvidence is not exercised: no item is InProgress");
      },
    },
    // Required: an empty repo returns no dirs, so the sweep is a no-op.
    workdirBase: "/nonexistent-test-workdir",
    ...overrides,
  };

  return { deps, failStaleCalls };
}

// E2E Run 39 left 6 dev_sessions rows in "Preparing" for two abandoned tasks.
// Nothing in the process that created them survived to close them, so the only
// place the invariant can be restored is the next process start.
describe("reconcileOnStartup — dev_session crash orphans", () => {
  test("terminalizes every non-terminal session and reports the count", async () => {
    const { deps, failStaleCalls } = buildDeps();

    const summary = await reconcileOnStartup(deps);

    expect(failStaleCalls).toHaveLength(1);
    expect(summary.sessionsTerminalized).toBe(6);
  });

  test("the recorded reason says why the session was closed, not just that it was", async () => {
    const { deps, failStaleCalls } = buildDeps();

    await reconcileOnStartup(deps);

    expect(failStaleCalls[0]?.reason).toMatchObject({
      outcome: "abandoned",
      resolvedBy: "startup-reconciler",
    });
  });

  // Fail-soft on its own error: the rows are already stranded, so retrying next
  // start beats refusing to boot.
  test("a store failure does not block startup reconciliation", async () => {
    const { deps } = buildDeps({
      devSessionStore: {
        failStale: async () => {
          throw new Error("db unreachable");
        },
        dispatchEvidence: async () => {
          throw new Error("dispatchEvidence is not exercised: no item is InProgress");
        },
      },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.sessionsTerminalized).toBe(0);
  });
});

// The review of t-shutdown-cancel-not-failure: a hard kill left the dispatch counted, so a task
// the operator's kill stopped was one attempt nearer its abandon bound.
describe("reconcileOnStartup — the dispatch a dead process counted", () => {
  const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-0000000000aa", "test");

  function orphanDeps(evidence: { readonly latestPhase: string | null; readonly orphanedBefore: number }) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date();
    let row: WorkItem = {
      id: createWorkItemId(),
      level: "Task",
      status: "InProgress",
      title: "orphan",
      projectId: PROJECT_ID,
      dispatchCount: 2,
      workKind: "implementation",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const evidenceAsked: string[] = [];
    const repo: WorkItemRepository = {
      ...emptyWorkItemRepo(),
      projectIdsWithStatus: async (status) => (status === "InProgress" && row.status === "InProgress" ? [PROJECT_ID] : []),
      findByProjectAndStatus: async () => [{ ...row, events: [] }],
      save: async (item) => {
        row = { ...item, dispatchCount: row.dispatchCount, events: [] };
      },
      recordInfrastructureFault: async () => { throw new Error("recordInfrastructureFault: not exercised"); },
      refundDispatchCount: async () => {
        row = { ...row, dispatchCount: row.dispatchCount - 1 };
        return row.dispatchCount;
      },
    };
    const { deps } = buildDeps({
      workItemRepo: repo,
      devSessionStore: {
        failStale: async () => 1,
        dispatchEvidence: async (_taskId, resolvedBy) => {
          evidenceAsked.push(resolvedBy);
          return evidence;
        },
      },
    });
    return { deps, row: () => row, evidenceAsked };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("its latest session never got a terminal write: requeued and the dispatch given back", async () => {
    const { deps, row, evidenceAsked } = orphanDeps({ latestPhase: "Preparing", orphanedBefore: 0 });

    const summary = await reconcileOnStartup(deps);

    expect(summary.orphansRequeued).toBe(1);
    expect(row()).toMatchObject({ status: "Pending", dispatchCount: 1 });
    // Counted by the very name failStale records, read before failStale closes this start's orphans.
    expect(evidenceAsked).toEqual(["startup-reconciler"]);
  });

  test.each([
    ["its latest session is terminal: the dispatch finished, only its routing was lost", { latestPhase: "Failed", orphanedBefore: 0 }],
    ["it has no session: nothing shows the dispatch did not finish", { latestPhase: null, orphanedBefore: 0 }],
    ["an earlier dispatch of it was orphaned already: past the bound", { latestPhase: "Preparing", orphanedBefore: 1 }],
  ])("%s: requeued, the dispatch stays counted", async (_label, evidence) => {
    const { deps, row } = orphanDeps(evidence);

    await reconcileOnStartup(deps);

    expect(row()).toMatchObject({ status: "Pending", dispatchCount: 2 });
  });
});

/** A target repository whose main holds a commit with each subject, newest last, as commitMerge writes one. */
function targetWithMain(subjects: readonly string[]): { readonly path: string; readonly head: string } {
  const path = mkdtempSync(join(tmpdir(), "ashara-orphan-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: path, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  for (const subject of subjects) git("commit", "-q", "--allow-empty", "-m", subject);
  return { path, head: git("rev-parse", "HEAD") };
}

// The 400-seed deep soak (2026-10-15): B5, a merge committed on main and a crash before the task's
// Completed update, requeued and redone; B3, a requeue that failed once left the orphan InProgress.
describe("reconcileOnStartup — a crash orphan is settled from main, within a bound, never left InProgress", () => {
  const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-0000000000bb", "test");
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function target(subjects: readonly string[]): { readonly path: string; readonly head: string } {
    const made = targetWithMain(subjects);
    dirs.push(made.path);
    return made;
  }

  function orphanWorld(
    id: WorkItem["id"],
    workspacePath: string | null,
    saveFails: (status: WorkItem["status"]) => boolean = () => false,
  ) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date();
    let row: WorkItem = {
      id,
      level: "Task",
      status: "InProgress",
      title: "orphan",
      projectId: PROJECT_ID,
      dispatchCount: 1,
      workKind: "implementation",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const records: Array<{ readonly commit: string; readonly kind: unknown }> = [];
    const projectBlocks: ProjectBlockCause[] = [];
    const repo: WorkItemRepository = {
      ...emptyWorkItemRepo(),
      projectIdsWithStatus: async (status) => (status === "InProgress" && row.status === "InProgress" ? [PROJECT_ID] : []),
      findByProjectAndStatus: async () => [{ ...row, events: [] }],
      findById: async () => ({ ...row, events: [] }),
      save: async (item) => {
        if (saveFails(item.status)) throw new Error(`connection lost saving ${item.status}`);
        row = { ...item, events: [] };
      },
      recordMergeCommit: async (_id, commit, kind) => void records.push({ commit, kind }),
    };
    const { deps } = buildDeps({
      workItemRepo: repo,
      projects: {
        block: async (_id, cause) => {
          projectBlocks.push(cause);
          return "blocked";
        },
        get: async () => ({ workspacePath }),
      },
      devSessionStore: { failStale: async () => 0, dispatchEvidence: async () => ({ latestPhase: null, orphanedBefore: 0 }) },
    });
    return { deps, row: () => row, records, projectBlocks };
  }

  test("its merge is on main: the merge is recorded and the task Completed, never requeued", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${createWorkItemId()}`, `merge: task ${id}`, "later work"]);
    const world = orphanWorld(id, main.path);

    const summary = await reconcileOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansCompleted: 1, orphansBlocked: 0 });
    const merged = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: main.path, encoding: "utf8" }).trim();
    expect(world.records).toEqual([{ commit: merged, kind: "merged" }]);
    expect(world.row().status).toBe("Completed");
  });

  test("main holds no merge of it: requeued", async () => {
    const id = createWorkItemId();
    const world = orphanWorld(id, target([`merge: task ${createWorkItemId()}`]).path);

    const summary = await reconcileOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 1, orphansCompleted: 0 });
    expect(world.records).toEqual([]);
    expect(world.row().status).toBe("Pending");
  });

  test("main cannot be read: Blocked as Ashara's own fault and the project blocked, never requeued blind", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ashara-orphan-"));
    dirs.push(notARepo);
    const world = orphanWorld(createWorkItemId(), notARepo);

    const summary = await reconcileOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansBlocked: 1 });
    expect(world.row()).toMatchObject({
      status: "Blocked",
      blockedReason: { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge" },
    });
    expect(world.projectBlocks).toEqual([expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled" })]);
  });

  test("a requeue that fails once is retried, and the task requeued", async () => {
    let failed = 0;
    const world = orphanWorld(createWorkItemId(), null, (status) => status === "Pending" && failed++ === 0);

    const summary = await reconcileOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 1, orphansBlocked: 0 });
    expect(world.row().status).toBe("Pending");
  });

  test("a requeue that keeps failing: Blocked with its step and the project blocked, never left InProgress", async () => {
    const world = orphanWorld(createWorkItemId(), null, (status) => status === "Pending");

    const summary = await reconcileOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansBlocked: 1 });
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", step: "requeue the task" } });
    expect(world.projectBlocks).toHaveLength(1);
  });

  test("its merge found but its record never written: Blocked merge_unrecorded, which the loop writes again", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${id}`]);
    const world = orphanWorld(id, main.path);
    const failing: StartupReconcilerDeps = {
      ...world.deps,
      workItemRepo: {
        ...world.deps.workItemRepo,
        recordMergeCommit: async () => {
          throw new Error("connection lost");
        },
      },
    };

    const summary = await reconcileOnStartup(failing);

    expect(summary).toMatchObject({ orphansBlocked: 1 });
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "merge_unrecorded", mergeCommit: main.head, mergeKind: "merged" } });
    expect(world.projectBlocks).toEqual([]);
  });

  test("no write reaches the store at all: the start is refused, the orphan is never left behind silently", async () => {
    const world = orphanWorld(createWorkItemId(), null, () => true);

    await expect(reconcileOnStartup(world.deps)).rejects.toMatchObject({ name: "OrphanUnreconciled" });
  });
});
