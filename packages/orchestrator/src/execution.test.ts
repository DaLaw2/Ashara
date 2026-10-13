import { describe, expect, test, vi, afterEach } from "vitest";
import type { StoredBlockedReason, WorkItemId } from "@ashara/shared";
import { InvalidStatusTransition, createWorkItemId, parseProjectId, parseWorkItemJsonb } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import { startWorkItem, takeEvents } from "./acl/planning-acl.js";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps } from "./types.js";
import { processTask } from "./execution.js";

const RUN_SCOPE = "run-test-preemption";
const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001");
// Stable ID shared by every item copy the mock repo returns, so the domain
// service, lifecycle router, and processTask itself all operate on what looks
// like the same row.
const ITEM_ID: WorkItemId = createWorkItemId();

function freshPendingItem(): WorkItem {
  const now = new Date();
  return {
    id: ITEM_ID,
    level: "Task",
    status: "Pending",
    title: "test-preempted-task",
    runScope: RUN_SCOPE,
    projectId: TEST_PROJECT_ID,
    dispatchCount: 0,
    workKind: "implementation",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function freshAbandonedItem(opts?: { omitBlockedReason?: boolean }): WorkItem {
  const item = freshPendingItem();
  startWorkItem(item);
  item.status = "Abandoned";
  if (!opts?.omitBlockedReason) {
    item.blockedReason = { source: "api", reason: "cancelled by operator" } satisfies StoredBlockedReason;
  }
  item.updatedAt = new Date();
  takeEvents(item);
  return item;
}

function notExercised(label: string): () => never {
  return () => { throw new Error(`${label}: not exercised`); };
}

/**
 * Every dep processTask is handed, fully typed: a dep CoreLoopDeps gains and this omits is a
 * compile error here, never a runtime TypeError. The loop's steps are never run by processTask.
 */
function coreLoopDeps(
  parts: Pick<CoreLoopDeps, "workItemRepo" | "developmentService"> & Partial<Omit<CoreLoopDeps, "eventLogger">>,
): CoreLoopDeps {
  return {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-workdir" },
    eventStore: { publish: async () => {} },
    failedApproachRepo: { record: async () => {} },
    projectRepo: {
      get: async () => ({ workspacePath: "/tmp/ashara-execution-test-target" }),
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: notExercised("listActiveIds"),
      block: notExercised("block"),
    },
    failureRouter: { route: notExercised("route") },
    spendCap: { deploymentStop: notExercised("deploymentStop"), refusalOf: () => null },
    clientStops: { runPending: notExercised("clientStops") },
    liaisonIntake: { runPending: notExercised("liaisonIntake") },
    rosterDerivation: { runPending: notExercised("rosterDerivation") },
    firstPlanning: { runPending: notExercised("firstPlanning") },
    planReports: { runPending: notExercised("planReports") },
    stackChoices: { runPending: notExercised("stackChoices") },
    ...parts,
  };
}

/**
 * Builds a CoreLoopDeps mock where the workItemRepo returns a Pending item on
 * the first findById call and an Abandoned item on all subsequent calls —
 * simulating an external actor (HTTP PATCH) moving the item while the agent
 * was executing.
 */
interface PreemptionDepsOptions {
  /** Override the agent's execution result status. Default: "failed". */
  agentOutcome?: "completed" | "failed" | "blocked";
  /** When true, the Abandoned item has no blockedReason (the NULL gap). */
  omitBlockedReason?: boolean;
}

function buildPreemptionDeps(options?: PreemptionDepsOptions): {
  deps: CoreLoopDeps;
  warns: string[];
  logs: string[];
  savedBlockedReasons: StoredBlockedReason[];
} {
  const agentOutcome = options?.agentOutcome ?? "failed";
  const warns: string[] = [];
  const logs: string[] = [];
  const savedBlockedReasons: StoredBlockedReason[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  let findByIdCalls = 0;
  const workItemRepo: WorkItemRepository = {
    findById: async (_id: WorkItemId) => {
      findByIdCalls++;
      if (findByIdCalls === 1) return freshPendingItem();
      return freshAbandonedItem({ omitBlockedReason: options?.omitBlockedReason });
    },
    save: async (item: WorkItem) => {
      // Capture the blockedReason written by the salvage path
      if (item.blockedReason) savedBlockedReasons.push(item.blockedReason);
    },
    create: notExercised("create"),
    listByProject: notExercised("listByProject"),
    findByProjectAndStatus: notExercised("findByProjectAndStatus"),
    projectIdsWithStatus: notExercised("projectIdsWithStatus"),
    listIdsByStatus: notExercised("listIdsByStatus"),
    incrementDispatchCount: async () => 1,
    refundDispatchCount: notExercised("refundDispatchCount"),
    addDependency: notExercised("addDependency"),
    getDependencies: async () => [],
    findChildren: async () => [],
    listAllDependencies: notExercised("listAllDependencies"),
    withTransaction: notExercised("withTransaction"),
  };

  const deps = coreLoopDeps({
    workItemRepo,
    developmentService: {
      execute: async () => ({
        status: agentOutcome,
        detail: agentOutcome === "completed"
          ? "task completed and verified successfully"
          : "agent hit turn limit",
        output: null,
        sessionId: "test-session",
        attempt: 1,
      }),
    },
  });

  return { deps, warns, logs, savedBlockedReasons };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processTask post-agent status ladder", () => {
  test("preempted-to-Abandoned item with failed result salvages the result", async () => {
    const { deps, logs, savedBlockedReasons } = buildPreemptionDeps();
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    // The function must return the agent's result, not throw
    expect(result.status).toBe("failed");

    // The salvage must produce a structured log (Discipline C)
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain(ITEM_ID);
    expect(salvageLog).toContain("outcome: failed");

    // The blockedReason must carry the salvaged fields after save
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("failed");
    expect(lastSaved.salvagedDetail).toBeDefined();
    expect(lastSaved.salvagedAt).toBeDefined();
  });

  test("preempted-to-Abandoned item with completed result salvages the result", async () => {
    const { deps, logs, savedBlockedReasons } = buildPreemptionDeps({
      agentOutcome: "completed",
    });
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    // The completed agent result is still returned
    expect(result.status).toBe("completed");

    // The salvage must produce a structured log
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain(ITEM_ID);
    expect(salvageLog).toContain("outcome: completed");

    // The blockedReason must carry the salvaged outcome
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("completed");
    expect(typeof lastSaved.salvagedAt).toBe("string");
  });

  test("Abandoned item with no prior blockedReason still salvages the result", async () => {
    const { deps, logs, warns, savedBlockedReasons } = buildPreemptionDeps({
      omitBlockedReason: true,
    });
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    expect(result.status).toBe("failed");

    // A warning about the missing blockedReason must be emitted (Discipline C)
    const gapWarn = warns.find((w) => w.includes("no blockedReason"));
    expect(gapWarn).toBeDefined();
    expect(gapWarn).toContain(ITEM_ID);

    // The salvage must still succeed — the result must not be lost
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain("outcome: failed");

    // The constructed reason must parse under storedBlockedReasonSchema
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: lastSaved }),
    ).not.toThrow();

    // The constructed reason must carry the salvaged fields
    expect(lastSaved.salvagedOutcome).toBe("failed");
    expect(lastSaved.salvagedDetail).toBeDefined();
    expect(lastSaved.salvagedAt).toBeDefined();
    // The base reason must be orchestrator_error (honest about provenance)
    expect(lastSaved.source).toBe("orchestrator_error");
  });

  test("vanished item (null re-read) logs a warning and does not throw", async () => {
    const { deps, warns } = buildPreemptionDeps();

    // Override findById to return null after the first call
    let calls = 0;
    deps.workItemRepo.findById = async () => {
      calls++;
      if (calls === 1) return freshPendingItem();
      return null;
    };

    const task = freshPendingItem();
    const result = await processTask(deps, task);

    expect(result.status).toBe("failed");

    const vanishedWarn = warns.find((w) => w.includes("vanished"));
    expect(vanishedWarn).toBeDefined();
    expect(vanishedWarn).toContain(ITEM_ID);
    expect(vanishedWarn).toContain("agent spend unrecoverable");
  });
});

