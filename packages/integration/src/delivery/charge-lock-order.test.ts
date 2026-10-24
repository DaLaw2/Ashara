import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { adaptWorkItemRepo, createReplanStore, ProjectHaltRepository, releaseClearedBlocks, WorkItemRowRepository } from "@ashara/delivery";
import type { ReplanStore, StoredBlockedReason } from "@ashara/delivery";
import { createLogger, parseWorkItemId, systemClock } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { replanStoreSuite } from "../server/replan-store-suite.js";

// Delivery's transactions that lock a project's row and rows of its work items take the project row
// first (lockProjectRow), FOR NO KEY UPDATE. Against Postgres, a charge for a task's unread main runs
// beside a transaction holding the same project with a deterministic interleaving: the other
// transaction holds what it holds, the charge is let in until it waits on it, then the other goes on
// to take the task's row. Under one lock order and lock strength both commit, with no deadlock
// (40P01), and the charge reads the task as the other left it. A charge that took the task's row
// before the project's, or the project's row FOR UPDATE, deadlocks here; the database client's
// retry of the aborted transaction would hide that from the outcome, so its warning is counted.
// No real LLM call is made.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const suite = replanStoreSuite(stub);
const { plannedProject, itemsOf } = suite;

// Each poll is one query; the bound only ends a run whose transaction never reaches the lock.
const POLL_BOUND = 20_000;
let root = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-charge-lock-order-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The held transaction ended before it held what it was to hold. */
class HoldEnded extends Error {
  constructor(readonly what: string) {
    super(`the transaction holding ${what} ended before it held it`);
    this.name = "HoldEnded";
  }
}

