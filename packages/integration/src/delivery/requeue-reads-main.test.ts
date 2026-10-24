import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { CoreLoop, DEFAULT_CONFIG, ProjectHaltRepository, WorkItemRowRepository } from "@ashara/delivery";
import type { CoreLoopDeps, CoreLoopOverrides, StoredBlockedReason } from "@ashara/delivery";
import { CellExecInterrupted } from "@ashara/execution-infra";
import { ContextBudgetExceeded } from "@ashara/finance";
import { createWorkItemId } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";

// A dispatch can merge its work on main and stop before its merge record is written. Every path
// that sends a task back to Pending reads main first: with the task's merge on main the task is
// recorded and Completed, never dispatched again. Against Postgres and a real git main, each path
// driven through the core loop as production composes it, with a fake dispatch and no model call.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `requeue-reads-main-test-${randomUUID().slice(0, 8)}`;

type Db = Database;
type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["dispatch"]["dispatchService"]["execute"]>>;
type Execute = CoreLoopDeps["dispatch"]["dispatchService"]["execute"];
let db: Db;
let root = "";

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-requeue-reads-main-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}-%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A project whose target's main holds the merge commit of its one task, and that task's row. */
async function mergedTask(
  label: string,
  row: { readonly status: "Pending" } | { readonly status: "Blocked"; readonly blockedReason: StoredBlockedReason },
): Promise<{ readonly projectId: ProjectId; readonly taskId: WorkItemId; readonly workdirBase: string; readonly mergeCommit: string }> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(NAME, client.id)).id;
  const workdirBase = join(root, label);
  const target = join(workdirBase, "target");
  await mkdir(target, { recursive: true });
  const taskId = createWorkItemId();
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  git("commit", "-q", "--allow-empty", "-m", `merge: task ${taskId}`);
  await projects.recordWorkspacePath(projectId, target);
  await new WorkItemRowRepository(db).create({
    id: taskId,
    level: "Task",
    title: `task of ${label}`,
    taskSpec: { goal: `task of ${label}`, origin: "sprint0" },
    projectId,
    dispatchCount: row.status === "Blocked" ? 1 : 0,
    ...row,
  });
  return { projectId, taskId, workdirBase, mergeCommit: git("rev-parse", "HEAD") };
}

/** The loop over `projectId` alone, its dispatch `execute`; `overrides` replace each other member a path needs. */
function loopOver(projectId: ProjectId, workdirBase: string, execute: Execute, overrides: CoreLoopOverrides = {}): CoreLoop {
  const projects = new ProjectHaltRepository(db);
  return new CoreLoop(
    composedLoopOverTestDb(
      {
        db,
        config: { ...DEFAULT_CONFIG, workdirBase },
        logger: recordingLogger(),
        spendCap: { deploymentStop: async () => null, refusalOf: () => null },
        containment: memoryStepContainment(() => true),
        dispatchService: { execute },
      },
      {
        ...overrides,
        loop: {
          projectRepo: {
            get: (id) => projects.get(id),
            recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
            listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === projectId),
            listWithWorkspace: async () => (await projects.listWithWorkspace()).filter((p) => p.id === projectId),
            block: (id, cause) => projects.block(id, cause),
            listInfrastructureHalted: async () => [],
            listClientWaitHalted: async () => [],
            resumeFromClientWait: notExercised("resumeFromClientWait"),
            resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
            blockAllActive: async () => [],
          },
        },
      },
    ),
  );
}

