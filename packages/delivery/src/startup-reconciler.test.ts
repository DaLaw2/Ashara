import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "./project-halt.js";
import { FailureRouter } from "./failure-router.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { reconcileWorkItemsOnStartup } from "./startup-reconciler.js";

type StartupReconcilerDeps = Parameters<typeof reconcileWorkItemsOnStartup>[0];

/** A repository with no work items; each test overrides what it exercises. */
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
    recordCrashOrphan: async () => 1,
    clearCrashOrphans: async () => {},
    saveRefunded: unused("saveRefunded"),
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

function buildDeps(overrides: Partial<StartupReconcilerDeps> = {}): { deps: StartupReconcilerDeps } {
  const deps: StartupReconcilerDeps = {
    workItemRepo: emptyWorkItemRepo(),
    projects: { block: unusedBlock, get: async () => ({ workspacePath: null }), listWithWorkspace: async () => [] },
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
      dispatchEvidence: async () => {
        throw new Error("dispatchEvidence is not exercised: no item is InProgress");
      },
    },
    // Every target here is made under the temporary directory.
    workdirBase: tmpdir(),
    ...overrides,
  };

  return { deps };
}

// The review of t-shutdown-cancel-not-failure: a hard kill left the dispatch counted, so a task
// the operator's kill stopped was one attempt nearer its abandon bound.
describe("reconcileWorkItemsOnStartup — the dispatch a dead process counted", () => {
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
      failureVerdict: { kind: "none" },
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
      recordCrashOrphan: async () => 1,
      clearCrashOrphans: async () => {},
      saveRefunded: async (item) => {
        row = { ...item, dispatchCount: row.dispatchCount - 1, events: [] };
        return row.dispatchCount;
      },
    };
    const { deps } = buildDeps({
      workItemRepo: repo,
      devSessionStore: {
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

    const summary = await reconcileWorkItemsOnStartup(deps);

    expect(summary.orphansRequeued).toBe(1);
    expect(row()).toMatchObject({ status: "Pending", dispatchCount: 1 });
    // Counted by the very name Workplace's session reconcile records, read before it closes this start's sessions.
    expect(evidenceAsked).toEqual(["startup-reconciler"]);
  });

  test.each([
    ["its latest session is terminal: the dispatch finished, only its routing was lost", { latestPhase: "Failed", orphanedBefore: 0 }],
    ["it has no session: nothing shows the dispatch did not finish", { latestPhase: null, orphanedBefore: 0 }],
    ["an earlier dispatch of it was orphaned already: past the bound", { latestPhase: "Preparing", orphanedBefore: 1 }],
  ])("%s: requeued, the dispatch stays counted", async (_label, evidence) => {
    const { deps, row } = orphanDeps(evidence);

    await reconcileWorkItemsOnStartup(deps);

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

/**
 * What a dead process's dispatch leaves: the task's branch, holding a commit main never took,
 * checked out in its worktree slot under the workdir base. The returned read gives both back.
 */
function heldCheckout(target: string, taskId: string): () => { readonly branch: string; readonly worktree: boolean } {
  const workDir = join(tmpdir(), `task-${taskId}`);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git(target, "worktree", "add", "-q", workDir, "-b", `task/${taskId}`, "main");
  git(workDir, "commit", "-q", "--allow-empty", "-m", "the agent's work");
  return () => ({ branch: git(target, "branch", "--list", "--format=%(refname:short)", `task/${taskId}`), worktree: existsSync(workDir) });
}

// A merge committed on main and a crash before the task's Completed update must not requeue the
// merged work, and a requeue that fails once must not leave the orphan InProgress.
describe("reconcileWorkItemsOnStartup — a crash orphan is settled from main, within a bound, never left InProgress", () => {
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
      failureVerdict: { kind: "none" },
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
        listWithWorkspace: async () => [],
      },
      devSessionStore: { dispatchEvidence: async () => ({ latestPhase: null, orphanedBefore: 0 }) },
    });
    return { deps, row: () => row, records, projectBlocks };
  }

  test("its merge is on main: the merge is recorded and the task Completed, never requeued; the dead process's worktree and branch are gone", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${createWorkItemId()}`, `merge: task ${id}`, "later work"]);
    const left = heldCheckout(main.path, id);
    dirs.push(join(tmpdir(), `task-${id}`));
    const world = orphanWorld(id, main.path);

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansCompleted: 1, orphansBlocked: 0 });
    const merged = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: main.path, encoding: "utf8" }).trim();
    expect(world.records).toEqual([{ commit: merged, kind: "merged" }]);
    expect(world.row().status).toBe("Completed");
    expect(left()).toEqual({ branch: "", worktree: false });
  });

  test("its merge recorded but its completion never written: Blocked merge_unrecorded, its worktree and branch already released", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${id}`]);
    const left = heldCheckout(main.path, id);
    dirs.push(join(tmpdir(), `task-${id}`));
    const world = orphanWorld(id, main.path, (status) => status === "Completed");

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansBlocked: 1 });
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "merge_unrecorded", mergeCommit: main.head } });
    expect(left()).toEqual({ branch: "", worktree: false });
  });

  test("main holds no merge of it: requeued", async () => {
    const id = createWorkItemId();
    const world = orphanWorld(id, target([`merge: task ${createWorkItemId()}`]).path);

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 1, orphansCompleted: 0 });
    expect(world.records).toEqual([]);
    expect(world.row().status).toBe("Pending");
  });

  test("its target's repository does not exist yet: it holds no merge, so the orphan is requeued", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ashara-orphan-"));
    dirs.push(parent);
    const world = orphanWorld(createWorkItemId(), join(parent, "never-created"));

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 1, orphansBlocked: 0 });
    expect(world.projectBlocks).toEqual([]);
    expect(world.row().status).toBe("Pending");
  });

  test("main cannot be read: Blocked as Ashara's own fault and the project blocked, never requeued blind", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-orphan-"));
    dirs.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const world = orphanWorld(createWorkItemId(), unreadable);

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansBlocked: 1 });
    expect(world.row()).toMatchObject({
      status: "Blocked",
      blockedReason: { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge" },
    });
    expect(world.projectBlocks).toEqual([expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled" })]);
  });

  test("a stored target outside the workdir base: git never reads it, and the orphan is Blocked, never requeued", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${id}`]);
    const world = orphanWorld(id, main.path);
    const elsewhere = mkdtempSync(join(tmpdir(), "ashara-orphan-base-"));
    dirs.push(elsewhere);

    const summary = await reconcileWorkItemsOnStartup({ ...world.deps, workdirBase: elsewhere });

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansCompleted: 0, orphansBlocked: 1 });
    expect(world.records).toEqual([]);
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled" } });
  });

  test("a requeue that fails once is retried, and the task requeued", async () => {
    let failed = 0;
    const world = orphanWorld(createWorkItemId(), null, (status) => status === "Pending" && failed++ === 0);

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 1, orphansBlocked: 0 });
    expect(world.row().status).toBe("Pending");
  });

  test("a requeue that keeps failing: Blocked with its step and the project blocked, never left InProgress", async () => {
    const world = orphanWorld(createWorkItemId(), null, (status) => status === "Pending");

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ orphansRequeued: 0, orphansBlocked: 1 });
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", step: "requeue the task" } });
    expect(world.projectBlocks).toHaveLength(1);
  });

  test("its merge found but its record never written: Blocked merge_unrecorded, which the loop writes again", async () => {
    const id = createWorkItemId();
    const main = target([`merge: task ${id}`]);
    const left = heldCheckout(main.path, id);
    dirs.push(join(tmpdir(), `task-${id}`));
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

    const summary = await reconcileWorkItemsOnStartup(failing);

    expect(summary).toMatchObject({ orphansBlocked: 1 });
    expect(world.row()).toMatchObject({ status: "Blocked", blockedReason: { source: "merge_unrecorded", mergeCommit: main.head, mergeKind: "merged" } });
    expect(world.projectBlocks).toEqual([]);
    // Released only once the record holds (parked-exits writes it, then releases).
    expect(left()).toMatchObject({ branch: `task/${id}`, worktree: true });
  });

  test("no write reaches the store at all: the start is refused, the orphan is never left behind silently", async () => {
    const world = orphanWorld(createWorkItemId(), null, () => true);

    await expect(reconcileWorkItemsOnStartup(world.deps)).rejects.toMatchObject({ name: "OrphanUnreconciled" });
  });
});

// G4 across a restart (c-loop-never-stop criterion 3; ADR-080 d5): a parked Failed item is routed by
// the verdict saved with its Failed transition.
describe("reconcileWorkItemsOnStartup — a parked Failed item is routed by its stored verdict", () => {
  const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-0000000000cc", "test");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function parkedWorld(failureVerdict: WorkItem["failureVerdict"]) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date();
    let row: WorkItem = {
      id: createWorkItemId(),
      level: "Task",
      status: "Failed",
      title: "parked",
      projectId: PROJECT_ID,
      blockedReason: { source: "task_failed", reason: "task_failed" },
      failureVerdict,
      dispatchCount: 1,
      workKind: "implementation",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const projectBlocks: ProjectBlockCause[] = [];
    const repo: WorkItemRepository = {
      ...emptyWorkItemRepo(),
      projectIdsWithStatus: async (status) => (status === row.status ? [PROJECT_ID] : []),
      findByProjectAndStatus: async () => [{ ...row, events: [] }],
      findById: async () => ({ ...row, events: [] }),
      save: async (item, expected) => {
        if (row.status !== expected) throw new Error(`save expected ${expected}, the row is ${row.status}`);
        row = { ...item, events: [] };
      },
    };
    const { deps } = buildDeps({
      workItemRepo: repo,
      failureRouter: new FailureRouter(2),
      projects: {
        block: async (_id, cause) => {
          projectBlocks.push(cause);
          return "blocked";
        },
        get: async () => ({ workspacePath: null }),
        listWithWorkspace: async () => [],
      },
    });
    return { deps, row: () => row, projectBlocks };
  }

  test("a non-retryable verdict: given up, no retry spent, never replanned", async () => {
    const world = parkedWorld({ kind: "recorded", verdict: { kind: "non-retryable", ground: "conflict-markers-left" } });

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ failedReplanned: 0, failedAbandoned: 1, failedHeld: 0 });
    expect(world.row()).toMatchObject({ status: "Abandoned", dispatchCount: 1, blockedReason: { source: "failure_given_up" } });
    expect(world.row().blockedReason).toMatchObject({ reason: expect.stringContaining("conflict markers") });
  });

  test("a retryable verdict under the bound: replanned", async () => {
    const world = parkedWorld({ kind: "recorded", verdict: { kind: "retryable", ground: "merge-conflict" } });

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ failedReplanned: 1, failedAbandoned: 0, failedHeld: 0 });
    expect(world.row()).toMatchObject({ status: "Pending", blockedReason: { source: "replan" } });
  });

  test("a row failed before the verdict was stored: routed as retryable work, replanned under the bound", async () => {
    const world = parkedWorld({ kind: "none" });

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ failedReplanned: 1, failedAbandoned: 0, failedHeld: 0 });
    expect(world.row().status).toBe("Pending");
  });

  test("a stored verdict that does not parse: left Failed, read as neither verdict, its project blocked", async () => {
    const world = parkedWorld({ kind: "unreadable", detail: '{"kind":"maybe"}: invalid discriminator' });

    const summary = await reconcileWorkItemsOnStartup(world.deps);

    expect(summary).toMatchObject({ failedReplanned: 0, failedAbandoned: 0, failedHeld: 1, failedErrored: 0 });
    expect(world.row().status).toBe("Failed");
    expect(world.projectBlocks).toEqual([expect.objectContaining({ category: "fault", errorClass: "StoredFailureVerdictCorrupt" })]);
  });
});

describe("reconcileWorkItemsOnStartup — the branches of settled tasks", () => {
  test("an Abandoned task's branch and worktree are released at startup, whichever path abandoned it", async () => {
    const taskId = createWorkItemId();
    const target = targetWithMain([]);
    const held = heldCheckout(target.path, taskId);
    try {
      const { deps } = buildDeps({
        workItemRepo: { ...emptyWorkItemRepo(), listIdsByStatus: async (statuses) => (statuses.includes("Abandoned") ? [taskId] : []) },
        projects: {
          block: unusedBlock,
          get: async () => ({ workspacePath: target.path }),
          listWithWorkspace: async () => [{ id: parseProjectId("00000000-0000-4000-8000-0000000000bc", "test"), workspacePath: target.path }],
        },
      });
      expect(held()).toEqual({ branch: `task/${taskId}`, worktree: true });

      await reconcileWorkItemsOnStartup(deps);

      expect(held()).toEqual({ branch: "", worktree: false });
    } finally {
      rmSync(target.path, { recursive: true, force: true });
      rmSync(join(tmpdir(), `task-${taskId}`), { recursive: true, force: true });
    }
  });
});