/** No statement of another backend waited on the holder's locks, nor did the watched work settle, within the poll bound. */
class NeverWaited extends Error {
  constructor(
    readonly holderPid: number,
    readonly polls: number,
  ) {
    super(`no statement waited on the locks of backend ${holderPid}, and the watched work did not settle, in ${polls} polls`);
    this.name = "NeverWaited";
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

/** A transaction left open on its own connection after `hold` ran in it, until `release`; `then` runs before its commit. */
interface Held {
  readonly pid: number;
  readonly release: (then?: (tx: Parameters<Parameters<typeof suite.db.transaction>[0]>[0]) => Promise<void>) => Promise<void>;
}

async function holdOpen(what: string, hold: (tx: Parameters<Parameters<typeof suite.db.transaction>[0]>[0]) => Promise<void>): Promise<Held> {
  const holding = deferred<number>();
  const release = deferred<(tx: Parameters<Parameters<typeof suite.db.transaction>[0]>[0]) => Promise<void>>();
  const done = suite.db.transaction(async (tx) => {
    const [backend] = z.array(z.object({ pid: z.number() })).parse((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows);
    if (backend === undefined) throw new HoldEnded(what);
    await hold(tx);
    holding.resolve(backend.pid);
    await (await release.promise)(tx);
  });
  const pid = await Promise.race([
    holding.promise,
    done.then((): never => {
      throw new HoldEnded(what);
    }),
  ]);
  return {
    pid,
    release: async (then = async () => undefined) => {
      release.resolve(then);
      await done;
    },
  };
}

/** The pid of a backend waiting on `holderPid`'s locks, or `settled` once `work` has settled without one. */
async function waiterOn(holderPid: number, work: Promise<unknown>): Promise<number | "settled"> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void work.then(mark, mark);
  for (let polls = 0; polls < POLL_BOUND; polls++) {
    if (settled) return "settled";
    const waiting = await suite.db.execute(sql`SELECT pid FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`);
    const [waiter] = z.array(z.object({ pid: z.number() })).parse(waiting.rows);
    if (waiter !== undefined) return waiter.pid;
  }
  throw new NeverWaited(holderPid, POLL_BOUND);
}

/**
 * How many deadlocks the database met since this was called. The database client runs a transaction
 * a deadlock aborted again (SQLSTATE 40P01), warning of each, so a deadlock leaves both sides
 * committed after the server's deadlock timeout: only its warning tells it happened.
 */
function deadlocksSince(): () => number {
  const warn = vi.spyOn(console, "warn");
  const before = warn.mock.calls.length;
  return () => warn.mock.calls.slice(before).filter((call) => call.some((arg) => typeof arg === "string" && arg.includes("SQLSTATE 40P01"))).length;
}

const unreconciled: StoredBlockedReason = { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge", reason: "git failed" };

/** What a charge could have written: the task's fault count and status, and its project's halts. */
async function charged(projectId: ProjectId, taskId: string): Promise<{ readonly faults: number; readonly status: string; readonly halts: number }> {
  const row = await new WorkItemRowRepository(suite.db).findById(taskId);
  const halts = await suite.db.execute(sql`SELECT count(*)::int AS n FROM project_blocks WHERE project_id = ${projectId}`);
  const [count] = z.array(z.object({ n: z.number() })).parse(halts.rows);
  return { faults: row?.infrastructureFaults ?? -1, status: row?.status ?? "gone", halts: count?.n ?? -1 };
}

/**
 * A planned project whose target's main cannot be read (its `.git` empty, so git fails on it), its
 * goal task parked Blocked orphan_unreconciled: the task whose unread main the charge is for.
 */
async function parkedProject(label: string): Promise<{ readonly projectId: ProjectId; readonly workdirBase: string; readonly items: Awaited<ReturnType<typeof itemsOf>> }> {
  const { projectId } = await plannedProject();
  const workdirBase = join(root, label);
  const target = join(workdirBase, "target");
  await mkdir(join(target, ".git"), { recursive: true });
  await new ProjectHaltRepository(suite.db).recordWorkspacePath(projectId, target);
  const items = await itemsOf(projectId);
  const parked = items.find((i) => i.origin === "decomposition");
  if (parked === undefined) throw new HoldEnded("a goal task of the first plan");
  await new WorkItemRowRepository(suite.db).save({ id: parked.id, status: "Blocked", blockedReason: unreconciled, failureVerdict: null, updatedAt: new Date() }, "Pending");
  return { projectId, workdirBase, items };
}

/** The parked exits of `projectId` alone, over the production repositories: the unread main of its Blocked task is charged. */
function parkedExits(projectId: ProjectId, workdirBase: string, containment: ReturnType<typeof memoryStepContainment>): Promise<number> {
  const projects = new ProjectHaltRepository(suite.db);
  return releaseClearedBlocks({
    workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(suite.db)),
    eventStore: { publish: async () => undefined },
    projects: {
      listActiveIds: async () => [projectId],
      get: (id) => projects.get(id),
      block: (id, cause) => projects.block(id, cause),
    },
    clientQuestions: {
      ask: async (question) => ({ kind: "on-record", questionId: question.questionId }),
      answered: async () => true,
    },
    workdirBase,
    containment,
    logger: createLogger({ sink: { write: () => undefined }, clock: systemClock, minLevel: "error" }),
  });
}

/** A repair revision that supersedes `superseded` in that order, planning nothing new: the replan's own transaction. */
async function repairRevision(projectId: ProjectId, repaired: { readonly id: string; readonly title: string }, superseded: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>): Promise<Parameters<ReplanStore["writeRevision"]>[0]> {
  const versions = await suite.db.execute(sql`SELECT max(version)::int AS version FROM vision_documents WHERE project_id = ${projectId}`);
  const [vision] = z.array(z.object({ version: z.number() })).parse(versions.rows);
  if (vision === undefined) throw new HoldEnded(`the vision of project ${projectId}`);
  const workItems = adaptWorkItemRepo(new WorkItemRowRepository(suite.db));
  const reason: StoredBlockedReason = { source: "superseded", planRevision: 2, requestedBy: null, repairOf: [repaired.id], reason: "repaired around the given-up task" };
  const supersededItems = [];
  for (const each of superseded) {
    const item = await workItems.findById(parseWorkItemId(each.id, "test"));
    if (item === null) throw new HoldEnded(`task ${each.id}`);
    supersededItems.push({ item: { ...item, status: "Abandoned" as const, blockedReason: reason, updatedAt: new Date() }, previousStatus: item.status });
  }
  return {
    projectId,
    revision: 2,
    visionVersion: vision.version,
    corrections: null,
    repaired: [repaired.id],
    superseded: supersededItems,
    plan: { projectId, items: [], edges: [], owners: [], droppedDependencies: [], assumptions: [] },
    existingEdges: [],
    regated: [],
    events: [],
    summary: {
      newTasks: [],
      newCheckTasks: 0,
      newReviewTasks: 0,
      newEnvironmentTask: false,
      supersededTasks: superseded.map((each) => each.title),
      supersededOther: 0,
      keptCompleted: 0,
      assumptions: [],
      repaired: [repaired.title],
    },
  };
}

describe("a charge and another transaction on the same project take its row, then the task's: no deadlock, and the charge reads what the other left", () => {
  test("a replan holding the project row and then superseding the charged task", async () => {
    const { projectId, workdirBase, items } = await parkedProject("replan");
    const check = items.find((i) => i.origin === "check");
    const environment = items.find((i) => i.origin === "sprint0");
    const parked = items.find((i) => i.origin === "decomposition");
    if (check === undefined || environment === undefined || parked === undefined) throw new HoldEnded("Sprint 0, a check task and a goal task");
    // The check task given up: the repair the revision answers (the plan repair trigger records it).
    await new WorkItemRowRepository(suite.db).save({ id: check.id, status: "Abandoned", blockedReason: { source: "api", note: "given up by the owner" }, failureVerdict: null, updatedAt: new Date() }, "Pending");
    const write = await repairRevision(projectId, check, [environment, { ...parked, status: "Blocked" }]);
    const containment = memoryStepContainment(() => true);
    const deadlocks = deadlocksSince();

    // The barrier: the environment task's row, which the replan supersedes first, once its project row is held.
    const barrier = await holdOpen(`task ${environment.id}`, async (tx) => {
      await tx.execute(sql`SELECT id FROM work_items WHERE id = ${environment.id} FOR UPDATE`);
    });
    const replan = createReplanStore(suite.db, recordingLogger()).writeRevision(write);
    const replanPid = await waiterOn(barrier.pid, replan);
    const exits = parkedExits(projectId, workdirBase, containment);
    const chargeWaits = typeof replanPid === "number" ? await waiterOn(replanPid, exits) : "settled";
    await barrier.release();

    expect(typeof replanPid).toBe("number");
    expect(typeof chargeWaits).toBe("number");
    expect(await replan).toBe("written");
    expect(await exits).toBe(0);
    expect(deadlocks()).toBe(0);
    expect(await charged(projectId, parked.id)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
  });

  test("an owner's abandon holding the task's row, whose plan repair row then references the project the charge holds", async () => {
    const { projectId, workdirBase, items } = await parkedProject("owner");
    const parked = items.find((i) => i.origin === "decomposition");
    if (parked === undefined) throw new HoldEnded("a goal task of the first plan");
    const containment = memoryStepContainment(() => true);
    const deadlocks = deadlocksSince();

    const owner = await holdOpen(`task ${parked.id}`, async (tx) => {
      await tx.execute(sql`SELECT id FROM work_items WHERE id = ${parked.id} FOR UPDATE`);
    });
    const exits = parkedExits(projectId, workdirBase, containment);
    const chargeWaits = await waiterOn(owner.pid, exits);
    await owner.release(async (tx) => {
      await new WorkItemRowRepository(tx).save(
        { id: parked.id, status: "Abandoned", blockedReason: { source: "api", note: "abandoned by the owner" }, failureVerdict: null, updatedAt: new Date() },
        "Blocked",
      );
    });

    expect(typeof chargeWaits).toBe("number");
    expect(await exits).toBe(0);
    expect(deadlocks()).toBe(0);
    expect(await charged(projectId, parked.id)).toEqual({ faults: 0, status: "Abandoned", halts: 0 });
    const repairs = await suite.db.execute(sql`SELECT count(*)::int AS n FROM plan_repairs WHERE work_item_id = ${parked.id}`);
    expect(z.array(z.object({ n: z.number() })).parse(repairs.rows)).toEqual([{ n: 1 }]);
  });
});