const OUTCOME_BASE = {
  turnsUsed: 2,
  cost: { measured: true as const, totalUsd: 0, turns: 2 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "stopped",
};

function envelope(message: string): NonNullable<Extract<ExecutionResult, { status: "interrupted" }>["errorEnvelope"]> {
  return { outcome: "blocked", summary: message, chain: { boundary: "development", operation: "agentAttempt", message, timestamp: new Date().toISOString() } };
}

/** Stands for Finance's UnpricedModel: a refusal no spend cap made, so a configuration fault. */
class StubUnpricedModel extends Error {
  constructor() {
    super('Model "m" (provider "p") is unpriced: input_cost_per_1m=0, output_cost_per_1m=0. The request was not sent.');
    this.name = "UnpricedModel";
  }
}

/** A fault of Ashara's own before the dispatch seam: nothing of the task ran. */
class FreezeWriteFailed extends Error {
  constructor() {
    super("check_set_freezes insert failed: connection terminated");
    this.name = "FreezeWriteFailed";
  }
}

const interrupted: Execute = async (task) => ({
  status: "interrupted",
  detail: "attempt interrupted by shutdown after 2 turn(s)",
  outcome: { ...OUTCOME_BASE, kind: "cancelled", reason: new Error("shutdown") },
  sessionId: "test-session",
  attempt: task.attempt,
  errorEnvelope: envelope("shutdown"),
});

const cellInterrupted: Execute = async () => {
  throw new CellExecInterrupted("cell-1", ["sh", "-c", "npm test"], "while it ran", new Error("shutdown"));
};

const refused: Execute = async (task) => {
  const refusal = new StubUnpricedModel();
  return {
    status: "refused",
    refusal,
    detail: `attempt stopped after 2 turn(s): ${refusal.message}`,
    outcome: { ...OUTCOME_BASE, kind: "refused", error: refusal },
    sessionId: "test-session",
    attempt: task.attempt,
    errorEnvelope: envelope(refusal.message),
  };
};

const contextExceeded: Execute = async (task) => ({
  status: "context_exceeded",
  model: { provider: "p", modelId: "small-model" },
  windowTokens: 32_000,
  outputReserveTokens: 16_384,
  projectedInputTokens: 20_000,
  providerMessage: null,
  wider: { provider: "p", modelId: "wide-model", windowTokens: 200_000 },
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
  attempt: task.attempt,
  errorEnvelope: envelope("context"),
});

describe("a task whose merge is on main is recorded and Completed, never back to Pending", () => {
  test.each<[string, Execute]>([
    ["a shutdown that interrupted its attempt", interrupted],
    ["a shutdown that interrupted a command of its dispatch in a cell", cellInterrupted],
    ["a refusal of its model call", refused],
    ["a turn that did not fit its model's window, a wider model in the catalog", contextExceeded],
  ])("after %s", async (label, execute) => {
    const { projectId, taskId, workdirBase, mergeCommit } = await mergedTask(label.replace(/\W+/g, "-"), { status: "Pending" });

    await loopOver(projectId, workdirBase, execute).runCycle();

    expect(await new WorkItemRowRepository(db).findById(taskId)).toMatchObject({ status: "Completed", mergeCommit, mergeKind: "merged" });
  });

  test("after a fault of Ashara's own before the dispatch seam, uncounted", async () => {
    const { projectId, taskId, workdirBase, mergeCommit } = await mergedTask("uncounted-fault", { status: "Pending" });
    const freezeFails: CoreLoopOverrides = { dispatch: { checkSetFreeze: { freezeFor: async () => { throw new FreezeWriteFailed(); } } } };

    await loopOver(projectId, workdirBase, notExercised("dispatchService.execute"), freezeFails).runCycle();

    expect(await new WorkItemRowRepository(db).findById(taskId)).toMatchObject({ status: "Completed", mergeCommit, dispatchCount: 0, infrastructureFaults: 0 });
  });

  test("leaving an infrastructure block from a legacy row", async () => {
    const { projectId, taskId, workdirBase, mergeCommit } = await mergedTask("legacy-infrastructure-block", {
      status: "Blocked",
      blockedReason: { source: "environment_unavailable", unavailable: "podman", reason: "podman binary not found" },
    });

    const dispatched: string[] = [];
    const recordDispatch: Execute = async (task) => {
      dispatched.push(task.id);
      throw new Error("no dispatch may run: the parked exit settles the task from main");
    };

    await loopOver(projectId, workdirBase, recordDispatch).runCycle();

    // Settled by the parked exit itself, before any dispatch: a release to Pending would be
    // dispatched in the same cycle and counted, and only that dispatch's own read would find the merge.
    expect(dispatched).toEqual([]);
    expect(await new WorkItemRowRepository(db).findById(taskId)).toMatchObject({ status: "Completed", mergeCommit, blockedReason: null, dispatchCount: 1, infrastructureFaults: 0 });
  });
});
