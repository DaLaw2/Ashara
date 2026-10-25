import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl, type Database } from "@ashara/db";
import {
  adaptWorkItemRepo,
  CoreLoop,
  DEFAULT_CONFIG,
  FailureRouter,
  ProjectHaltRepository,
  reconcileWorkItemsOnStartup,
  releaseClearedBlocks,
  WorkItemRowRepository,
} from "@ashara/delivery";
import type { CoreLoopDeps, StoredBlockedReason } from "@ashara/delivery";
import { createLogger, createWorkItemId, observeRetryWaits, systemClock } from "@ashara/shared";
import type { DomainEvent, Logger, ProjectId, WorkItemId } from "@ashara/shared";
import { memoryStepContainment, notExercised } from "@ashara/shared/testing";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";

// A task kept off Pending because main went unread is charged for it (its infrastructure fault
// counted, or its project halted) only while it is still Blocked. The owner may abandon it at any
// moment. Against Postgres, the owner's transition is written on another connection and held open
// until the charge waits on its row lock, then committed: the charge then reads the task Abandoned,
// and nothing is charged. Each caller of the charge is driven as production runs it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `charge-row-locked-test-${randomUUID().slice(0, 8)}`;
// Each poll is one query; the bound only ends a run whose charge never reaches the lock.
const POLL_BOUND = 20_000;

type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["dispatch"]["dispatchService"]["execute"]>>;
let db: Database;
let root = "";
// The charge after an unread main is what these tests judge, never the length of the read's retry pauses.
let restoreRetryWaits: () => void = () => {};

beforeAll(async () => {
  restoreRetryWaits = observeRetryWaits(() => new Promise((resolve) => setImmediate(resolve)));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-charge-row-locked-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}-%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  restoreRetryWaits();
});

/** The owner's transaction ended before it held the task's row. */
class OwnerHoldEnded extends Error {
  constructor(readonly taskId: WorkItemId) {
    super(`the owner's transaction on task ${taskId} ended before it held the task's row`);
    this.name = "OwnerHoldEnded";
  }
}

/** The charge neither waited on the owner's lock nor settled within the poll bound. */
class ChargeNeverWaited extends Error {
  constructor(
    readonly ownerPid: number,
    readonly polls: number,
  ) {
    super(`no statement waited on the lock of backend ${ownerPid}, and the charge did not settle, in ${polls} polls`);
    this.name = "ChargeNeverWaited";
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  const settle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, resolve: (value) => settle.resolve(value) };
}

/** The owner's Blocked -> Abandoned of the task, written in a transaction on its own connection and left open. */
interface OwnerHold {
  readonly pid: number;
  readonly commit: () => Promise<void>;
}

