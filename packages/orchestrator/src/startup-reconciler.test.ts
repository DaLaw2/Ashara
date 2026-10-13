import { describe, expect, test } from "vitest";
import type { RunState } from "@ashara/shared";
import { RUN_SCOPE_AD_HOC, RUN_SCOPE_PRE_SCOPING } from "@ashara/shared";
import type { FailureRouter, WorkItemRepository, WorkItem } from "./acl/planning-acl.js";
import { createPendingWorkItem, takeEvents } from "./acl/planning-acl.js";
import type { StartupReconcilerDeps } from "./startup-reconciler.js";
import { reconcileOnStartup } from "./startup-reconciler.js";

interface FailStaleCall {
  readonly reason: unknown;
}

const ACTIVE_RUN_ID = "run-active-111";
const DEAD_RUN_ID = "run-dead-222";
const OTHER_DEAD_RUN_ID = "run-dead-333";

function openRunState(runId: string): RunState {
  return {
    runId,
    openedAt: new Date().toISOString(),
    closed: false,
    spendUsd: 0,
    acceptanceAttempts: 0,
  };
}

function closedRunState(runId: string): RunState {
  return {
    runId,
    openedAt: new Date().toISOString(),
    closed: true,
    spendUsd: 0,
    acceptanceAttempts: 0,
  };
}

function seedPending(runScope: string): WorkItem {
  const item = createPendingWorkItem("Task", `task-pending-${runScope}`, runScope);
  takeEvents(item);
  return item;
}

/** No work items to reconcile — these tests are about the session pass only. */
function emptyWorkItemRepo(): WorkItemRepository {
  const unused = (method: string) => (): never => {
    throw new Error(`WorkItemRepository.${method} is not exercised by this test`);
  };
  return {
    create: unused("create"),
    findById: unused("findById"),
    findByStatus: async () => [],
    save: unused("save"),
    incrementDispatchCount: unused("incrementDispatchCount"),
    listAll: unused("listAll"),
    addDependency: unused("addDependency"),
    getDependencies: unused("getDependencies"),
    findChildren: unused("findChildren"),
    listAllDependencies: unused("listAllDependencies"),
    withTransaction: unused("withTransaction"),
  };
}

function pendingAwareRepo(items: WorkItem[]): {
  repo: WorkItemRepository;
  saves: Array<{ id: string; from: string; to: string }>;
} {
  const saves: Array<{ id: string; from: string; to: string }> = [];
  const base = emptyWorkItemRepo();
  return {
    repo: {
      ...base,
      findByStatus: async (status: string) => items.filter((i) => i.status === status),
      save: async (item, previousStatus) => {
        saves.push({ id: item.id, from: previousStatus, to: item.status });
      },
    },
    saves,
  };
}

function buildDeps(overrides: Partial<StartupReconcilerDeps> = {}): {
  deps: StartupReconcilerDeps;
  failStaleCalls: FailStaleCall[];
} {
  const failStaleCalls: FailStaleCall[] = [];

  const deps: StartupReconcilerDeps = {
    workItemRepo: emptyWorkItemRepo(),
    eventStore: { publish: async () => undefined },
    // Provably never invoked: findByStatus("Failed") returns [], so no item is
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
    },
    // Required: an empty repo returns no dirs, so the sweep is a no-op.
    workdirBase: "/nonexistent-test-workdir",
    runStateStore: { load: async () => null },
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
      passed: false,
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
      },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.sessionsTerminalized).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pending-orphan pass: items from runs that are no longer open are abandoned.