describe("an environment-blocked dispatch parks the item at Blocked", () => {
  type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["developmentService"]["execute"]>>;

  const probeBlocked: ExecutionResult = {
    status: "environment_blocked",
    unavailable: "podman",
    detail: "execution substrate \"podman\" unavailable; no agent ran: podman binary not found on PATH",
    output: null,
    sessionId: "test-session",
    attempt: 1,
    errorEnvelope: { outcome: "blocked", summary: "podman unavailable", chain: { boundary: "development", operation: "provision", message: "podman unavailable", timestamp: new Date().toISOString() } },
  };

  function buildEnvironmentBlockedDeps(execResult: ExecutionResult = probeBlocked): {
    deps: CoreLoopDeps;
    stored: () => WorkItem;
    statusesWritten: string[];
    failureRoutes: () => number;
    failedApproaches: () => number;
  } {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let row = freshPendingItem();
    const statusesWritten: string[] = [];
    let routed = 0;
    let approaches = 0;
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });

    const workItemRepo: WorkItemRepository = {
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) {
          throw new Error(`pre-image mismatch: stored ${row.status}, expected ${expectedPreviousStatus}`);
        }
        statusesWritten.push(item.status);
        row = copy(item);
      },
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      incrementDispatchCount: async () => 1,
      refundDispatchCount: notExercised("refundDispatchCount"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listAllDependencies: notExercised("listAllDependencies"),
      withTransaction: notExercised("withTransaction"),
    };

    const deps = coreLoopDeps({
      workItemRepo,
      developmentService: { execute: async () => execResult },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    });

    return { deps, stored: () => row, statusesWritten, failureRoutes: () => routed, failedApproaches: () => approaches };
  }

  test("the item becomes Blocked with an environment_unavailable reason, never Failed, and the failure router is not called", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps();

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(stored().status).toBe("Blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(statusesWritten).not.toContain("Failed");
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);

    const reason = stored().blockedReason;
    expect(reason?.source).toBe("environment_unavailable");
    if (reason?.source !== "environment_unavailable") return;
    expect(reason.unavailable).toBe("podman");
    expect(reason.reason).toContain("podman binary not found");
    // The persisted reason must survive the jsonb read-back schema.
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });

  // The isolated-worker run's finding 1: the verifier cell refused after the agent's work passed.
  // Before, operation postMergeVerify reached the classifier as TREE_REGRESSION and was abandoned.
  test("a verifier cell refused after the agent ran: Blocked naming the stage, never the failure router", async () => {
    const output: AgentOutputJson = {
      status: "done",
      summary: "wrote greet.sh",
      findings: [],
      error: null,
      error_detail: null,
      total_tokens: { input: 100, output: 10 },
      total_cost: 0.0006,
      cost_measured: true,
      turn_count: 4,
      finish_reason: "completed",
    };
    const detail =
      "environment failed at stage postMergeVerify (MountPathRejected): Mount of \"/x/target\" refused: it is not strictly inside the mount root; " +
      "task t blocked, the agent's work is kept on the task branch";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_blocked",
      unavailable: "verifier cell mount (/x/target)",
      detail,
      output,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "postMergeVerify", message: "Post-merge verify could not run", timestamp: new Date().toISOString() },
        agentOutput: output,
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason?.source).toBe("environment_unavailable");
    if (reason?.source !== "environment_unavailable") return;
    expect(reason.unavailable).toBe("verifier cell mount (/x/target)");
    expect(reason.reason).toContain("stage postMergeVerify (MountPathRejected)");
  });

  // s-platform-role-m1 C2: a project with no environment blocks its task; it never runs on the BaseCell.
  test("no environment defined: Blocked with an environment_undefined reason, never Failed, no failure router", async () => {
    const detail = "no environment for task t: no environment is defined on main at abc; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_undefined",
      reason: "no environment is defined on main at abc",
      detail,
      output: null,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "resolveCurrentEnvironment", message: "no environment", timestamp: new Date().toISOString() },
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason).toMatchObject({ source: "environment_undefined", reason: detail });
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });


  // ADR-074 addendum 2 d63: an implementer needing an environment change is Blocked in M1, not retried blindly.
  test("environment change needed: Blocked naming the paths, never Failed, no failed approach, no failure router", async () => {
    const detail = "ownership gate refused the work of t: environment files belong to the platform role; ...";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_change_needed",
      paths: ["environment/Containerfile"],
      detail,
      output: {
        status: "done",
        summary: "wrote greet.sh and the Containerfile",
        findings: [],
        error: null,
        error_detail: null,
        total_tokens: { input: 100, output: 10 },
        total_cost: 0.0006,
        cost_measured: true,
        turn_count: 4,
        finish_reason: "completed",
      },
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "ownershipGate", message: detail, timestamp: new Date().toISOString() },
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason).toMatchObject({ source: "environment_change_needed", paths: ["environment/Containerfile"], reason: detail });
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });

  // s-team-roster-m1: an item no roster role owns blocks; no default role works it.
  test("no owner role: Blocked with a typed owner_unresolved reason, never Failed, no failed approach, no failure router", async () => {
    const detail = "no roster role can work task t: the work item has no owner role; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "owner_unresolved",
      ownerRoleId: null,
      reason: "the work item has no owner role",
      detail,
      output: null,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "assignAgent", message: "no owner", timestamp: new Date().toISOString() },
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason).toEqual({ source: "owner_unresolved", ownerRoleId: null, reason: "the work item has no owner role" });
    expect(parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }).blockedReason).toEqual(reason);
  });
});

