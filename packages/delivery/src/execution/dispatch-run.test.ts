import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi, afterEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import { parseWorkItemJsonb } from "../work-item-language/work-item-row.js";
import type { ProjectBlockCause } from "../project-halt.js";
import { startWorkItem, takeEvents } from "../domain/index.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { ContextBudgetExceeded } from "../acl/finance-acl.js";
import { toRecordedOutcome } from "../acl/workplace-acl.js";
import type { Outcome } from "../acl/workplace-acl.js";
import { inertWorkItemRepo, itemLockOver } from "../domain/testing.js";
import { handleProcessingError, processTask } from "./dispatch-run.js";
import { GiveUpMisrouted } from "./give-up-causes.js";
import type { GiveUpCause } from "./give-up-causes.js";
import { routeAsGivenUp } from "./reopen-routes.js";
import { routingDepsOf } from "./routing-deps.js";
import type { DispatchLoop, DispatchRunDeps, TaskDispatchSteps } from "./dispatch-run-deps.js";

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
const COMPLETED_OUTCOME: Outcome = { ...OUTCOME_BASE, kind: "finished", status: "done", summary: "done", blockedReason: null, blockedOn: null, statement: null };

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

/**
 * What a faulted dispatch leaves when it never released its checkout: the task's branch, holding a
 * commit main never took, checked out in its worktree slot under the workdir base. The returned
 * read gives both back.
 */
