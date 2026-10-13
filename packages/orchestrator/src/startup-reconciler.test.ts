import { afterEach, describe, expect, test, vi } from "vitest";
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
    projects: { block: unusedBlock },
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
  const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-0000000000aa");

  function orphanDeps(evidence: { readonly latestPhase: string | null; readonly orphanedBefore: number }) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date();
    let row: WorkItem = {
      id: createWorkItemId(),
      level: "Task",
      status: "InProgress",
      title: "orphan",
      runScope: "run",
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