// The 30fb60d5 review (c): stale checks were classified VERIFICATION_GAP, replanned and lessoned against the implementer.
// The 93f7aeb7 review (d): parked at Blocked naming the check task, nothing ever reopened it.
describe("stored checks stale: the check task is reopened and the item waits on it", () => {
  const CHECK_ID: WorkItemId = createWorkItemId();
  const detail = "the checks of task t (revision 1, check task c) were red-run on environment version e, but ...";

  function completedCheckTask(overrides: Partial<WorkItem> = {}): WorkItem {
    return { ...freshPendingItem(), id: CHECK_ID, title: "write the checks", workKind: "check", status: "Completed", dispatchCount: 1, ...overrides };
  }

  function buildStaleDeps(options: { readonly checkTask: WorkItem | null; readonly revision: number; readonly checkTaskSaveLoses?: boolean }) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = new Map<string, WorkItem>([[ITEM_ID, freshPendingItem()]]);
    if (options.checkTask !== null) rows.set(CHECK_ID, options.checkTask);
    const written: Array<readonly [string, string]> = [];
    const events: string[] = [];
    let routed = 0;
    let approaches = 0;
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const rowOf = (id: string): WorkItem => {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`no row ${id}`);
      return row;
    };

    const workItemRepo: WorkItemRepository = {
      findById: async (id) => {
        const row = rows.get(id);
        return row === undefined ? null : copy(row);
      },
      save: async (item: WorkItem, expectedPreviousStatus) => {
        const row = rowOf(item.id);
        if (item.id === CHECK_ID && options.checkTaskSaveLoses === true) throw new InvalidStatusTransition(item.id, "Abandoned", item.status);
        if (row.status !== expectedPreviousStatus) throw new InvalidStatusTransition(item.id, row.status, item.status);
        written.push([item.id === CHECK_ID ? "check" : "item", item.status]);
        rows.set(item.id, { ...copy(item), dispatchCount: row.dispatchCount });
      },
      incrementDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount + 1 });
        return row.dispatchCount + 1;
      },
      refundDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listAllDependencies: notExercised("listAllDependencies"),
      withTransaction: notExercised("withTransaction"),
    };

    const deps = coreLoopDeps({
      workItemRepo,
      eventStore: { publish: async (event) => void events.push(event.eventType) },
      developmentService: {
        execute: async () => ({
          status: "checks_stale",
          checkTaskId: CHECK_ID,
          revision: options.revision,
          detail,
          output: null,
          sessionId: "test-session",
          attempt: 1,
          errorEnvelope: {
            outcome: "blocked",
            summary: detail,
            chain: { boundary: "development", operation: "revalidateTaskChecks", message: detail, timestamp: new Date().toISOString() },
          },
        }),
      },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    });
    return { deps, item: () => rowOf(ITEM_ID), check: () => rowOf(CHECK_ID), written, events, routed: () => routed, approaches: () => approaches };
  }

  const parses = (reason: StoredBlockedReason | undefined) => () =>
    parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason });

  test("within the bound: the check task back at Pending with the red run as its context, the item at Pending waiting, the dispatch given back", async () => {
    const { deps, item, check, written, events, routed, approaches } = buildStaleDeps({ checkTask: completedCheckTask(), revision: 1 });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    // The check task is saved first, so the item never waits on a check task that stayed Completed.
    expect(written).toEqual([["item", "InProgress"], ["check", "Pending"], ["item", "Pending"]]);
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: undefined });
    expect(check().status).toBe("Pending");
    const context = check().blockedReason;
    expect(context?.source).toBe("replan");
    if (context?.source !== "replan") return;
    expect(context.replanContext.detail).toContain(`task ${ITEM_ID} (revision 1)`);
    expect(context.replanContext.detail).toContain(detail);
    expect(parses(context)).not.toThrow();
    expect(events).toEqual(expect.arrayContaining(["work_item.reopened", "work_item.awaiting_checks"]));
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  test("past the bound: the item parked with checks_rewrite_bound stating it; the check task left Completed", async () => {
    const { deps, item, check } = buildStaleDeps({ checkTask: completedCheckTask(), revision: 3 });

    await processTask(deps, freshPendingItem());

    expect(item()).toMatchObject({ status: "Blocked", dispatchCount: 1 });
    const reason = item().blockedReason;
    expect(reason).toMatchObject({ source: "checks_rewrite_bound", checkTaskId: CHECK_ID, revision: 3, bound: 2 });
    expect(reason?.source === "checks_rewrite_bound" ? reason.reason : "").toContain("written again 2 time(s), the bound of 2");
    expect(parses(reason)).not.toThrow();
    expect(check().status).toBe("Completed");
  });

  test.each([
    ["the check task is not Completed", completedCheckTask({ status: "Abandoned" }), "is Abandoned, not Completed"],
    ["the named item is not a check task", completedCheckTask({ workKind: "implementation" }), "of work kind implementation, not check"],
    ["the check task is not on record", null, "is not on record"],
  ])("%s: the item parked with checks_stale naming why it cannot be reopened", async (_label, checkTask, why) => {
    const { deps, item } = buildStaleDeps({ checkTask, revision: 1 });

    await processTask(deps, freshPendingItem());

    expect(item().status).toBe("Blocked");
    const reason = item().blockedReason;
    expect(reason).toMatchObject({ source: "checks_stale", checkTaskId: CHECK_ID });
    expect(reason?.source === "checks_stale" ? reason.reason : "").toContain(why);
    expect(parses(reason)).not.toThrow();
  });

  test("the check task moves before its reopen is saved: the item parked with checks_stale, never left waiting", async () => {
    const { deps, item, written } = buildStaleDeps({ checkTask: completedCheckTask(), revision: 1, checkTaskSaveLoses: true });

    await processTask(deps, freshPendingItem());

    expect(written).toEqual([["item", "InProgress"], ["item", "Blocked"]]);
    expect(item().blockedReason).toMatchObject({ source: "checks_stale", reason: expect.stringContaining("moved to Abandoned") });
  });

});