function heldCheckout(target: string, taskId: string): () => { readonly branch: string; readonly worktree: boolean } {
  const workDir = join(tmpdir(), `task-${taskId}`);
  targets.push(workDir);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git(target, "worktree", "add", "-q", workDir, "-b", `task/${taskId}`, "main");
  git(workDir, "commit", "-q", "--allow-empty", "-m", "the agent's work");
  return () => ({ branch: git(target, "branch", "--list", "--format=%(refname:short)", `task/${taskId}`), worktree: existsSync(workDir) });
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
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: "implementation",
    repairsTaskId: null,
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

/** The members of each group of processTask's deps a test supplies in place of the inert ones. */
type DispatchRunOverrides = { readonly [Group in keyof DispatchRunDeps]?: Partial<DispatchRunDeps[Group]> };

function withDispatchOverrides(base: DispatchRunDeps, overrides: DispatchRunOverrides): DispatchRunDeps {
  return { loop: { ...base.loop, ...overrides.loop }, dispatch: { ...base.dispatch, ...overrides.dispatch } };
}

/**
 * processTask's deps: every target under the temporary directory and its main holding no merge, and
 * every other member throwing NotExercised; `overrides` supply the work items, the dispatch and each
 * other member a test exercises.
 */
function dispatchRunDeps(
  overrides: DispatchRunOverrides & { readonly loop: Pick<DispatchLoop, "workItemRepo">; readonly dispatch: Pick<TaskDispatchSteps, "dispatchService"> },
): DispatchRunDeps {
  const processing: DispatchRunDeps = {
    loop: {
      config: { workdirBase: tmpdir() },
      logger: recordingLogger(),
      workItemRepo: inertWorkItemRepo(),
      eventStore: { publish: async () => {} },
      projectRepo: {
        get: async () => ({ workspacePath: UNMERGED_TARGET }),
        recordWorkspacePath: notExercised("recordWorkspacePath"),
        block: notExercised("block"),
      },
      spendCap: { refusalOf: () => null },
    },
    dispatch: {
      dispatchService: { execute: notExercised("dispatchService.execute") },
      failedApproachRepo: { record: async () => {} },
      failureRouter: { route: notExercised("failureRouter.route") },
      checkDisputes: { record: notExercised("checkDisputes.record") },
      suiteReviewFindings: { record: notExercised("suiteReviewFindings.record") },
      checkSetFreeze: { freezeFor: async () => [] },
      environmentOwner: notExercised("environmentOwner"),
      clientQuestions: { ask: notExercised("clientQuestions.ask"), answered: notExercised("clientQuestions.answered") },
    },
  };
  return withDispatchOverrides(processing, overrides);
}

/**
 * Builds a DispatchRunDeps mock where the workItemRepo returns a Pending item on
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
  deps: DispatchRunDeps;
  logger: ReturnType<typeof recordingLogger>;
  savedBlockedReasons: StoredBlockedReason[];
  mergeRecords: Array<{ id: WorkItemId; commit: string }>;
} {
  const agentOutcome = options?.agentOutcome ?? "failed";
  const logger = recordingLogger();
  const savedBlockedReasons: StoredBlockedReason[] = [];
  const mergeRecords: Array<{ id: WorkItemId; commit: string }> = [];

  let findByIdCalls = 0;
  const workItemRepo: WorkItemRepository = inertWorkItemRepo({
    findById: async (_id: WorkItemId) => {
      findByIdCalls++;
      if (findByIdCalls === 1) return freshPendingItem();
      return freshAbandonedItem({ omitBlockedReason: options?.omitBlockedReason });
    },
    save: async (item: WorkItem) => {
      // Capture the blockedReason written by the salvage path
      if (item.blockedReason) savedBlockedReasons.push(item.blockedReason);
    },
    incrementDispatchCount: async () => 1,
    saveRefundedOverflow: async () => 0,
    recordCrashOrphan: async () => 1,
    recordMergeCommit: async (id, commit) => {
      mergeRecords.push({ id, commit });
    },
    getDependencies: async () => [],
    findChildren: async () => [],
  });

  const deps = dispatchRunDeps({ loop: { workItemRepo, logger }, dispatch: { dispatchService: {
      execute: async () =>
        agentOutcome === "completed"
          ? {
              status: agentOutcome,
              delivered: { kind: "merged", mergeCommit: MERGE_COMMIT },
              detail: "merged on main, after its post-merge checks passed on the merged tree",
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
    } } });

  return { deps, logger, savedBlockedReasons, mergeRecords };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processTask attempt scope", () => {
  test("the dispatched attempt runs in a new trace, its parent the cycle's, every record of it carrying its task and attempt", async () => {
    const { deps: base } = buildPreemptionDeps();
    const logger = recordingLogger();
    const deps: DispatchRunDeps = withDispatchOverrides(base, { loop: { logger }, dispatch: { dispatchService: {
        execute: async (...args) => {
          logger.warn("test.in-dispatch", "a record of the attempt");
          return base.dispatch.dispatchService.execute(...args);
        },
      } } });

    const cycleTrace = await logger.scope({ cycle: 4, trace: "new" }, async () => {
      await processTask(deps, freshPendingItem());
      return logger.trace();
    });

    const [inDispatch] = logger.records.filter((record) => record.event === "test.in-dispatch");
    expect(inDispatch).toMatchObject({ taskId: ITEM_ID, attempt: 1, projectId: TEST_PROJECT_ID, cycle: 4, parentTraceId: cycleTrace });
    expect(inDispatch?.traceId).not.toBe(cycleTrace);
  });
});

describe("processTask post-agent status ladder", () => {
  test("preempted-to-Abandoned item with failed result salvages the result", async () => {
    const { deps, logger, savedBlockedReasons } = buildPreemptionDeps();
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    // The function must return the agent's result, not throw
    expect(result.status).toBe("failed");

    // The salvage must produce a structured record (Discipline C)
    const salvaged = logger.records.find((r) => r.event === "delivery.result-salvaged");
    expect(salvaged).toMatchObject({ level: "info", fields: { taskId: ITEM_ID, outcome: "failed" } });

    // The blockedReason must carry the salvaged fields after save
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("failed");
    expect(lastSaved.salvagedDetail).toBeDefined();
    expect(lastSaved.salvagedAt).toBeDefined();
  });

  test("preempted-to-Abandoned item with completed result salvages the result", async () => {
    const { deps, logger, savedBlockedReasons, mergeRecords } = buildPreemptionDeps({
      agentOutcome: "completed",
    });
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    // The completed agent result is still returned
    expect(result.status).toBe("completed");
    // The merge happened on main, so its record is kept although the item was preempted.
    expect(mergeRecords).toEqual([{ id: ITEM_ID, commit: MERGE_COMMIT }]);

    // The salvage must produce a structured record
    const salvaged = logger.records.find((r) => r.event === "delivery.result-salvaged");
    expect(salvaged).toMatchObject({ level: "info", fields: { taskId: ITEM_ID, outcome: "completed" } });

    // The blockedReason must carry the salvaged outcome
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("completed");
    expect(typeof lastSaved.salvagedAt).toBe("string");
  });

  test("Abandoned item with no prior blockedReason still salvages the result", async () => {
    const { deps, logger, savedBlockedReasons } = buildPreemptionDeps({
      omitBlockedReason: true,
    });
    const task = freshPendingItem();

    const result = await processTask(deps, task);

    expect(result.status).toBe("failed");

    // The missing blockedReason is a lost invariant, recorded at error (Discipline C)
    const gap = logger.records.find((r) => r.event === "delivery.blocked-reason-missing");
    expect(gap).toMatchObject({ level: "error", fields: { taskId: ITEM_ID } });

    // The salvage must still succeed — the result must not be lost
    const salvaged = logger.records.find((r) => r.event === "delivery.result-salvaged");
    expect(salvaged).toMatchObject({ fields: { outcome: "failed" } });

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
    const { deps, logger } = buildPreemptionDeps();

    // Override findById to return null after the first call
    let calls = 0;
    deps.loop.workItemRepo.findById = async () => {
      calls++;
      if (calls === 1) return freshPendingItem();
      return null;
    };

    const task = freshPendingItem();
    const result = await processTask(deps, task);

    expect(result.status).toBe("failed");

    const vanished = logger.records.find((r) => r.event === "delivery.item-vanished");
    expect(vanished).toMatchObject({ level: "warn", fields: { taskId: ITEM_ID, result: "failed" } });
    expect(vanished?.msg).toContain("agent spend unrecoverable");
  });
});

describe("an environment-blocked dispatch: an infrastructure fault requeues uncharged, other environment outcomes park", () => {
  type ExecutionResult = Awaited<ReturnType<TaskDispatchSteps["dispatchService"]["execute"]>>;

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
    deps: DispatchRunDeps;
    stored: () => WorkItem;
    statusesWritten: string[];
    failureRoutes: () => number;
    failedApproaches: () => number;
    refunds: () => number;
    halts: ProjectBlockCause[];
    faults: () => number;
    logger: ReturnType<typeof recordingLogger>;
  } {
    let row = freshPendingItem();
    const statusesWritten: string[] = [];
    let routed = 0;
    let approaches = 0;
    let faults = faultsBefore;
    let refunded = 0;
    const halts: ProjectBlockCause[] = [];
    const logger = recordingLogger();
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });

    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) {
          throw new Error(`pre-image mismatch: stored ${row.status}, expected ${expectedPreviousStatus}`);
        }
        statusesWritten.push(item.status);
        row = copy(item);
      },
      incrementDispatchCount: async () => 1,
      withItemLocked: itemLockOver(async () => copy(row), {
        recordInfrastructureFault: async () => ++faults,
        blockProject: async (_projectId, cause) => {
          halts.push(cause);
          return "blocked";
        },
      }),
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        refunded++;
        return 0;
      },
      getDependencies: async () => [],
      findChildren: async () => [],
    });

    const base = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: { execute: async () => execResult } } });
    const deps = dispatchRunDeps({ loop: { workItemRepo, logger, projectRepo: {
        ...base.loop.projectRepo,
        block: async (_projectId, cause) => {
          halts.push(cause);
          return "blocked";
        },
      } }, dispatch: { dispatchService: { execute: async () => execResult }, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });

    return { deps, stored: () => row, statusesWritten, failureRoutes: () => routed, failedApproaches: () => approaches, refunds: () => refunded, halts, faults: () => faults, logger };
  }

  // A turn that did not fit its model's window meets the same window
  // on that model every time, so it is never Failed, never a lesson, never retried on that model.
  describe("a turn that did not fit its model's window", () => {
    const contextExceeded = (wider: { provider: string; modelId: string; windowTokens: number } | null): ExecutionResult => ({
      status: "context_exceeded",
      model: { provider: "p", modelId: "small-model" },
      windowTokens: 32_000,
      outputReserveTokens: 16_384,
      projectedInputTokens: 20_000,
      providerMessage: null,
      wider,
      detail: "turn 2 did not fit the 32000-token window of p/small-model",
      outcome: {
        ...OUTCOME_BASE,
        kind: "context_budget_exceeded",
        turn: 2,
        source: "preflight",
        error: new ContextBudgetExceeded({
          provider: "p",
          model: "small-model",
          windowTokens: 32_000,
          outputReserveTokens: 16_384,
          breach: { source: "preflight", projectedInputTokens: 20_000, basis: "estimated" },
        }),
      },
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "context", chain: { boundary: "development", operation: "agentAttempt", message: "context", timestamp: new Date().toISOString() } },
    });

    test("with a larger-window model: the window recorded and back to Pending, its dispatch given back; never Failed, no lesson, no failure router; the next dispatch carries the window", async () => {
      const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps(
        contextExceeded({ provider: "p", modelId: "wide-model", windowTokens: 200_000 }),
      );
      const recorded: number[] = [];
      const repo = deps.loop.workItemRepo;
      repo.saveRefundedOverflow = async (item, expectedPreviousStatus, windowTokens) => {
        recorded.push(windowTokens);
        return repo.saveRefunded(item, expectedPreviousStatus);
      };

      const result = await processTask(deps, freshPendingItem());

      expect(result.status).toBe("blocked");
      expect(recorded).toEqual([32_000]);
      expect(stored().status).toBe("Pending");
      expect(statusesWritten).toEqual(["InProgress", "Pending"]);
      expect(statusesWritten).not.toContain("Failed");
      expect(refunds()).toBe(1);
      expect(failureRoutes()).toBe(0);
      expect(failedApproaches()).toBe(0);

      const dispatched: Array<number | null> = [];
      const again: DispatchRunDeps = withDispatchOverrides(deps, { dispatch: { dispatchService: {
          execute: async (task) => {
            dispatched.push(task.overflowedWindowTokens);
            return contextExceeded(null);
          },
        } } });
      await processTask(again, { ...stored(), overflowedWindowTokens: 32_000 });
      expect(dispatched).toEqual([32_000]);
    });

    test("with none larger: given up naming the model, the window and the estimate; never Failed, no lesson, no failure router", async () => {
      const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps(contextExceeded(null));
      deps.loop.workItemRepo.saveRefundedOverflow = async () => {
        throw new Error("no window is recorded when nothing larger exists");
      };

      await processTask(deps, freshPendingItem());

      expect(stored().status).toBe("Abandoned");
      expect(statusesWritten).toEqual(["InProgress", "Abandoned"]);
      expect(stored().blockedReason).toMatchObject({
        source: "context_window_exceeded",
        provider: "p",
        model: "small-model",
        windowTokens: 32_000,
        outputReserveTokens: 16_384,
        projectedInputTokens: 20_000,
      });
      expect(failureRoutes()).toBe(0);
      expect(failedApproaches()).toBe(0);
    });

    // The catalog changed since the overflow found a wider model. Every re-dispatch
    // meets the same catalog, so the task is given up typed; it is no fault of Ashara's to requeue
    // and count toward a project halt.
    test("no catalog model wider than a recorded overflow: given up as no_wider_model, its dispatch given back; no requeue, no fault counted, no halt", async () => {
      const noWider: ExecutionResult = {
        status: "no_wider_model",
        overflowedWindowTokens: 32_000,
        detail: "an attempt overflowed a context window of 32000 tokens, and no catalog model graded for it has a larger one",
        outcome: null,
        sessionId: "test-session",
        attempt: 1,
        errorEnvelope: { outcome: "blocked", summary: "no wider", chain: { boundary: "development", operation: "assignAgent", message: "no wider", timestamp: new Date().toISOString() } },
      };
      const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds, halts, faults } = buildEnvironmentBlockedDeps(noWider);

      const result = await processTask(deps, { ...freshPendingItem(), overflowedWindowTokens: 32_000 });

      expect(result.status).toBe("blocked");
      expect(stored().status).toBe("Abandoned");
      expect(statusesWritten).toEqual(["InProgress", "Abandoned"]);
      expect(stored().blockedReason).toMatchObject({ source: "no_wider_model", overflowedWindowTokens: 32_000 });
      expect(refunds()).toBe(1);
      expect(faults()).toBe(0);
      expect(halts).toEqual([]);
      expect(failureRoutes()).toBe(0);
      expect(failedApproaches()).toBe(0);
    });
  });

  // One transient fault must not park a task for a person.
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

  // A fault under the refund itself must not charge the task for Ashara's own fault.
  test("a refund whose write faults leaves the task uncharged: the requeue and its refund fail together and the recovery writes both", async () => {
    let row = freshPendingItem();
    // The routing in executeTask and processTask's retry of it both fault: only the cycle's recovery is left to write it.
    let refundFaults = 2;
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) throw new InvalidStatusTransition(item.id, row.status, item.status);
        row = { ...copy(item), dispatchCount: row.dispatchCount };
      },
      incrementDispatchCount: async () => {
        row = { ...row, dispatchCount: row.dispatchCount + 1 };
        return row.dispatchCount;
      },
      withItemLocked: itemLockOver(async () => copy(row), { recordInfrastructureFault: async () => 1, blockProject: notExercised("blockProject") }),
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        // The one transaction rolled back: neither the requeue nor the refund was written.
        if (refundFaults-- > 0) throw new Error("Failed query: update \"work_items\" set \"dispatch_count\" = \"work_items\".\"dispatch_count\" - 1");
        await workItemRepo.save(item, expectedPreviousStatus);
        row = { ...row, dispatchCount: row.dispatchCount - 1 };
        return row.dispatchCount;
      },
      getDependencies: async () => [],
      findChildren: async () => [],
    });
    const deps = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: { execute: async () => probeBlocked } } });
    const task = freshPendingItem();

    // The cycle's own path: a rejected processTask is recovered by handleProcessingError (core-loop.ts).
    const result = await processTask(deps, task).catch((e: unknown) => handleProcessingError(deps, task, e));

    expect(result.status).toBe("interrupted");
    expect(row).toMatchObject({ status: "Pending", dispatchCount: 0 });
    expect(refundFaults).toBe(-1);
  });

  // A fault after the merge commit (`git rev-parse HEAD` failing) is Ashara's, and the merged task
  // must not be requeued for it.
  test("a fault after its merge reached main: the merge recorded and the task Completed, never requeued; its worktree and branch are gone", async () => {
    const { deps, stored, statusesWritten, refunds } = buildEnvironmentBlockedDeps();
    const main = targetWithMain([`merge: task ${ITEM_ID}`]);
    const left = heldCheckout(main.path, ITEM_ID);
    deps.loop.projectRepo.get = async () => ({ workspacePath: main.path });
    const records: string[] = [];
    deps.loop.workItemRepo.recordMergeCommit = async (_id, commit, kind) => void records.push(`${commit}:${kind ?? "null"}`);

    await processTask(deps, freshPendingItem());

    expect(records).toEqual([`${main.head}:merged`]);
    expect(statusesWritten).toEqual(["InProgress", "Completed"]);
    expect(stored().status).toBe("Completed");
    expect(refunds()).toBe(0);
    expect(left()).toEqual({ branch: "", worktree: false });
  });

  test("a fault after its merge reached main and its completion lost to a concurrent write: its worktree and branch are released all the same", async () => {
    const { deps, stored } = buildEnvironmentBlockedDeps();
    const main = targetWithMain([`merge: task ${ITEM_ID}`]);
    const left = heldCheckout(main.path, ITEM_ID);
    deps.loop.projectRepo.get = async () => ({ workspacePath: main.path });
    deps.loop.workItemRepo.recordMergeCommit = async () => undefined;
    const save = deps.loop.workItemRepo.save.bind(deps.loop.workItemRepo);
    deps.loop.workItemRepo.save = async (item, previous) => {
      if (item.status === "Completed") throw new InvalidStatusTransition(item.id, "Abandoned", "Completed");
      return save(item, previous);
    };

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("InProgress");
    expect(left()).toEqual({ branch: "", worktree: false });
  });

  test("a fault before the target's repository exists: it holds no merge, so the fault is routed as one and the task requeued", async () => {
    const { deps, stored, refunds, halts } = buildEnvironmentBlockedDeps();
    const parent = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(parent);
    deps.loop.projectRepo.get = async () => ({ workspacePath: join(parent, "never-created") });

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("Pending");
    expect(refunds()).toBe(1);
    expect(halts).toEqual([]);
  });

  // A transient fault under the read of main is retried within the task's infrastructure fault
  // budget: kept off Pending, never completed nor requeued on an unread main, and no halt within it.
  test("main unreadable after a fault, within the budget: Blocked orphan_unreconciled and the fault counted, no halt, never requeued blind", async () => {
    const { deps, stored, halts, faults, refunds } = buildEnvironmentBlockedDeps();
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    deps.loop.projectRepo.get = async () => ({ workspacePath: unreadable });

    await processTask(deps, freshPendingItem());

    expect(stored()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", faultClass: "ashara" } });
    expect(faults()).toBe(1);
    expect(refunds()).toBe(0);
    expect(halts).toEqual([]);
  });

  test("main unreadable after a fault past the budget: Blocked orphan_unreconciled with the project halted on Ashara's own fault", async () => {
    const { deps, stored, halts, faults } = buildEnvironmentBlockedDeps(probeBlocked, 3);
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    deps.loop.projectRepo.get = async () => ({ workspacePath: unreadable });

    await processTask(deps, freshPendingItem());

    expect(stored()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", faultClass: "ashara" } });
    expect(faults()).toBe(4);
    expect(halts).toEqual([expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled" })]);
  });

  // The owner abandoned the task while it was dispatched: it is no longer at work, so an unread main
  // is charged to nothing, neither counted on it nor halting its project.
  test("main unreadable after a fault, the task abandoned during the dispatch: left Abandoned, no fault counted, no halt", async () => {
    const { deps, stored, halts, faults } = buildEnvironmentBlockedDeps(probeBlocked, 3);
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-execution-"));
    targets.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    deps.loop.projectRepo.get = async () => ({ workspacePath: unreadable });
    deps.dispatch.dispatchService.execute = async () => {
      await deps.loop.workItemRepo.save({ ...stored(), status: "Abandoned" }, "InProgress");
      return probeBlocked;
    };

    await processTask(deps, freshPendingItem());

    expect(stored().status).toBe("Abandoned");
    expect(faults()).toBe(3);
    expect(halts).toEqual([]);
  });

  test("a refused workspace path after a fault: the project halts at once, nothing counted, never requeued", async () => {
    const { deps, stored, halts, faults } = buildEnvironmentBlockedDeps();
    const outside = mkdtempSync(join("/var/tmp", "ashara-execution-outside-"));
    targets.push(outside);
    deps.loop.projectRepo.get = async () => ({ workspacePath: outside });

    await processTask(deps, freshPendingItem());

    expect(stored()).toMatchObject({ status: "Blocked", blockedReason: { source: "orphan_unreconciled", faultClass: "ashara" } });
    expect(faults()).toBe(0);
    expect(halts).toEqual([expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled", reason: expect.stringContaining("InvalidTargetProjectPath") })]);
  });

  // Every route that returns the item to Pending reads main first, whatever sent it back.
  describe("a route back to Pending with the task's merge on main: recorded and Completed, never back to Pending", () => {
    const blockedAt = (operation: string): NonNullable<ExecutionResult["errorEnvelope"]> => ({
      outcome: "blocked",
      summary: operation,
      chain: { boundary: "development", operation, message: operation, timestamp: new Date().toISOString() },
    });
    const at = { sessionId: "test-session", attempt: 1 } as const;
    test.each<[string, string, ExecutionResult]>([
      [
        "an environment change requested",
        "a requested change to environment/Containerfile",
        { status: "environment_change_requested", paths: ["environment/Containerfile"], need: "jq", diff: "+jq", detail: "needs jq", outcome: COMPLETED_OUTCOME, ...at, errorEnvelope: blockedAt("ownershipGate") },
      ],
      [
        "a need of another task's work",
        "a need of I1",
        { status: "prerequisite_needed", interfaceEntries: ["I1"], interfaceTable: [{ key: "I1", text: "POST /loans" }], reason: "needs I1", detail: "needs I1", outcome: COMPLETED_OUTCOME, ...at, errorEnvelope: blockedAt("agentAttempt") },
      ],
      [
        "its stored checks stale",
        "its stored checks went stale",
        { status: "checks_stale", checkTaskId: createWorkItemId(), revision: 1, detail: "stale", outcome: null, ...at, errorEnvelope: blockedAt("revalidateTaskChecks") },
      ],
      [
        "a disputed check",
        "a dispute of its check",
        {
          status: "disputed",
          checksOf: ITEM_ID,
          checkTaskId: createWorkItemId(),
          revision: 1,
          check: { name: "lists", command: "true" },
          reason: "wrong",
          evidence: null,
          detail: "disputed",
          outcome: { ...OUTCOME_BASE, kind: "disputed", checkName: "lists", ofTask: null, reason: "wrong", evidence: null },
          ...at,
          errorEnvelope: blockedAt("agentAttempt"),
        },
      ],
      [
        "a suite review that found problems",
        "a suite review that found 1 problem(s)",
        {
          status: "suite_review_problems",
          problems: [{ checkTaskIds: [createWorkItemId()], kind: "contradiction", problem: "p", evidence: "e" }],
          detail: "problems",
          outcome: null,
          ...at,
          errorEnvelope: blockedAt("reviewSuites"),
        },
      ],
    ])("after %s", async (_label, why, executed) => {
      const { deps, stored, statusesWritten, refunds, faults, logger } = buildEnvironmentBlockedDeps(executed);
      const main = targetWithMain([`merge: task ${ITEM_ID}`]);
      deps.loop.projectRepo.get = async () => ({ workspacePath: main.path });
      const records: string[] = [];
      deps.loop.workItemRepo.recordMergeCommit = async (_id, commit, kind) => void records.push(`${commit}:${kind ?? "null"}`);

      await processTask(deps, freshPendingItem());

      expect(records).toEqual([`${main.head}:merged`]);
      expect(statusesWritten).toEqual(["InProgress", "Completed"]);
      expect(stored().status).toBe("Completed");
      expect(refunds()).toBe(0);
      expect(faults()).toBe(0);
      // Found by the route's own read, not by a fault path's after the route failed.
      expect(logger.records.filter((record) => record.event === "delivery.merged-before-requeue").map((record) => record.msg)).toEqual([expect.stringContaining(why)]);
    });
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

  // The owner may abandon the task between the fault and its charge: the charge reads the task under
  // its lock, and a task no longer InProgress is charged to neither its budget nor its project.
  test("a fault past the budget on a task that reads Abandoned under the charge's lock: nothing counted, no halt, no requeue", async () => {
    const { deps, stored, statusesWritten, refunds, logger } = buildEnvironmentBlockedDeps(probeBlocked, 3);
    const charged: string[] = [];
    deps.loop.workItemRepo.withItemLocked = itemLockOver(async () => ({ ...stored(), status: "Abandoned", events: [] }), {
      recordInfrastructureFault: async (id) => {
        charged.push(`fault:${id}`);
        return 4;
      },
      blockProject: async (projectId) => {
        charged.push(`halt:${projectId}`);
        return "blocked";
      },
    });

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("interrupted");
    expect(charged).toEqual([]);
    expect(statusesWritten).toEqual(["InProgress"]);
    expect(refunds()).toBe(0);
    expect(logger.records).toContainEqual(expect.objectContaining({ event: "delivery.fault-uncharged", fields: expect.objectContaining({ status: "Abandoned" }) }));
  });

  // Ashara's own Z0 fault is not the machines; the substrate probe cannot end its halt.
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

  // A fault before the dispatch seam is never charged as the task's, which would replan it without bound.
  test("a throw before the dispatch seam: Ashara's fault, back to Pending uncounted, no failure router, no lesson", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps();
    let counted = 0;
    deps.loop.workItemRepo.incrementDispatchCount = async () => {
      counted++;
      return 1;
    };
    // The store fails once, under the workspace's read; main is read for the task's merge after it.
    let projectReads = 0;
    deps.loop.projectRepo.get = async () => {
      if (projectReads++ === 0) throw new Error("connection terminated unexpectedly");
      return { workspacePath: UNMERGED_TARGET };
    };

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("interrupted");
    expect(result.detail).toContain("connection terminated unexpectedly");
    expect(projectReads).toBe(2);
    expect(statusesWritten).toEqual(["InProgress", "Pending"]);
    expect(stored().status).toBe("Pending");
    expect(counted).toBe(0);
    expect(refunds()).toBe(0);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
  });

  // The check set a task is judged by freezes before the task is dispatched.
  test("the dispatch freezes the check set of the reviews the task depends on before it is counted; a freeze that fails stops it uncounted", async () => {
    const { deps } = buildEnvironmentBlockedDeps();
    const order: string[] = [];
    deps.loop.workItemRepo.incrementDispatchCount = async () => {
      order.push("counted");
      return 1;
    };
    deps.dispatch.checkSetFreeze.freezeFor = async (taskId) => {
      order.push(`freeze ${taskId}`);
      return [];
    };
    await processTask(deps, freshPendingItem());
    expect(order.slice(0, 2)).toEqual([`freeze ${ITEM_ID}`, "counted"]);

    const failing = buildEnvironmentBlockedDeps();
    let counted = 0;
    failing.deps.loop.workItemRepo.incrementDispatchCount = async () => {
      counted++;
      return 1;
    };
    failing.deps.dispatch.checkSetFreeze.freezeFor = async () => {
      throw new Error("check_set_freezes insert failed");
    };
    const result = await processTask(failing.deps, freshPendingItem());
    expect(result).toMatchObject({ status: "interrupted", detail: expect.stringContaining("check_set_freezes insert failed") });
    expect(counted).toBe(0);
    expect(failing.stored().status).toBe("Pending");
    expect(failing.failureRoutes()).toBe(0);
  });

  test("a throw out of the dispatch past the seam: Ashara's fault, back to Pending with the dispatch refunded, no lesson", async () => {
    const { deps, stored, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps();
    deps.dispatch.dispatchService.execute = async () => {
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

  // A verifier cell refused after the agent's work passed is an infrastructure fault: operation
  // postMergeVerify never reaches the classifier as TREE_REGRESSION.
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

  // A project with no environment never runs the task on the BaseCell. Nothing
  // re-defines main's environment while every environment task is done, so the task is given up for a repair.
  test("no environment defined: given up with an environment_undefined reason, never Failed, no failure router", async () => {
    const detail = "no environment for task t: no environment is defined on main at abc; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps({
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
    // No agent ran: the dispatch is given back.
    expect(refunds()).toBe(1);
    const reason = stored().blockedReason;
    expect(reason).toMatchObject({ source: "environment_undefined", reason: detail });
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });


  // No default role works an item no roster role owns. No production path appends
  // a roster revision after the first, so the task is given up and its repair staffs new tasks.
  test("no owner role: given up with a typed owner_unresolved reason, never Failed, no failed approach, no failure router", async () => {
    const detail = "no roster role can work task t: the work item has no owner role; no agent ran and nothing executed";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches, refunds } = buildEnvironmentBlockedDeps({
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
    // No agent ran: the dispatch is given back.
    expect(refunds()).toBe(1);
    const reason = stored().blockedReason;
    expect(reason).toEqual({ source: "owner_unresolved", ownerRoleId: null, rosterRevision: 1, reason: "the work item has no owner role" });
    expect(parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }).blockedReason).toEqual(reason);
  });
});

// Stale checks are never a VERIFICATION_GAP replanned and lessoned against the implementer, and an
// item parked on them waits on a check task that is reopened, never on one nothing reopens.
describe("stored checks stale: the check task is reopened and the item waits on it", () => {
  const CHECK_ID: WorkItemId = createWorkItemId();
  const detail = "the checks of task t (revision 1, check task c) were red-run on environment version e, but ...";

  function completedCheckTask(overrides: Partial<WorkItem> = {}): WorkItem {
    return { ...freshPendingItem(), id: CHECK_ID, title: "write the checks", workKind: "check", status: "Completed", dispatchCount: 1, ...overrides };
  }

  function buildStaleDeps(options: { readonly checkTask: WorkItem | null; readonly revision: number; readonly checkTaskSaveLoses?: boolean }) {
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

    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        const row = rowOf(item.id);
        rows.set(item.id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      getDependencies: async () => [],
      findChildren: async () => [],
    });

    const deps = dispatchRunDeps({ loop: { workItemRepo, eventStore: { publish: async (event) => void events.push(event.eventType) } }, dispatch: { dispatchService: {
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
      }, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });
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

// An implementer's "these checks cannot pass" is a
// dispute of the checks, never the task's own failure.
describe("a disputed check: the check task is reopened with the dispute and the item waits on it", () => {
  const CHECK_ID: WorkItemId = createWorkItemId();
  const reason = "the check uses [[ ]], which the runner's sh rejects with exit 2 on any work";
  const evidence = 'Check "lists": FAILED: exited 2\n  output: sh: [[: not found';

  /** `merged`: the disputed check is a merged task's, written by a check task the item does not depend on. */
  function buildDisputeDeps(priorDisputes: number, whose: "own" | "merged" = "own") {
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
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        const row = rowOf(item.id);
        rows.set(item.id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      addDependency: async (from, to) => {
        edges.push({ from, to });
      },
      // The item's own check task is the edge the plan wrote; a merged task's check task is not on it.
      getDependencies: async (id) => (id === ITEM_ID && whose === "own" ? [CHECK_ID] : []),
      findChildren: async () => [],
    });
    const deps = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: {
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
      }, checkDisputes: {
        record: async (dispute) => {
          disputes.push(dispute);
          return priorDisputes + disputes.filter((entry) => entry.checkTaskId === dispute.checkTaskId).length;
        },
      }, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });
    return { deps, item: () => rowOf(ITEM_ID), check: () => rowOf(CHECK_ID), disputes, edges, routed: () => routed, approaches: () => approaches };
  }

  // A merged task's check that blocks the item's merge may be disputed.
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

  // Past the bound (K = 2) the item is given up for a plan repair.
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