// ---------------------------------------------------------------------------
describe("reconcileOnStartup — Pending-orphan pass", () => {
  test("abandons Pending items from a dead run when the active run is different", async () => {
    const activeItem = seedPending(ACTIVE_RUN_ID);
    const deadItem = seedPending(DEAD_RUN_ID);
    const { repo, saves } = pendingAwareRepo([activeItem, deadItem]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(1);
    expect(summary.pendingSkippedActiveRun).toBe(1);
    expect(saves.some((s) => s.id === deadItem.id && s.to === "Abandoned")).toBe(true);
    expect(saves.some((s) => s.id === activeItem.id)).toBe(false);
    expect(deadItem.status).toBe("Abandoned");
    expect(activeItem.status).toBe("Pending");
  });

  test("preserves ad-hoc Pending items regardless of run state", async () => {
    const adHocItem = seedPending(RUN_SCOPE_AD_HOC);
    const { repo, saves } = pendingAwareRepo([adHocItem]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingSkippedAdHoc).toBe(1);
    expect(summary.pendingOrphansAbandoned).toBe(0);
    expect(saves).toHaveLength(0);
    expect(adHocItem.status).toBe("Pending");
  });

  test("preserves pre-scoping Pending items regardless of run state", async () => {
    const preScopingItem = seedPending(RUN_SCOPE_PRE_SCOPING);
    const { repo, saves } = pendingAwareRepo([preScopingItem]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingSkippedPreScoping).toBe(1);
    expect(summary.pendingOrphansAbandoned).toBe(0);
    expect(saves).toHaveLength(0);
    expect(preScopingItem.status).toBe("Pending");
  });

  test("when the last run is closed, ALL non-sentinel Pending items are orphaned", async () => {
    const orphan1 = seedPending(DEAD_RUN_ID);
    const orphan2 = seedPending(OTHER_DEAD_RUN_ID);
    const adHoc = seedPending(RUN_SCOPE_AD_HOC);
    const { repo, saves } = pendingAwareRepo([orphan1, orphan2, adHoc]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => closedRunState(DEAD_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(2);
    expect(summary.pendingSkippedAdHoc).toBe(1);
    expect(saves).toHaveLength(2);
    expect(orphan1.status).toBe("Abandoned");
    expect(orphan2.status).toBe("Abandoned");
    expect(adHoc.status).toBe("Pending");
  });

  test("when no run state exists, ALL non-sentinel Pending items are orphaned", async () => {
    const orphan = seedPending(DEAD_RUN_ID);
    const { repo, saves } = pendingAwareRepo([orphan]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => null },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(1);
    expect(saves).toHaveLength(1);
    expect(orphan.status).toBe("Abandoned");
  });

  test("the abandon reason carries structured context about the orphan", async () => {
    const orphan = seedPending(DEAD_RUN_ID);
    const { repo } = pendingAwareRepo([orphan]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    await reconcileOnStartup(deps);

    expect(orphan.blockedReason).toEqual({
      reason: "orphaned by a previous run that is no longer open",
      source: "startup-reconciler",
      previousScope: DEAD_RUN_ID,
    });
  });

  test("a single item's save failure does not prevent the rest from being abandoned", async () => {
    const good = seedPending(DEAD_RUN_ID);
    const bad = seedPending(OTHER_DEAD_RUN_ID);
    const alsoGood = seedPending("run-dead-444");
    const { repo } = pendingAwareRepo([good, bad, alsoGood]);
    let saveCount = 0;
    const origSave = repo.save;
    repo.save = async (item, prev) => {
      saveCount += 1;
      if (saveCount === 2) throw new Error("db blip");
      return origSave.call(repo, item, prev);
    };
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(2);
    expect(summary.pendingOrphansErrored).toBe(1);
  });

  test("run-state load failure skips the pass entirely (fail-closed on destructive path)", async () => {
    const item = seedPending(DEAD_RUN_ID);
    const { repo, saves } = pendingAwareRepo([item]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: {
        load: async () => {
          throw new Error("db unreachable");
        },
      },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(0);
    expect(summary.pendingOrphansErrored).toBe(0);
    expect(saves).toHaveLength(0);
    expect(item.status).toBe("Pending");
  });

  test("mixed board: active-run preserved, dead-run abandoned, sentinels preserved", async () => {
    const active1 = seedPending(ACTIVE_RUN_ID);
    const active2 = seedPending(ACTIVE_RUN_ID);
    const dead = seedPending(DEAD_RUN_ID);
    const adHoc = seedPending(RUN_SCOPE_AD_HOC);
    const preScoping = seedPending(RUN_SCOPE_PRE_SCOPING);
    const { repo, saves } = pendingAwareRepo([active1, active2, dead, adHoc, preScoping]);
    const { deps } = buildDeps({
      workItemRepo: repo,
      runStateStore: { load: async () => openRunState(ACTIVE_RUN_ID) },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.pendingOrphansAbandoned).toBe(1);
    expect(summary.pendingSkippedActiveRun).toBe(2);
    expect(summary.pendingSkippedAdHoc).toBe(1);
    expect(summary.pendingSkippedPreScoping).toBe(1);
    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe(dead.id);
    expect(active1.status).toBe("Pending");
    expect(active2.status).toBe("Pending");
    expect(dead.status).toBe("Abandoned");
    expect(adHoc.status).toBe("Pending");
    expect(preScoping.status).toBe("Pending");
  });
});