async function ownerAbandonsHeld(taskId: WorkItemId): Promise<OwnerHold> {
  const holding = deferred<number>();
  const release = deferred<void>();
  const done = db.transaction(async (tx) => {
    const [backend] = z.array(z.object({ pid: z.number() })).parse((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows);
    if (backend === undefined) throw new OwnerHoldEnded(taskId);
    await new WorkItemRowRepository(tx).save(
      { id: taskId, status: "Abandoned", blockedReason: { source: "api", note: "abandoned by the owner" }, failureVerdict: null, updatedAt: new Date() },
      "Blocked",
    );
    holding.resolve(backend.pid);
    await release.promise;
  });
  const pid = await Promise.race([
    holding.promise,
    done.then((): never => {
      throw new OwnerHoldEnded(taskId);
    }),
  ]);
  return {
    pid,
    commit: async () => {
      release.resolve();
      await done;
    },
  };
}

/**
 * Returns `waiting` once a statement of another connection waits on `ownerPid`'s locks, or
 * `settled` once `charge` has settled without waiting on them.
 */
async function untilChargeWaits(ownerPid: number, charge: Promise<unknown>): Promise<"waiting" | "settled"> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void charge.then(mark, mark);
  for (let polls = 0; polls < POLL_BOUND; polls++) {
    if (settled) return "settled";
    const waiting = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${ownerPid} = ANY(pg_blocking_pids(pid))`);
    const [count] = z.array(z.object({ n: z.number() })).parse(waiting.rows);
    if (count !== undefined && count.n > 0) return "waiting";
  }
  throw new ChargeNeverWaited(ownerPid, POLL_BOUND);
}

/** What the charge could have written: the task's fault count and status, and its project's halts. */
async function charged(projectId: ProjectId, taskId: WorkItemId): Promise<{ readonly faults: number; readonly status: string; readonly halts: number }> {
  const row = await new WorkItemRowRepository(db).findById(taskId);
  const halts = await db.execute(sql`SELECT count(*)::int AS n FROM project_blocks WHERE project_id = ${projectId}`);
  const [count] = z.array(z.object({ n: z.number() })).parse(halts.rows);
  return { faults: row?.infrastructureFaults ?? -1, status: row?.status ?? "gone", halts: count?.n ?? -1 };
}

/**
 * A project whose recorded target cannot be read for a merge, and its one task's row: `transient`, a
 * directory in the workdir base whose `.git` is empty, so git fails on it; `configuration`, a path
 * outside the workdir base.
 */
async function unreadTask(
  label: string,
  fault: "transient" | "configuration",
  row: { readonly status: "Pending" | "InProgress" } | { readonly status: "Blocked"; readonly blockedReason: StoredBlockedReason },
): Promise<{ readonly projectId: ProjectId; readonly taskId: WorkItemId; readonly workdirBase: string }> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(NAME, client.id)).id;
  const workdirBase = join(root, label);
  const target = fault === "transient" ? join(workdirBase, "target") : join(root, `${label}-outside`, "target");
  await mkdir(join(target, ".git"), { recursive: true });
  await mkdir(workdirBase, { recursive: true });
  await projects.recordWorkspacePath(projectId, target);
  const taskId = createWorkItemId();
  await new WorkItemRowRepository(db).create({
    id: taskId,
    level: "Task",
    title: `task of ${label}`,
    taskSpec: { goal: `task of ${label}`, origin: "sprint0" },
    projectId,
    dispatchCount: row.status === "Pending" ? 0 : 1,
    ...row,
  });
  return { projectId, taskId, workdirBase };
}

/** A logger that resolves `lastRead` once main's last read for a merge has failed: the charge is next. */
function loggerArming(lastRead: Deferred<void>): Logger {
  return createLogger({
    sink: {
      write: (record) => {
        if (record.event === "delivery.main-unread" && record.fields !== undefined && record.fields["attempt"] === record.fields["attempts"]) lastRead.resolve();
      },
    },
    clock: systemClock,
    minLevel: "debug",
  });
}

/**
 * The parked exits of `projectId` alone, over the production repositories; `lastRead` is resolved
 * once main's last read for a merge has failed, or the client's answer is read (a refused target is
 * read once, at once, after it): the charge is next.
 */
function parkedExits(projectId: ProjectId, workdirBase: string, lastRead: Deferred<void>): Promise<number> {
  const projects = new ProjectHaltRepository(db);
  return releaseClearedBlocks({
    workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(db)),
    eventStore: { publish: async () => undefined },
    projects: {
      listActiveIds: async () => [projectId],
      get: (id) => projects.get(id),
      block: (id, cause) => projects.block(id, cause),
    },
    clientQuestions: {
      ask: async (question) => ({ kind: "on-record", questionId: question.questionId }),
      answered: async () => {
        lastRead.resolve();
        return true;
      },
    },
    workdirBase,
    containment: memoryStepContainment(() => true),
    logger: loggerArming(lastRead),
  });
}

/** Holds the owner's transition from the moment `taskId` is published Blocked: the charge comes next. */
function holdOnBlocked(taskId: WorkItemId, held: Deferred<OwnerHold>): (event: DomainEvent) => Promise<void> {
  return async (event) => {
    if (event.eventType === "work_item.blocked" && event.payload["work_item_id"] === taskId) held.resolve(await ownerAbandonsHeld(taskId));
  };
}

const unreconciled: StoredBlockedReason = { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge", reason: "git failed" };

describe("a charge for an unread main reads the task under its row lock: an owner's Blocked -> Abandoned during it leaves nothing charged", () => {
  test("the parked exit of a Blocked task", async () => {
    const { projectId, taskId, workdirBase } = await unreadTask("parked-exit", "transient", { status: "Blocked", blockedReason: unreconciled });
    const owner = await ownerAbandonsHeld(taskId);
    const lastRead = deferred<void>();

    const exits = parkedExits(projectId, workdirBase, lastRead);
    await Promise.race([lastRead.promise, exits]);
    const barrier = await untilChargeWaits(owner.pid, exits);
    await owner.commit();

    expect(barrier).toBe("waiting");
    expect(await exits).toBe(0);
    expect(await charged(projectId, taskId)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
  });

  test("the exit of a task whose client's answer is read", async () => {
    const held: StoredBlockedReason = {
      source: "awaiting_client",
      waits: 1,
      questionId: randomUUID(),
      question: "Which command starts the product?",
      assumption: "The product starts as the tender describes it.",
      reason: "the tender contradicts itself",
    };
    const { projectId, taskId, workdirBase } = await unreadTask("answer-exit", "configuration", { status: "Blocked", blockedReason: held });
    const owner = await ownerAbandonsHeld(taskId);
    const lastRead = deferred<void>();

    const exits = parkedExits(projectId, workdirBase, lastRead);
    await Promise.race([lastRead.promise, exits]);
    const barrier = await untilChargeWaits(owner.pid, exits);
    await owner.commit();

    expect(barrier).toBe("waiting");
    expect(await exits).toBe(0);
    expect(await charged(projectId, taskId)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
  });

  test("a dispatch that stopped short, parked with main unread", async () => {
    const { projectId, taskId, workdirBase } = await unreadTask("main-settle", "transient", { status: "Pending" });
    const held = deferred<OwnerHold>();
    const projects = new ProjectHaltRepository(db);
    const interrupted = async (task: { readonly attempt: number }): Promise<ExecutionResult> => ({
      status: "interrupted",
      detail: "attempt interrupted by shutdown after 2 turn(s)",
      outcome: {
        turnsUsed: 2,
        cost: { measured: true, totalUsd: 0, turns: 2 },
        lastToolCall: null,
        promptDigest: "0".repeat(64),
        detail: "stopped",
        kind: "cancelled",
        reason: new Error("shutdown"),
      },
      sessionId: "test-session",
      attempt: task.attempt,
      errorEnvelope: { outcome: "blocked", summary: "shutdown", chain: { boundary: "development", operation: "agentAttempt", message: "shutdown", timestamp: new Date().toISOString() } },
    });
    const loop = new CoreLoop(
      composedLoopOverTestDb(
        {
          db,
          config: { ...DEFAULT_CONFIG, workdirBase },
          logger: createLogger({ sink: { write: () => undefined }, clock: systemClock, minLevel: "error" }),
          spendCap: { deploymentStop: async () => null, refusalOf: () => null },
          containment: memoryStepContainment(() => true),
          dispatchService: { execute: interrupted },
        },
        {
          loop: {
            eventStore: { publish: holdOnBlocked(taskId, held) },
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

    const cycle = loop.runCycle();
    const owner = await Promise.race([held.promise, cycle.then((): never => {
      throw new OwnerHoldEnded(taskId);
    })]);
    const barrier = await untilChargeWaits(owner.pid, cycle);
    await owner.commit();
    await cycle;

    expect(barrier).toBe("waiting");
    expect(await charged(projectId, taskId)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
  });

  test("a crash orphan the startup reconcile blocks with main unread", async () => {
    const { projectId, taskId, workdirBase } = await unreadTask("startup-orphan", "transient", { status: "InProgress" });
    const held = deferred<OwnerHold>();
    const projects = new ProjectHaltRepository(db);
    const workItems = adaptWorkItemRepo(new WorkItemRowRepository(db));

    const reconciled = reconcileWorkItemsOnStartup({
      workItemRepo: { ...workItems, projectIdsWithStatus: async (status) => (await workItems.projectIdsWithStatus(status)).filter((id) => id === projectId) },
      projects: {
        get: (id) => projects.get(id),
        block: (id, cause) => projects.block(id, cause),
        listWithWorkspace: async () => [],
      },
      eventStore: { publish: holdOnBlocked(taskId, held) },
      // No Failed task is routed: the reconcile reads this project's rows alone, and it has none Failed.
      failureRouter: new FailureRouter(2),
      devSessionStore: { dispatchEvidence: async () => ({ latestPhase: null, orphanedBefore: 0 }) },
      workdirBase,
      logger: createLogger({ sink: { write: () => undefined }, clock: systemClock, minLevel: "error" }),
    });
    const owner = await Promise.race([held.promise, reconciled.then((): never => {
      throw new OwnerHoldEnded(taskId);
    })]);
    const barrier = await untilChargeWaits(owner.pid, reconciled);
    await owner.commit();

    expect(barrier).toBe("waiting");
    expect(await reconciled).toMatchObject({ orphansBlocked: 1 });
    expect(await charged(projectId, taskId)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
  });
});