// The 509bbbc5 review: a turn refused at a spend cap reached the FailureRouter as a failed attempt.
// The 30fb60d5 review (e): a refusal no cap made took the failure route; one rule now holds for both.
describe("a dispatch refused before its call was sent is no failed approach", () => {
  class StubCapRefusal extends Error {
    constructor(readonly scope: "project" | "deployment") {
      super(`budget_cap: the spend cap of ${scope === "project" ? `project ${TEST_PROJECT_ID}` : "the deployment"} would be crossed`);
      this.name = "BudgetExceeded";
    }
  }

  const output: AgentOutputJson = {
    status: "blocked",
    summary: "attempt ended as refused",
    findings: [],
    error: null,
    error_detail: { model: "m", turn_count: 2, last_tool_call: "run_command", message: "refused" },
    total_tokens: { input: 100, output: 10 },
    total_cost: 0.001,
    cost_measured: true,
    turn_count: 2,
    finish_reason: "error",
  };

  /** Stands for Finance's UnpricedModel: a refusal no spend cap made. */
  class StubUnpricedModel extends Error {
    constructor() {
      super('Model "m" (provider "p") is unpriced: input_cost_per_1m=0, output_cost_per_1m=0. The request was not sent.');
      this.name = "UnpricedModel";
    }
  }

  function buildRefusalDeps(scope: "project" | "deployment" | "configuration" | "shutdown", priorDispatches = 0) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let row: WorkItem = { ...freshPendingItem(), dispatchCount: priorDispatches };
    const attempts: number[] = [];
    const statusesWritten: string[] = [];
    let routed = 0;
    let approaches = 0;
    const blocks: Array<{ readonly projectId: string; readonly errorClass: string; readonly reason: string }> = [];
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const refusal = scope === "configuration" ? new StubUnpricedModel() : new StubCapRefusal(scope === "shutdown" ? "project" : scope);
    const envelope = {
      outcome: "blocked" as const,
      summary: refusal.message,
      chain: { boundary: "development", operation: "agentAttempt", message: refusal.message, timestamp: new Date().toISOString() },
    };

    const workItemRepo: WorkItemRepository = {
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) {
          throw new Error(`pre-image mismatch: stored ${row.status}, expected ${expectedPreviousStatus}`);
        }
        statusesWritten.push(item.status);
        // save writes status and metadata; the dispatch count has its own writers.
        row = { ...copy(item), dispatchCount: row.dispatchCount };
      },
      incrementDispatchCount: async () => {
        row = { ...row, dispatchCount: row.dispatchCount + 1 };
        return row.dispatchCount;
      },
      refundDispatchCount: async () => {
        row = { ...row, dispatchCount: row.dispatchCount - 1 };
        return row.dispatchCount;
      },
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listAllDependencies: notExercised("listAllDependencies"),
      withTransaction: notExercised("withTransaction"),
    };

    const deps = coreLoopDeps({
      workItemRepo,
      developmentService: {
        execute: async (task) => {
          attempts.push(task.attempt);
          return scope === "shutdown"
            ? { status: "interrupted", detail: "attempt interrupted by shutdown after 2 turn(s)", output, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope }
            : { status: "refused", refusal, detail: `attempt stopped after 2 turn(s): ${refusal.message}`, output, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope };
        },
      },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
      projectRepo: {
        get: async () => ({ workspacePath: "/tmp/ashara-execution-test-target" }),
        recordWorkspacePath: notExercised("recordWorkspacePath"),
        listActiveIds: notExercised("listActiveIds"),
        block: async (projectId, cause) => {
          blocks.push({ projectId, ...cause });
          return "blocked";
        },
      },
      spendCap: {
        deploymentStop: notExercised("deploymentStop"),
        refusalOf: (error) =>
          error instanceof StubCapRefusal
            ? error.scope === "project"
              ? { kind: "project", projectId: TEST_PROJECT_ID, reason: error.message }
              : { kind: "deployment", reason: error.message }
            : null,
      },
    });
    return { deps, stored: () => row, statusesWritten, attempts, failureRoutes: () => routed, failedApproaches: () => approaches, blocks };
  }

  test.each(["project", "deployment"] as const)(
    "refused at the %s cap: back to Pending, dispatch count unchanged, no lesson, no failure router",
    async (scope) => {
      const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildRefusalDeps(scope);

      const result = await processTask(deps, freshPendingItem());

      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.kind).toBe(scope);
      expect(result.refusal.reason).toMatch(/^budget_cap:/);
      expect(statusesWritten).toEqual(["InProgress", "Pending"]);
      expect(stored().status).toBe("Pending");
      expect(stored().dispatchCount).toBe(0);
      expect(failureRoutes()).toBe(0);
      expect(failedApproaches()).toBe(0);
    },
  );

  test("refused by an unpriced model: the project blocked with the class, back to Pending, no lesson, no failure router", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, blocks } = buildRefusalDeps("configuration");

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toMatchObject({ kind: "configuration", projectId: TEST_PROJECT_ID, errorClass: "UnpricedModel" });
    expect(blocks).toEqual([{ projectId: TEST_PROJECT_ID, errorClass: "UnpricedModel", reason: expect.stringContaining("is unpriced") }]);
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(stored().dispatchCount).toBe(0);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });

  // Sprint 0 run D2: a SIGTERM's cancelled attempt was counted, and the third count abandoned the item.
  test("interrupted by shutdown on its third dispatch: back to Pending, count unchanged, no lesson, no failure router", async () => {
    const { deps, stored, statusesWritten, attempts, failureRoutes, failedApproaches, blocks } = buildRefusalDeps("shutdown", 2);

    const result = await processTask(deps, { ...freshPendingItem(), dispatchCount: 2 });

    expect(result.status).toBe("interrupted");
    expect(attempts).toEqual([3]);
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(stored().status).toBe("Pending");
    expect(stored().dispatchCount).toBe(2);
    expect(blocks).toEqual([]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });
});