// A refused environment
// edit opens an environment task and the item waits, never an operator editing main.
describe("an environment change requested: an environment task is opened and the item waits on it", () => {
  const ROLE_ID = "55555555-5555-4555-8555-555555555555";
  const detail = "ownership gate refused the work of t: environment/ belongs to the platform role; ...";
  const need = "the greeter needs the jq package in the image";
  const diff = "--- a/environment/Containerfile\n+++ b/environment/Containerfile\n+RUN apk add jq\n";

  // A dispatched task carries the grade it was dispatched at; the environment task judging its request is graded from it.
  const GRADED: Pick<WorkItem, "taskSpec"> = { taskSpec: { capability: "Strong" } };

  function buildEnvironmentChangeDeps(
    priorChanges: number,
    owner: Awaited<ReturnType<TaskDispatchSteps["environmentOwner"]>>,
    requester: Pick<WorkItem, "taskSpec"> = GRADED,
    completed: readonly WorkItem[] = [],
  ) {
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
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        const row = rowOf(item.id);
        rows.set(item.id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      findByProjectAndStatus: async (projectId, status) =>
        [...rows.values()].filter((row) => row.projectId === projectId && row.status === status).map(copy),
      addDependency: async (from, to) => void edges.push({ from, to }),
      getDependencies: async (id) => edges.filter((edge) => edge.from === id).map((edge) => edge.to as WorkItemId),
      findChildren: async () => [],
      withTransaction: async (fn) => fn(workItemRepo),
    });
    const deps = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: {
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
      }, environmentOwner: async () => owner, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });
    const opened = () => [...rows.values()].filter((row) => row.id !== ITEM_ID && row.status === "Pending");
    return { deps, item: () => rowOf(ITEM_ID), opened, edges, routed: () => routed, approaches: () => approaches };
  }

  test("within the bound: a Pending environment task owned by the environment role, with the need and the diff; the item waits on it, its dispatch given back", async () => {
    const { deps, item, opened, edges, routed, approaches } = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID });

    const result = await processTask(deps, { ...freshPendingItem(), ...GRADED });

    expect(result.status).toBe("blocked");
    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: undefined });
    const [environment] = opened();
    expect(opened()).toHaveLength(1);
    expect(environment).toMatchObject({
      level: "Task",
      workKind: "environment",
      ownerRoleId: ROLE_ID,
      repairsTaskId: ITEM_ID,
      projectId: TEST_PROJECT_ID,
      title: `Environment change 1 for task ${ITEM_ID}`,
      taskSpec: { origin: "environment-change", checkedBy: "substrate", capability: "Strong" },
    });
    expect(environment?.taskSpec?.scope).toContain(need);
    expect(environment?.taskSpec?.scope).toContain("+RUN apk add jq");
    expect(edges).toEqual([{ from: ITEM_ID, to: environment?.id }]);
    expect(environment?.taskSpec?.product).toBe("present");
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
  });

  // The scaffold's own environment change must not run the product's build and test on a main with
  // no product, where it fails and stalls every task behind the scaffold.
  test("asked by the product scaffold before any scaffold completed: the environment task records no product on main", async () => {
    const scaffold: Pick<WorkItem, "taskSpec"> = { taskSpec: { origin: "product-scaffold", checkedBy: "substrate", capability: "Strong" } };
    const { deps, opened } = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID }, scaffold);

    await processTask(deps, { ...freshPendingItem(), ...scaffold });

    expect(opened()).toHaveLength(1);
    expect(opened()[0]?.taskSpec).toMatchObject({ origin: "environment-change", product: "absent" });
  });

  test("asked by the product scaffold after an earlier scaffold completed: the product is on main", async () => {
    const scaffold: Pick<WorkItem, "taskSpec"> = { taskSpec: { origin: "product-scaffold", checkedBy: "substrate", capability: "Strong" } };
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

  // A roster read error is never folded into "no owner", which would give the task up.
  test("a roster that cannot be read: Ashara's fault, back to Pending with the dispatch refunded, never given up", async () => {
    const built = buildEnvironmentChangeDeps(0, { kind: "role", roleId: ROLE_ID });
    const { item, opened, routed, approaches } = built;
    let faults = 0;
    built.deps.loop.workItemRepo.withItemLocked = itemLockOver(built.deps.loop.workItemRepo.findById, { recordInfrastructureFault: async () => ++faults, blockProject: notExercised("blockProject") });
    const deps: DispatchRunDeps = withDispatchOverrides(built.deps, { dispatch: { environmentOwner: async () => {
        throw new Error("roster query failed");
      } } });

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

// A turn refused before its call was sent, at a spend cap or for any other reason, never reaches
// the FailureRouter as a failed attempt: one rule holds for both.
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

    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        row = { ...row, dispatchCount: row.dispatchCount - 1 };
        return row.dispatchCount;
      },
      getDependencies: async () => [],
      findChildren: async () => [],
    });

    const deps = dispatchRunDeps({ loop: { workItemRepo, projectRepo: {
        get: async () => ({ workspacePath: UNMERGED_TARGET }),
        recordWorkspacePath: notExercised("recordWorkspacePath"),
        block: async (projectId, cause) => {
          blocks.push({ projectId, ...cause });
          return "blocked";
        },
      }, spendCap: {
        refusalOf: (error) =>
          error instanceof StubCapRefusal
            ? error.scope === "project"
              ? { kind: "project", projectId: TEST_PROJECT_ID, reason: error.message, spend: { capUsd: 5, spentUsd: 4.5, inFlightUsd: 0.25, nextCallUsd: 0.5 } }
              : { kind: "deployment", reason: error.message, spend: { capUsd: 5, spentUsd: 4.5, inFlightUsd: 0.25, nextCallUsd: 0.5 } }
            : null,
      } }, dispatch: { dispatchService: {
        execute: async (task) => {
          attempts.push(task.attempt);
          return scope === "shutdown"
            ? { status: "interrupted", detail: "attempt interrupted by shutdown after 2 turn(s)", outcome: { ...OUTCOME_BASE, turnsUsed: 2, kind: "cancelled", reason: new Error("shutdown") }, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope }
            : { status: "refused", refusal, detail: `attempt stopped after 2 turn(s): ${refusal.message}`, outcome: { ...OUTCOME_BASE, turnsUsed: 2, kind: "refused", error: refusal }, sessionId: "test-session", attempt: task.attempt, errorEnvelope: envelope };
        },
      }, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });
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

  // A SIGTERM's cancelled attempt is never counted toward the bound that abandons the item.
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

// What the client is told was merged comes from the work item's
// merge record, written before the task is completed.
describe("a completed dispatch records its merge before the task is Completed", () => {
  type ExecutionResult = Awaited<ReturnType<TaskDispatchSteps["dispatchService"]["execute"]>>;

  function buildMergeDeps(execResult: ExecutionResult, mergeWrite: (commit: string) => Promise<void>): {
    deps: DispatchRunDeps;
    stored: () => WorkItem;
    writes: string[];
  } {
    let row = freshPendingItem();
    const writes: string[] = [];
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      incrementDispatchCount: async () => 1,
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      getDependencies: async () => [],
      findChildren: async () => [],
    });
    const deps = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: { execute: async () => execResult } } });
    return { deps, stored: () => row, writes };
  }

  const merged: ExecutionResult = {
    status: "completed",
    delivered: { kind: "merged", mergeCommit: MERGE_COMMIT },
    detail: "merged on main, after its post-merge checks passed on the merged tree",
    outcome: COMPLETED_OUTCOME,
    sessionId: "test-session",
    attempt: 1,
  };

  // The Completed transition commits before its events publish; a failed publish after it must not
  // route a merged, Completed task as failed nor write a false lesson.
  test("a publish that fails after the task is Completed: still completed, no lesson", async () => {
    const built = buildMergeDeps(merged, async () => {});
    const { stored, writes } = built;
    let approaches = 0;
    const deps: DispatchRunDeps = withDispatchOverrides(built.deps, { dispatch: { failedApproachRepo: { record: async () => { approaches++; } } }, loop: { eventStore: {
        publish: async () => {
          throw new Error("domain_events insert failed");
        },
      } } });

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

  // A write that throws out of processTask would leave the item InProgress, which the startup
  // reconciler requeues, dispatching merged work again; so a failing merge-record write blocks it.
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

  // A serialization failure on the Completed update after a recorded merge reaches processTask as
  // Ashara's fault; requeueing it would dispatch merged work again.
  function failingCompletion(failures: number) {
    const built = buildMergeDeps(merged, async () => {});
    let failed = 0;
    const repo = built.deps.loop.workItemRepo;
    const deps: DispatchRunDeps = withDispatchOverrides(built.deps, { loop: { workItemRepo: {
        ...repo,
        save: async (item, previous) => {
          if (item.status === "Completed" && failed < failures) {
            failed++;
            throw new Error("could not serialize access due to concurrent update");
          }
          await repo.save(item, previous);
        },
      } } });
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

  // Work already on main is closed by its checks, with main's commit as its record.
  test("work already delivered records main's commit its checks passed on, then the task is Completed", async () => {
    const mainCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const { deps, stored, writes } = buildMergeDeps({ ...merged, delivered: { kind: "already-delivered", mainCommit } }, async () => {});

    const result = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["InProgress", `merge ${mainCommit}`, "Completed"]);
    expect(stored().status).toBe("Completed");
  });

  // A clean review completes, which releases the plan's implementations.
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

// A review reads the stored
// checks together before any implementation, so a suite no product can pass never reaches one.
describe("a review of the plan's suites with problems: the named check tasks are reopened and the review waits", () => {
  const CHECK_A: WorkItemId = createWorkItemId();
  const CHECK_B: WorkItemId = createWorkItemId();
  const CHECK_C: WorkItemId = createWorkItemId();
  const problem = "a prints a column count on stdout, b requires stdout to hold only the report";
  const problems = [{ checkTaskIds: [CHECK_A, CHECK_B], kind: "contradiction" as const, problem, evidence: "a: wc; b: diff" }];

  function buildReviewDeps(priorReviews: number) {
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
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        const row = rowOf(item.id);
        rows.set(item.id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      getDependencies: async () => [],
      findChildren: async () => [],
      withTransaction: async (fn) => fn(workItemRepo),
    });
    const deps = dispatchRunDeps({ loop: { workItemRepo }, dispatch: { dispatchService: {
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
      }, suiteReviewFindings: {
        record: async (findings) => {
          recorded.push(findings);
          const ids = [...new Set(findings.problems.flatMap((p) => p.checkTaskIds))];
          for (const id of ids) named.set(id, (named.get(id) ?? priorReviews) + 1);
          return { timesNamed: new Map(ids.map((id) => [id, named.get(id) ?? 0])) };
        },
      }, failedApproachRepo: { record: async () => { approaches++; } }, failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } } } });
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

  // Past the bound the review is given up and the plan repaired.
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

// A block on another task's work is that task's to clear: the item waits on it, its attempt given
// back, and neither the failure router nor a give-up is reached.
describe("a blocked finish on another task's work: the item waits on the task building the entry, its attempt given back", () => {
  const BUILDER_ID: WorkItemId = createWorkItemId();
  const INTERFACE = [{ key: "I1", text: "POST /loans" }];

  function builderTask(): WorkItem {
    return {
      ...freshPendingItem(),
      id: BUILDER_ID,
      title: "record loans",
      taskSpec: {
        origin: "decomposition",
        sources: [{ type: "guarantee", id: "G1", text: "loans are recorded", observation: "output", interface: ["I1"], refutedBy: [] }],
      },
    };
  }

  function buildNeedDeps(entries: readonly [string, ...string[]]) {
    const rows = new Map<string, WorkItem>([
      [ITEM_ID, freshPendingItem()],
      [BUILDER_ID, builderTask()],
    ]);
    const dependencies: Array<readonly [WorkItemId, WorkItemId]> = [];
    const events: string[] = [];
    let routed = 0;
    let approaches = 0;
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });
    const rowOf = (id: string): WorkItem => {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`no row ${id}`);
      return row;
    };
    const workItemRepo: WorkItemRepository = inertWorkItemRepo({
      findById: async (id) => {
        const row = rows.get(id);
        return row === undefined ? null : copy(row);
      },
      listByProject: async () => [...rows.values()].map(copy),
      listDependenciesByProject: async () => [],
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
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      async saveRefunded(item, expectedPreviousStatus) {
        await workItemRepo.save(item, expectedPreviousStatus);
        const row = rowOf(item.id);
        rows.set(item.id, { ...row, dispatchCount: row.dispatchCount - 1 });
        return row.dispatchCount - 1;
      },
      withTransaction: async (run) => run(workItemRepo),
      getDependencies: async (id) => dependencies.filter(([from]) => from === id).map(([, to]) => to),
      addDependency: async (from, to) => void dependencies.push([from, to]),
      findChildren: async () => [],
    });
    const detail = "agent reported blocked: the check sets up a loan through I1";
    const outcome: Outcome = {
      ...OUTCOME_BASE,
      kind: "finished",
      status: "blocked",
      summary: "Stuck.",
      blockedReason: "needs I1",
      blockedOn: { kind: "needs-work", interfaceEntries: entries },
      statement: null,
    };
    const logger = recordingLogger();
    const deps = dispatchRunDeps({
      loop: { workItemRepo, logger, eventStore: { publish: async (event) => void events.push(event.eventType) } },
      dispatch: {
        dispatchService: {
          execute: async () => ({
            status: "prerequisite_needed",
            interfaceEntries: entries,
            interfaceTable: INTERFACE,
            reason: "needs I1",
            detail,
            outcome,
            sessionId: "test-session",
            attempt: 1,
            errorEnvelope: {
              outcome: "blocked",
              summary: detail,
              chain: { boundary: "development", operation: "agentAttempt", message: detail, timestamp: new Date().toISOString() },
            },
          }),
        },
        failedApproachRepo: { record: async () => { approaches++; } },
        failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
      },
    });
    return { deps, logger, item: () => rowOf(ITEM_ID), dependencies, events, routed: () => routed, approaches: () => approaches };
  }

  test("the item is back at Pending waiting on the builder, its dispatch count unchanged, no failure routed and nothing given up", async () => {
    const { deps, logger, item, dependencies, events, routed, approaches } = buildNeedDeps(["I1"]);

    await processTask(deps, freshPendingItem());

    expect(item()).toMatchObject({ status: "Pending", dispatchCount: 0, blockedReason: { source: "awaiting_work", waits: 1, interfaceEntries: ["I1"], on: [BUILDER_ID] } });
    expect(dependencies).toEqual([[ITEM_ID, BUILDER_ID]]);
    expect(events).toContain("work_item.awaiting_work");
    expect(events).not.toContain("work_item.given_up");
    expect(routed()).toBe(0);
    expect(approaches()).toBe(0);
    expect(logger.records.filter((record) => record.event === "delivery.task-given-up")).toEqual([]);
  });

  test("routeAsGivenUp refuses an owner-wait's give-up, which only the wait's own exit writes, and writes nothing", async () => {
    const { deps, item } = buildNeedDeps(["I1"]);
    const owner: GiveUpCause = { source: "prerequisite_unresolved", why: "unplanned", waits: 0, reason: "no task builds I1" };

    await expect(routeAsGivenUp(routingDepsOf(deps), ITEM_ID, owner, "refund")).rejects.toBeInstanceOf(GiveUpMisrouted);
    expect(item().status).toBe("Pending");
    expect(item().blockedReason).toBeUndefined();
  });

  test("routeAsGivenUp refuses an environment change's give-up, which only the environment exit writes, and writes nothing", async () => {
    const { deps, item } = buildNeedDeps(["I1"]);
    const environment: GiveUpCause = { source: "environment_change_needed", paths: ["Dockerfile"], reason: "past the bound" };

    await expect(routeAsGivenUp(routingDepsOf(deps), ITEM_ID, environment, "refund")).rejects.toMatchObject({
      name: "GiveUpMisrouted",
      source: "environment_change_needed",
      route: "environment-exit",
    });
    expect(item().status).toBe("Pending");
    expect(item().blockedReason).toBeUndefined();
  });
});
