import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi, afterEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "./work-item-language/transitions.js";
import { parseWorkItemJsonb } from "./work-item-language/work-item-row.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { startWorkItem, takeEvents } from "./domain/index.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { toRecordedOutcome } from "./acl/workplace-acl.js";
import type { Outcome } from "./acl/workplace-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps } from "./types.js";
import { processTask } from "./execution.js";

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001", "test");
// Stable ID shared by every item copy the mock repo returns, so the domain
// service, lifecycle router, and processTask itself all operate on what looks
// like the same row.
const ITEM_ID: WorkItemId = createWorkItemId();
const MERGE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OUTCOME_BASE = {
  turnsUsed: 1,
  cost: { measured: true as const, totalUsd: 0, turns: 1 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished done",
};
const COMPLETED_OUTCOME: Outcome = { ...OUTCOME_BASE, kind: "finished", status: "done", summary: "done", blockedReason: null, statement: null };

const targets: string[] = [];
afterAll(() => {
  for (const dir of targets.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A target whose main holds a commit with each subject, newest last: what a faulted dispatch's main is read from. */
function targetWithMain(subjects: readonly string[]): { readonly path: string; readonly head: string } {
  const path = mkdtempSync(join(tmpdir(), "ashara-execution-"));
  targets.push(path);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: path, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  for (const subject of subjects) git("commit", "-q", "--allow-empty", "-m", subject);
  return { path, head: git("rev-parse", "HEAD") };
}

/** Main holding no merge of any task: a faulted dispatch is routed as a fault. */
const UNMERGED_TARGET = targetWithMain([]).path;

function freshPendingItem(): WorkItem {
  const now = new Date();
  return {
    id: ITEM_ID,
    level: "Task",
    status: "Pending",
    title: "test-preempted-task",
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
  parts: Pick<CoreLoopDeps, "workItemRepo" | "dispatchService"> & Partial<CoreLoopDeps>,
): CoreLoopDeps {
  return {
    // Every target here is made under the temporary directory.
    config: { ...DEFAULT_CONFIG, workdirBase: tmpdir() },
    eventStore: { publish: async () => {} },
    failedApproachRepo: { record: async () => {} },
    projectRepo: {
      get: async () => ({ workspacePath: UNMERGED_TARGET }),
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: notExercised("listActiveIds"),
      block: notExercised("block"),
      listInfrastructureHalted: notExercised("listInfrastructureHalted"),
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: notExercised("blockAllActive"),
    },
    failureRouter: { route: notExercised("route") },
    spendCap: { deploymentStop: notExercised("deploymentStop"), refusalOf: () => null },
    clientStops: { runPending: notExercised("clientStops") },
    clientChanges: { runPending: notExercised("clientChanges") },
    liaisonIntake: { runPending: notExercised("liaisonIntake") },
    liaisonAnswers: { runPending: notExercised("liaisonAnswers") },
    rosterDerivation: { runPending: notExercised("rosterDerivation") },
    firstPlanning: { runPending: notExercised("firstPlanning") },
    replanning: { runPending: notExercised("replanning") },
    planReports: { runPending: notExercised("planReports") },
    stackChoices: { runPending: notExercised("stackChoices") },
    checkDisputes: { record: notExercised("checkDisputes") },
    suiteReviewFindings: { record: notExercised("suiteReviewFindings") },
    blockReports: { runPending: notExercised("blockReports") },
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    environmentOwner: notExercised("environmentOwner"),
    taskLanes: notExercised("taskLanes"),
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    acceptance: { readyForAcceptance: notExercised("readyForAcceptance"), recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
    deliveredReports: { runPending: notExercised("deliveredReports") },
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
  mergeRecords: Array<{ id: WorkItemId; commit: string }>;
} {
  const agentOutcome = options?.agentOutcome ?? "failed";
  const warns: string[] = [];
  const logs: string[] = [];
  const savedBlockedReasons: StoredBlockedReason[] = [];
  const mergeRecords: Array<{ id: WorkItemId; commit: string }> = [];
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
    recordInfrastructureFault: notExercised("recordInfrastructureFault"),
    refundDispatchCount: notExercised("refundDispatchCount"),
    recordMergeCommit: async (id, commit) => {
      mergeRecords.push({ id, commit });
    },
    addDependency: notExercised("addDependency"),
    getDependencies: async () => [],
    findChildren: async () => [],
    listDependenciesByProject: notExercised("listDependenciesByProject"),
    withTransaction: notExercised("withTransaction"),
  };

  const deps = coreLoopDeps({
    workItemRepo,
    dispatchService: {
      execute: async () =>
        agentOutcome === "completed"
          ? {
              status: agentOutcome,
              delivered: { kind: "merged", mergeCommit: MERGE_COMMIT },
              detail: "task completed and verified successfully",
              outcome: COMPLETED_OUTCOME,
              sessionId: "test-session",
              attempt: 1,
            }
          : {
              status: agentOutcome,
              verdict: { kind: "retryable", ground: "work" },
              detail: "agent hit turn limit",
              outcome: null,
              sessionId: "test-session",
              attempt: 1,
            },
    },
  });

  return { deps, warns, logs, savedBlockedReasons, mergeRecords };
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
    const { deps, logs, savedBlockedReasons, mergeRecords } = buildPreemptionDeps({
      agentOutcome: "completed",
    });
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    // The completed agent result is still returned
    expect(result.status).toBe("completed");
    // The merge happened on main, so its record is kept although the item was preempted.
    expect(mergeRecords).toEqual([{ id: ITEM_ID, commit: MERGE_COMMIT }]);

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

describe("an environment-blocked dispatch: an infrastructure fault requeues uncharged, other environment outcomes park", () => {
  type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["dispatchService"]["execute"]>>;

  const probeBlocked: ExecutionResult = {
    status: "environment_blocked",
    fault: "substrate",
    unavailable: "podman",
    detail: "execution substrate \"podman\" unavailable; no agent ran: podman binary not found on PATH",
    outcome: null,
    sessionId: "test-session",
    attempt: 1,
    errorEnvelope: { outcome: "blocked", summary: "podman unavailable", chain: { boundary: "development", operation: "provision", message: "podman unavailable", timestamp: new Date().toISOString() } },
  };

  function buildEnvironmentBlockedDeps(
    execResult: ExecutionResult = probeBlocked,
    faultsBefore = 0,
  ): {
    deps: CoreLoopDeps;
    stored: () => WorkItem;
    statusesWritten: string[];
    failureRoutes: () => number;
    failedApproaches: () => number;
    refunds: () => number;
    halts: ProjectBlockCause[];
  } {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let row = freshPendingItem();
    const statusesWritten: string[] = [];
    let routed = 0;
    let approaches = 0;
    let faults = faultsBefore;
    let refunded = 0;
    const halts: ProjectBlockCause[] = [];
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
      recordInfrastructureFault: async () => ++faults,
      refundDispatchCount: async () => {
        refunded++;
        return 0;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    };

    const base = coreLoopDeps({ workItemRepo, dispatchService: { execute: async () => execResult } });
    const deps = coreLoopDeps({
      workItemRepo,
      dispatchService: { execute: async () => execResult },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
      projectRepo: {
        ...base.projectRepo,
        block: async (_projectId, cause) => {
          halts.push(cause);
          return "blocked";
        },
      },
    });

    return { deps, stored: () => row, statusesWritten, failureRoutes: () => routed, failedApproaches: () => approaches, refunds: () => refunded, halts };
  }

  // Story s-loop-never-stop-m1 W6; simulator B4: one transient fault must not park a task for a person.
  test("an infrastructure fault within the budget: back to Pending, the dispatch refunded, never Failed, no failure router, no halt", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds, halts } = buildEnvironmentBlockedDeps();

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("interrupted");
    expect(stored().status).toBe("Pending");
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(refunds()).toBe(1);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    expect(halts).toEqual([]);
  });

  // The 400-seed deep soak (2026-10-15, two projects, seed 326): `git rev-parse HEAD` failed right
  // after the merge commit, the dispatch faulted as Ashara's, and the merged task was requeued.
  test("a fault after its merge reached main: the merge recorded and the task Completed, never requeued", async () => {
    const { deps, stored, statusesWritten, refunds } = buildEnvironmentBlockedDeps();
    const main = targetWithMain([`merge: task ${ITEM_ID}`]);
    deps.projectRepo.get = async () => ({ workspacePath: main.path });
    const records: string[] = [];
    deps.workItemRepo.recordMergeCommit = async (_id, commit, kind) => void records.push(`${commit}:${kind ?? "null"}`);

    await processTask(deps, freshPendingItem());

    expect(records).toEqual([`${main.head}:merged`]);
    expect(statusesWritten).toEqual(["InProgress", "Completed"]);
    expect(stored().status).toBe("Completed");
    expect(refunds()).toBe(0);
  });

  test("a fault before the target's repository exists: it holds no merge, so the fault is routed as one and the task requeued", async () => {
    const { deps, stored, refunds, halts } = buildEnvironmentBlockedDeps();
    const parent = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(parent);
    deps.projectRepo.get = async () => ({ workspacePath: join(parent, "never-created") });

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("Pending");
    expect(refunds()).toBe(1);
    expect(halts).toEqual([]);
  });

  test("main unreadable after a fault: Blocked orphan_unreconciled with the project blocked, never requeued blind", async () => {
    const { deps, stored, halts } = buildEnvironmentBlockedDeps();
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    deps.projectRepo.get = async () => ({ workspacePath: unreadable });

    await processTask(deps, freshPendingItem());

    expect(stored()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", faultClass: "ashara" } });
    expect(halts).toEqual([expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled" })]);
  });

  test("the fault past the budget of 3 halts the project on infrastructure once and requeues the item uncharged", async () => {
    const { deps, stored, refunds, halts } = buildEnvironmentBlockedDeps(probeBlocked, 3);

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("Pending");
    expect(refunds()).toBe(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ category: "infrastructure", errorClass: "InfrastructureFaultBudgetSpent" });
    expect(halts[0]?.reason).toContain("podman binary not found");
  });

  // ADR-080 d3 c: Ashara's own Z0 fault is not the machines; the substrate probe cannot end its halt.
  test("Ashara's own fault past the budget halts the project as a fault for the operator, never on infrastructure", async () => {
    const detail = "Ashara's own machinery failed at stage commitWork (DispatchFault): git add failed: index.lock exists";
    const asharaBlocked: ExecutionResult = {
      status: "environment_blocked",
      fault: "ashara",
      unavailable: "host git (add of the task worktree)",
      detail,
      outcome: null,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: detail, chain: { boundary: "development", operation: "commitWork", message: detail, timestamp: new Date().toISOString() } },
    };
    const { deps, stored, refunds, halts, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps(asharaBlocked, 3);

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("Pending");
    expect(refunds()).toBe(1);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ category: "fault", errorClass: "AsharaFaultBudgetSpent" });
    expect(halts[0]?.reason).toContain("index.lock exists");
  });

  // Orchestrator D2: a fault before the dispatch seam was charged as the task's and replanned without bound.
  test("a throw before the dispatch seam: Ashara's fault, back to Pending uncounted, no failure router, no lesson", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps();
    let counted = 0;
    deps.workItemRepo.incrementDispatchCount = async () => {
      counted++;
      return 1;
    };
    deps.projectRepo.get = async () => {
      throw new Error("connection terminated unexpectedly");
    };

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("interrupted");
    expect(result.detail).toContain("connection terminated unexpectedly");
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(stored().status).toBe("Pending");
    expect(counted).toBe(0);
    expect(refunds()).toBe(0);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });

  test("a throw out of the dispatch past the seam: Ashara's fault, back to Pending with the dispatch refunded, no lesson", async () => {
    const { deps, stored, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps();
    deps.dispatchService.execute = async () => {
      throw new Error("dev_sessions insert failed");
    };

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("interrupted");
    expect(stored().status).toBe("Pending");
    expect(refunds()).toBe(1);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });

  test("a fault after the halt resumed gives the item up for a plan repair, with the fault as its cause", async () => {
    const { deps, stored, statusesWritten, failureRoutes, halts } = buildEnvironmentBlockedDeps(probeBlocked, 4);

    await processTask(deps, freshPendingItem());

    expect(statusesWritten).toEqual(["InProgress", "Abandoned"]);
    expect(failureRoutes()).toBe(0);
    expect(halts).toEqual([]);
    const reason = stored().blockedReason;
    expect(reason?.source).toBe("environment_unavailable");
    if (reason?.source !== "environment_unavailable") return;
    expect(reason.unavailable).toBe("podman");
    expect(reason.reason).toContain("infrastructure fault 5");
    // The persisted reason must survive the jsonb read-back schema.
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });

  // The isolated-worker run's finding 1: the verifier cell refused after the agent's work passed.
  // Before, operation postMergeVerify reached the classifier as TREE_REGRESSION and was abandoned.
  test("a verifier cell refused after the agent ran: an infrastructure fault, never the failure router", async () => {
    const outcome: Outcome = { ...COMPLETED_OUTCOME, summary: "wrote greet.sh", turnsUsed: 4, cost: { measured: true, totalUsd: 0.0006, turns: 4 } };
    const detail =
      "environment failed at stage postMergeVerify (MountPathRejected): Mount of \"/x/target\" refused: it is not strictly inside the mount root; " +
      "task t blocked, the agent's work is kept on the task branch";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_blocked",
      fault: "substrate",
      unavailable: "verifier cell mount (/x/target)",
      detail,
      outcome,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "postMergeVerify", message: "Post-merge verify could not run", timestamp: new Date().toISOString() },
        agentOutput: { ...toRecordedOutcome(outcome) },
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result).toMatchObject({ status: "interrupted", detail: expect.stringContaining("stage postMergeVerify (MountPathRejected)") });
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(stored().status).toBe("Pending");
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });

  // s-platform-role-m1 C2: a project with no environment never runs the task on the BaseCell. W6: nothing
  // re-defines main's environment while every environment task is done, so the task is given up for a repair.
  test("no environment defined: given up with an environment_undefined reason, never Failed, no failure router", async () => {
    const detail = "no environment for task t: no environment is defined on main at abc; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_undefined",
      reason: "no environment is defined on main at abc",
      detail,
      outcome: null,
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
    expect(statusesWritten).toEqual(["InProgress", "Abandoned"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason).toMatchObject({ source: "environment_undefined", reason: detail });
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });


  // s-team-roster-m1: no default role works an item no roster role owns. W6: no production path appends
  // a roster revision after the first, so the task is given up and its repair staffs new tasks.
  test("no owner role: given up with a typed owner_unresolved reason, never Failed, no failed approach, no failure router", async () => {
    const detail = "no roster role can work task t: the work item has no owner role; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "owner_unresolved",
      ownerRoleId: null,
      rosterRevision: 1,
      reason: "the work item has no owner role",
      detail,
      outcome: null,
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
    expect(statusesWritten).toEqual(["InProgress", "Abandoned"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason).toEqual({ source: "owner_unresolved", ownerRoleId: null, rosterRevision: 1, reason: "the work item has no owner role" });
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
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    };

    const deps = coreLoopDeps({
      workItemRepo,
      eventStore: { publish: async (event) => void events.push(event.eventType) },
      dispatchService: {
        execute: async () => ({
          status: "checks_stale",
          checkTaskId: CHECK_ID,
          revision: options.revision,
          detail,
          outcome: null,
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

  test("past the bound: the item given up with checks_rewrite_bound stating it; the check task left Completed", async () => {
    const { deps, item, check, events } = buildStaleDeps({ checkTask: completedCheckTask(), revision: 3 });

    await processTask(deps, freshPendingItem());

    expect(item()).toMatchObject({ status: "Abandoned", dispatchCount: 1 });
    expect(events).toContain("work_item.given_up");
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
  ])("%s: the item given up with checks_stale naming why it cannot be reopened", async (_label, checkTask, why) => {
    const { deps, item } = buildStaleDeps({ checkTask, revision: 1 });

    await processTask(deps, freshPendingItem());

    expect(item().status).toBe("Abandoned");
    const reason = item().blockedReason;
    expect(reason).toMatchObject({ source: "checks_stale", checkTaskId: CHECK_ID });
    expect(reason?.source === "checks_stale" ? reason.reason : "").toContain(why);
    expect(parses(reason)).not.toThrow();
  });

  test("the check task moves before its reopen is saved: the item given up with checks_stale, never left waiting", async () => {
    const { deps, item, written } = buildStaleDeps({ checkTask: completedCheckTask(), revision: 1, checkTaskSaveLoses: true });

    await processTask(deps, freshPendingItem());

    expect(written).toEqual([["item", "InProgress"], ["item", "Abandoned"]]);
    expect(item().blockedReason).toMatchObject({ source: "checks_stale", reason: expect.stringContaining("moved to Abandoned") });
  });

});

// docs/investigations/second-run-2026-10-14.md N2: an implementer's correct "these checks cannot pass"
// was routed as the task's own failure and abandoned after 3, stranding its dependents.
describe("a disputed check: the check task is reopened with the dispute and the item waits on it", () => {
  const CHECK_ID: WorkItemId = createWorkItemId();
  const reason = "the check uses [[ ]], which the runner's sh rejects with exit 2 on any work";
  const evidence = 'Check "lists": FAILED: exited 2\n  output: sh: [[: not found';

  /** `merged`: the disputed check is a merged task's, written by a check task the item does not depend on. */
  function buildDisputeDeps(priorDisputes: number, whose: "own" | "merged" = "own") {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const edges: Array<{ readonly from: string; readonly to: string }> = [];
    const mergedTaskId = createWorkItemId();
    const rows = new Map<string, WorkItem>([
      [ITEM_ID, freshPendingItem()],
      [CHECK_ID, { ...freshPendingItem(), id: CHECK_ID, title: "write the checks", workKind: "check", status: "Completed", dispatchCount: 1 }],
    ]);
    const disputes: Array<{ readonly checkTaskId: string; readonly checkName: string; readonly evidence: string | null }> = [];
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
        if (row.status !== expectedPreviousStatus) throw new InvalidStatusTransition(item.id, row.status, item.status);
        rows.set(item.id, { ...copy(item), dispatchCount: row.dispatchCount });
      },
      incrementDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount + 1 });
        return row.dispatchCount + 1;
      },
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: async (from, to) => {
        edges.push({ from, to });
      },
      // The item's own check task is the edge the plan wrote; a merged task's check task is not on it.
      getDependencies: async (id) => (id === ITEM_ID && whose === "own" ? [CHECK_ID] : []),
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    };
    const deps = coreLoopDeps({
      workItemRepo,
      dispatchService: {
        execute: async () => ({
          status: "disputed",
          checksOf: whose === "own" ? ITEM_ID : mergedTaskId,
          checkTaskId: CHECK_ID,
          revision: 1,
          check: { name: "lists", command: "[[ -f out.txt ]] && cat out.txt" },
          reason,
          evidence,
          detail: `check "lists" disputed: ${reason}`,
          outcome: { ...OUTCOME_BASE, turnsUsed: 2, kind: "disputed", checkName: "lists", ofTask: whose === "own" ? null : mergedTaskId, reason, evidence },
          sessionId: "test-session",
          attempt: 1,
          errorEnvelope: {
            outcome: "blocked",
            summary: reason,
            chain: { boundary: "development", operation: "agentAttempt", message: reason, timestamp: new Date().toISOString() },
          },
        }),
      },
      checkDisputes: {
        record: async (dispute) => {
          disputes.push(dispute);
          return priorDisputes + disputes.filter((entry) => entry.checkTaskId === dispute.checkTaskId).length;
        },
      },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    });
    return { deps, item: () => rowOf(ITEM_ID), check: () => rowOf(CHECK_ID), disputes, edges, routed: () => routed, approaches: () => approaches };
  }

  // ADR-074 addendum 2 d74 D: a merged task's check that blocks the item's merge may be disputed.
  test("a dispute of a merged task's check reopens that check's own check task, and the item waits on it by a new edge", async () => {
    const { deps, item, check, edges, routed } = buildDisputeDeps(0, "merged");

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(check().status).toBe("Pending");
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0 });
    expect(edges).toEqual([{ from: ITEM_ID, to: CHECK_ID }]);
    expect(routed()).toBe(0);
  });

  test("a dispute of the item's own check adds no edge: the plan's is there", async () => {
    const { deps, edges } = buildDisputeDeps(0);
    await processTask(deps, freshPendingItem());
    expect(edges).toEqual([]);
  });

  test("a dispute: the check task back at Pending with the dispute and the current check in its brief, the item waiting, no failure counted", async () => {
    const { deps, item, check, disputes, routed, approaches } = buildDisputeDeps(0);

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(disputes).toEqual([expect.objectContaining({ checkTaskId: CHECK_ID, checkName: "lists", evidence })]);
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: undefined });
    expect(check().status).toBe("Pending");
    const context = check().blockedReason;
    expect(context?.source).toBe("replan");
    if (context?.source !== "replan") return;
    expect(context.replanContext.detail).toContain(reason);
    expect(context.replanContext.detail).toContain("[[ -f out.txt ]] && cat out.txt");
    expect(context.replanContext.detail).toContain("sh: [[: not found");
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  // Story s-loop-never-stop-m1 W6 (d76 K = 2): past the bound the item is given up for a plan repair.
  test("the third dispute of a check task: the item given up with check_disputed for a plan repair, the check task left Completed", async () => {
    const { deps, item, check, routed, approaches } = buildDisputeDeps(2);

    await processTask(deps, freshPendingItem());

    expect(item()).toMatchObject({ status: "Abandoned", dispatchCount: 1, blockedReason: { source: "check_disputed", checkTaskId: CHECK_ID, checkName: "lists" } });
    expect(item().blockedReason?.source === "check_disputed" ? item().blockedReason : undefined).toMatchObject({ reason: expect.stringContaining("disputed 3 time(s), past the bound of 2") });
    expect(check().status).toBe("Completed");
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });
});

// docs/investigations/third-run-2026-10-14.md N7: a refused environment edit's only exit was an
// operator editing main. ADR-074 addendum 2 d66 b: Z0 opens an environment task and the item waits.
describe("an environment change requested: an environment task is opened and the item waits on it", () => {
  const ROLE_ID = "55555555-5555-4555-8555-555555555555";
  const detail = "ownership gate refused the work of t: environment/ belongs to the platform role; ...";
  const need = "the greeter needs the jq package in the image";
  const diff = "--- a/environment/Containerfile\n+++ b/environment/Containerfile\n+RUN apk add jq\n";

  function buildEnvironmentChangeDeps(
    priorChanges: number,
    owner: Awaited<ReturnType<CoreLoopDeps["environmentOwner"]>>,
    requester: Pick<WorkItem, "taskSpec"> = {},
    completed: readonly WorkItem[] = [],
  ) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = new Map<string, WorkItem>([[ITEM_ID, { ...freshPendingItem(), ...requester }]]);
    for (const done of completed) rows.set(done.id, done);
    const edges: Array<{ readonly from: string; readonly to: string }> = [];
    for (let n = 1; n <= priorChanges; n++) {
      const prior: WorkItem = {
        ...freshPendingItem(),
        id: createWorkItemId(),
        title: `Environment change ${n} for task ${ITEM_ID}`,
        status: "Completed",
        workKind: "environment",
        taskSpec: { origin: "environment-change", checkedBy: "substrate" },
      };
      rows.set(prior.id, prior);
      edges.push({ from: ITEM_ID, to: prior.id });
    }
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
        if (row.status !== expectedPreviousStatus) throw new InvalidStatusTransition(item.id, row.status, item.status);
        rows.set(item.id, { ...copy(item), dispatchCount: row.dispatchCount });
      },
      create: async (item) => {
        rows.set(item.id, copy(item));
        return copy(item);
      },
      incrementDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount + 1 });
        return row.dispatchCount + 1;
      },
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: async (projectId, status) =>
        [...rows.values()].filter((row) => row.projectId === projectId && row.status === status).map(copy),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: async (from, to) => void edges.push({ from, to }),
      getDependencies: async (id) => edges.filter((edge) => edge.from === id).map((edge) => edge.to as WorkItemId),
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: async (fn) => fn(workItemRepo),
    };
    const deps = coreLoopDeps({
      workItemRepo,
      dispatchService: {
        execute: async () => ({
          status: "environment_change_requested",
          paths: ["environment/Containerfile"],
          need,
          diff,
          detail,
          outcome: { ...COMPLETED_OUTCOME, summary: need },
          sessionId: "test-session",
          attempt: 1,
          errorEnvelope: {
            outcome: "blocked",
            summary: detail,
            chain: { boundary: "development", operation: "ownershipGate", message: detail, timestamp: new Date().toISOString() },
          },
        }),
      },
      environmentOwner: async () => owner,
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    });
    const opened = () => [...rows.values()].filter((row) => row.id !== ITEM_ID && row.status === "Pending");
    return { deps, item: () => rowOf(ITEM_ID), opened, edges, routed: () => routed, approaches: () => approaches };
  }

  test("within the bound: a Pending environment task owned by the environment role, with the need and the diff; the item waits on it, its dispatch given back", async () => {
    const { deps, item, opened, edges, routed, approaches } = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: undefined });
    const [environment] = opened();
    expect(opened()).toHaveLength(1);
    expect(environment).toMatchObject({
      level: "Task",
      workKind: "environment",
      ownerRoleId: ROLE_ID,
      projectId: TEST_PROJECT_ID,
      title: `Environment change 1 for task ${ITEM_ID}`,
      taskSpec: { origin: "environment-change", checkedBy: "substrate" },
    });
    expect(environment?.taskSpec?.scope).toContain(need);
    expect(environment?.taskSpec?.scope).toContain("+RUN apk add jq");
    expect(edges).toEqual([{ from: ITEM_ID, to: environment?.id }]);
    expect(environment?.taskSpec?.product).toBe("present");
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  // The t-env-recipe review: the scaffold's own environment change ran the product's build and test
  // on a main with no product, failed, and stalled every task behind the scaffold.
  test("asked by the product scaffold before any scaffold completed: the environment task records no product on main", async () => {
    const scaffold: Pick<WorkItem, "taskSpec"> = { taskSpec: { origin: "product-scaffold", checkedBy: "substrate" } };
    const { deps, opened } = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID }, scaffold);

    await processTask(deps, { ...freshPendingItem(), ...scaffold });

    expect(opened()).toHaveLength(1);
    expect(opened()[0]?.taskSpec).toMatchObject({ origin: "environment-change", product: "absent" });
  });

  test("asked by the product scaffold after an earlier scaffold completed: the product is on main", async () => {
    const scaffold: Pick<WorkItem, "taskSpec"> = { taskSpec: { origin: "product-scaffold", checkedBy: "substrate" } };
    const earlier: WorkItem = { ...freshPendingItem(), id: createWorkItemId(), status: "Completed", ...scaffold };
    const { deps, opened } = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID }, scaffold, [earlier]);

    await processTask(deps, { ...freshPendingItem(), ...scaffold });

    expect(opened()[0]?.taskSpec?.product).toBe("present");
  });

  test("past the bound of two: given up with environment_change_needed naming the paths; no third environment task", async () => {
    const { deps, item, opened, routed, approaches } = buildEnvironmentChangeDeps(2, { kind: "role", roleId: ROLE_ID });

    await processTask(deps, freshPendingItem());

    expect(opened()).toEqual([]);
    expect(item().status).toBe("Abandoned");
    const reason = item().blockedReason;
    expect(reason).toMatchObject({ source: "environment_change_needed", paths: ["environment/Containerfile"] });
    if (reason?.source !== "environment_change_needed") return;
    expect(reason.reason).toContain("the bound of 2");
    expect(reason.reason).toContain(need);
    expect(() => parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason })).not.toThrow();
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  // Orchestrator D3: a roster read error was folded into "no owner", and the task was given up.
  test("a roster that cannot be read: Ashara's fault, back to Pending with the dispatch refunded, never given up", async () => {
    const built = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID });
    const { item, opened, routed, approaches } = built;
    let faults = 0;
    built.deps.workItemRepo.recordInfrastructureFault = async () => ++faults;
    const deps: CoreLoopDeps = {
      ...built.deps,
      environmentOwner: async () => {
        throw new Error("roster query failed");
      },
    };

    await processTask(deps, freshPendingItem());

    expect(opened()).toEqual([]);
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0 });
    expect(faults).toBe(1);
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  test("no role does environment work: given up with environment_change_needed saying why; nothing opened", async () => {
    const { deps, item, opened } = buildEnvironmentChangeDeps(0, { kind: "none", why: "no role holds write-environment" });

    await processTask(deps, freshPendingItem());

    expect(opened()).toEqual([]);
    expect(item()).toMatchObject({ status: "Abandoned", blockedReason: { source: "environment_change_needed" } });
    expect(JSON.stringify(item().blockedReason)).toContain("no role holds write-environment");
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
    const blocks: Array<{ readonly projectId: string; readonly category: string; readonly errorClass: string; readonly reason: string }> = [];
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
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: async () => {
        row = { ...row, dispatchCount: row.dispatchCount - 1 };
        return row.dispatchCount;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    };

    const deps = coreLoopDeps({
      workItemRepo,
      dispatchService: {
        execute: async (task) => {
          attempts.push(task.attempt);
          return scope === "shutdown"
            ? { status: "interrupted", detail: "attempt interrupted by shutdown after 2 turn(s)", outcome: { ...OUTCOME_BASE, turnsUsed: 2, kind: "cancelled", reason: new Error("shutdown") }, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope }
            : { status: "refused", refusal, detail: `attempt stopped after 2 turn(s): ${refusal.message}`, outcome: { ...OUTCOME_BASE, turnsUsed: 2, kind: "refused", error: refusal }, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope };
        },
      },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
      projectRepo: {
        get: async () => ({ workspacePath: UNMERGED_TARGET }),
        recordWorkspacePath: notExercised("recordWorkspacePath"),
        listActiveIds: notExercised("listActiveIds"),
        block: async (projectId, cause) => {
          blocks.push({ projectId, ...cause });
          return "blocked";
        },
        listInfrastructureHalted: notExercised("listInfrastructureHalted"),
        resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
        blockAllActive: notExercised("blockAllActive"),
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
    expect(blocks).toEqual([{ projectId: TEST_PROJECT_ID, category: "configuration", errorClass: "UnpricedModel", reason: expect.stringContaining("is unpriced") }]);
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

// t-stop-report-from-merge-record: what the client is told was merged comes from the work item's
// merge record, written before the task is completed.
describe("a completed dispatch records its merge before the task is Completed", () => {
  type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["dispatchService"]["execute"]>>;

  function buildMergeDeps(execResult: ExecutionResult, mergeWrite: (commit: string) => Promise<void>): {
    deps: CoreLoopDeps;
    stored: () => WorkItem;
    writes: string[];
  } {
    let row = freshPendingItem();
    const writes: string[] = [];
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const workItemRepo: WorkItemRepository = {
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) {
          throw new Error(`pre-image mismatch: stored ${row.status}, expected ${expectedPreviousStatus}`);
        }
        writes.push(item.status);
        row = copy(item);
      },
      recordMergeCommit: async (_id, commit) => {
        await mergeWrite(commit);
        writes.push(`merge ${commit}`);
      },
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      incrementDispatchCount: async () => 1,
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: notExercised("refundDispatchCount"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    };
    const deps = coreLoopDeps({ workItemRepo, dispatchService: { execute: async () => execResult } });
    return { deps, stored: () => row, writes };
  }

  const merged: ExecutionResult = {
    status: "completed",
    delivered: { kind: "merged", mergeCommit: MERGE_COMMIT },
    detail: "task completed and verified successfully",
    outcome: COMPLETED_OUTCOME,
    sessionId: "test-session",
    attempt: 1,
  };

  // Orchestrator D1: the Completed transition commits before its events publish; a failed publish
  // after it routed a merged, Completed task as failed and wrote a false lesson.
  test("a publish that fails after the task is Completed: still completed, no lesson", async () => {
    const built = buildMergeDeps(merged, async () => {});
    const { stored, writes } = built;
    let approaches = 0;
    const deps: CoreLoopDeps = {
      ...built.deps,
      failedApproachRepo: { record: async () => { approaches++; } },
      eventStore: {
        publish: async () => {
          throw new Error("domain_events insert failed");
        },
      },
    };

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", `merge ${MERGE_COMMIT}`, "Completed"]);
    expect(stored().status).toBe("Completed");
    expect(approaches).toBe(0);
  });

  test("the merge commit is recorded, then the task is Completed", async () => {
    const { deps, stored, writes } = buildMergeDeps(merged, async () => {});

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", `merge ${MERGE_COMMIT}`, "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  test("a merge-record write that fails transiently is retried, then the task is Completed", async () => {
    let attempts = 0;
    const { deps, stored, writes } = buildMergeDeps(merged, async () => {
      attempts++;
      if (attempts < 3) throw new Error("connection reset while writing merge_commit");
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(attempts).toBe(3);
    expect(writes).toEqual(["InProgress", `merge ${MERGE_COMMIT}`, "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  // t-exec-timeout-orphans: the write used to throw out of processTask and leave the item
  // InProgress, which the startup reconciler requeues: merged work dispatched again.
  test("a merge-record write that keeps failing: not Completed, not InProgress, Blocked naming the merge commit", async () => {
    let attempts = 0;
    const { deps, stored, writes } = buildMergeDeps(merged, async () => {
      attempts++;
      throw new Error("connection reset while writing merge_commit");
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(attempts).toBe(3);
    expect(writes).toEqual(["InProgress", "Blocked"]);
    const reason = stored().blockedReason;
    expect(reason?.source).toBe("merge_unrecorded");
    if (reason?.source !== "merge_unrecorded") return;
    expect(reason.mergeCommit).toBe(MERGE_COMMIT);
    expect(reason.reason).toContain("connection reset while writing merge_commit");
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });

  // The 400-seed deep soak (2026-10-15, two projects, seed 163): the Completed update after a
  // recorded merge drew a serialization failure, reached processTask as Ashara's fault and was
  // requeued, so merged work was dispatched again.
  function failingCompletion(failures: number) {
    const built = buildMergeDeps(merged, async () => {});
    let failed = 0;
    const repo = built.deps.workItemRepo;
    const deps: CoreLoopDeps = {
      ...built.deps,
      workItemRepo: {
        ...repo,
        save: async (item, previous) => {
          if (item.status === "Completed" && failed < failures) {
            failed++;
            throw new Error("could not serialize access due to concurrent update");
          }
          await repo.save(item, previous);
        },
      },
    };
    return { ...built, deps };
  }

  test("a Completed update that fails transiently after the merge is retried, never requeued", async () => {
    const { deps, stored, writes } = failingCompletion(1);

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", `merge ${MERGE_COMMIT}`, "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  test("a Completed update that keeps failing after the merge: Blocked merge_unrecorded, never Pending", async () => {
    const { deps, stored, writes } = failingCompletion(Number.POSITIVE_INFINITY);

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(writes).toEqual(["InProgress", `merge ${MERGE_COMMIT}`, "Blocked"]);
    expect(stored().blockedReason).toMatchObject({ source: "merge_unrecorded", mergeCommit: MERGE_COMMIT, mergeKind: "merged" });
  });

  test("a check task merges nothing, so no merge is recorded for it", async () => {
    const { deps, stored, writes } = buildMergeDeps(
      { ...merged, delivered: { kind: "checks-recorded", revision: 1 } },
      notExercised("recordMergeCommit"),
    );

    await processTask(deps, freshPendingItem());

    expect(writes).toEqual(["InProgress", "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  // ADR-074 addendum 2 d67 b: work already on main is closed by its checks, with main's commit as its record.
  test("work already delivered records main's commit its checks passed on, then the task is Completed", async () => {
    const mainCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const { deps, stored, writes } = buildMergeDeps({ ...merged, delivered: { kind: "already-delivered", mainCommit } }, async () => {});

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", `merge ${mainCommit}`, "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  // ADR-074 addendum 2 d71 c: a clean review completes, which releases the plan's implementations.
  test("a clean review of the plan's suites merges nothing and completes the review task", async () => {
    const { deps, stored, writes } = buildMergeDeps(
      { ...merged, outcome: null, delivered: { kind: "suites-reviewed", reviewed: ["check-a", "check-b"] } },
      notExercised("recordMergeCommit"),
    );

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", "Completed"]);
    expect(stored().status).toBe("Completed");
  });
});

// docs/investigations/fifth-run-2026-10-14.md N20: 36 stored checks no product could all pass reached
// the implementers. ADR-074 addendum 2 d71 c: a review reads them together before any implementation.
describe("a review of the plan's suites with problems: the named check tasks are reopened and the review waits", () => {
  const CHECK_A: WorkItemId = createWorkItemId();
  const CHECK_B: WorkItemId = createWorkItemId();
  const CHECK_C: WorkItemId = createWorkItemId();
  const problem = "a prints a column count on stdout, b requires stdout to hold only the report";
  const problems = [{ checkTaskIds: [CHECK_A, CHECK_B], kind: "contradiction" as const, problem, evidence: "a: wc; b: diff" }];

  function buildReviewDeps(priorReviews: number) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const check = (id: WorkItemId, checksFor: string): WorkItem => ({
      ...freshPendingItem(),
      id,
      title: `write the checks ${checksFor}`,
      workKind: "check",
      status: "Completed",
      dispatchCount: 1,
      taskSpec: { origin: "check", checksFor },
    });
    const rows = new Map<string, WorkItem>([
      [ITEM_ID, { ...freshPendingItem(), workKind: "check", taskSpec: { origin: "review", visionItems: ["In: monthly totals"] } }],
      [CHECK_A, check(CHECK_A, "impl-a")],
      [CHECK_B, check(CHECK_B, "impl-b")],
      [CHECK_C, check(CHECK_C, "impl-c")],
    ]);
    const recorded: Array<{ readonly reviewTaskId: string; readonly problems: readonly unknown[] }> = [];
    const named = new Map<string, number>();
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
        if (row.status !== expectedPreviousStatus) throw new InvalidStatusTransition(item.id, row.status, item.status);
        rows.set(item.id, { ...copy(item), dispatchCount: row.dispatchCount });
      },
      incrementDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount + 1 });
        return row.dispatchCount + 1;
      },
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      refundDispatchCount: async (id) => {
        const row = rowOf(id);
        rows.set(id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      recordMergeCommit: notExercised("recordMergeCommit"),
      create: notExercised("create"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      addDependency: notExercised("addDependency"),
      getDependencies: async () => [],
      findChildren: async () => [],
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: async (fn) => fn(workItemRepo),
    };
    const deps = coreLoopDeps({
      workItemRepo,
      dispatchService: {
        execute: async () => ({
          status: "suite_review_problems",
          problems,
          detail: "the review found 1 problem(s)",
          outcome: null,
          sessionId: "test-session",
          attempt: 1,
          errorEnvelope: {
            outcome: "blocked",
            summary: "the review found 1 problem(s)",
            chain: { boundary: "development", operation: "reviewSuites", message: "problems", timestamp: new Date().toISOString() },
          },
        }),
      },
      suiteReviewFindings: {
        record: async (findings) => {
          recorded.push(findings);
          const ids = [...new Set(findings.problems.flatMap((p) => p.checkTaskIds))];
          for (const id of ids) named.set(id, (named.get(id) ?? priorReviews) + 1);
          return { timesNamed: new Map(ids.map((id) => [id, named.get(id) ?? 0])), earlierFindings: new Map(ids.map((id) => [id, []])) };
        },
      },
      failedApproachRepo: { record: async () => { approaches++; } },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    });
    return { deps, rowOf, recorded, routed: () => routed, approaches: () => approaches };
  }

  test("each named check task is reopened with the problem; the review is back at Pending to run again after them", async () => {
    const { deps, rowOf, recorded, routed, approaches } = buildReviewDeps(0);

    const result = await processTask(deps, rowOf(ITEM_ID));

    expect(result.status).toBe("blocked");
    expect(recorded).toEqual([expect.objectContaining({ reviewTaskId: ITEM_ID, problems })]);
    expect(rowOf(ITEM_ID)).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: undefined });
    expect([rowOf(CHECK_A).status, rowOf(CHECK_B).status, rowOf(CHECK_C).status]).toEqual(["Pending", "Pending", "Completed"]);
    const context = rowOf(CHECK_A).blockedReason;
    expect(context?.source).toBe("replan");
    if (context?.source !== "replan") return;
    expect(context.replanContext.detail).toContain(problem);
    expect(context.replanContext.detail).toContain(`It also involves the checks of check task(s) ${CHECK_B}.`);
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  // Story s-loop-never-stop-m1 W6: past the bound the review is given up and the plan repaired.
  test("a check task named past the bound: the review given up with suite_review_unresolved, nothing reopened", async () => {
    const { deps, rowOf, routed, approaches } = buildReviewDeps(2);

    await processTask(deps, rowOf(ITEM_ID));

    expect(rowOf(ITEM_ID)).toMatchObject({ status: "Abandoned", blockedReason: { source: "suite_review_unresolved", checkTaskIds: [CHECK_A, CHECK_B] } });
    const reason = rowOf(ITEM_ID).blockedReason;
    expect(reason?.source === "suite_review_unresolved" ? reason.reason : "").toContain(problem);
    expect([rowOf(CHECK_A).status, rowOf(CHECK_B).status]).toEqual(["Completed", "Completed"]);
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });
});
