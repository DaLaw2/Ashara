import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { CoreLoop, DEFAULT_CONFIG, ProjectHaltRepository, WorkItemRowRepository } from "@ashara/delivery";
import type { CoreLoopDeps } from "@ashara/delivery";
import { createWorkItemId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";

// The core loop keeps every lane busy: a lane whose task settles takes the next eligible task at once,
// re-gated against the database, and never waits for the task of another lane. Against Postgres, with
// the production pool (concurrentTaskLanes) and a fake agent that only takes time: each attempt ends
// in a throw, routed as an uncharged infrastructure fault, so no model call or cell is made.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `lanes-stay-busy-test-${randomUUID().slice(0, 8)}`;
const LONG_MS = 1_500;
const SHORT_MS = 50;

type Db = Database;
let db: Db;
let root = "";

/** How the fake agent's attempt at a task ends once its time is up. */
class FakeAgentEnded extends Error {
  constructor(readonly title: string) {
    super(`the fake agent's attempt at "${title}" ended`);
    this.name = "FakeAgentEnded";
  }
}

/** When one fake attempt started and settled, by the wall clock. */
interface Span {
  readonly title: string;
  readonly startedAt: number;
  settledAt: number | null;
}

type CycleTally = Parameters<CoreLoopDeps["loop"]["cycleLog"]["emit"]>[0];

/**
 * A project with independent Pending tasks, oldest first in the order given, so the first two lanes
 * take the first two; by default the long one and two short ones.
 */
async function project(label: string, titles: readonly string[] = ["long", "short one", "short two"]): Promise<{ readonly projectId: ProjectId; readonly titles: readonly string[] }> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(NAME, client.id)).id;
  const at = Date.parse("2026-10-22T00:00:00Z");
  for (const [index, title] of titles.entries()) {
    await new WorkItemRowRepository(db).create({
      id: createWorkItemId(),
      level: "Task",
      status: "Pending",
      title,
      taskSpec: { goal: title, origin: "sprint0" },
      projectId,
      createdAt: new Date(at + index * 1_000),
    });
  }
  return { projectId, titles };
}

/**
 * The loop over `projectId` alone, two lanes, its agent `execute`; every cycle's tally lands in
 * `tallies`. `dueMessages` stands for the client's messages owed a receipt, none by default.
 */
function loopOver(
  projectId: ProjectId,
  execute: (title: string) => Promise<never>,
  tallies: CycleTally[],
  dueMessages: () => Promise<ReadonlySet<string>> = async () => new Set(),
): CoreLoop {
  const projects = new ProjectHaltRepository(db);
  const workdirBase = join(root, projectId);
  return new CoreLoop(
    composedLoopOverTestDb(
      {
        db,
        config: { ...DEFAULT_CONFIG, workdirBase, laneCount: 2 },
        logger: recordingLogger(),
        spendCap: { deploymentStop: async () => null, refusalOf: () => null },
        containment: memoryStepContainment(() => true),
        dispatchService: { execute: (descriptor) => execute(descriptor.title) },
      },
      {
        client: { clientReceipts: { runPending: async () => [], dueMessages } },
        loop: {
          cycleLog: { emit: (tally) => void tallies.push(tally) },
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

/** A fake agent that takes `durations[title]` (SHORT_MS when absent) on each task, LONG_MS on "long", recording each span. */
function timedAgent(
  spans: Span[],
  onShortSettled: (title: string) => Promise<void> = async () => {},
  durations: Readonly<Record<string, number>> = { long: LONG_MS },
): (title: string) => Promise<never> {
  return async (title) => {
    const span: Span = { title, startedAt: Date.now(), settledAt: null };
    spans.push(span);
    const ms = durations[title];
    await delay(ms === undefined ? SHORT_MS : ms);
    if (ms === undefined) await onShortSettled(title);
    span.settledAt = Date.now();
    throw new FakeAgentEnded(title);
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-lanes-stay-busy-")));
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

describe("the core loop's lanes", () => {
  test("a lane whose short task settled takes the third task while the long one still runs", async () => {
    const { projectId } = await project("refill");
    const spans: Span[] = [];
    const tallies: CycleTally[] = [];

    const cycle = await loopOver(projectId, timedAgent(spans), tallies).runCycle();

    const span = (title: string) => spans.find((each) => each.title === title);
    expect(spans.map((each) => each.title).sort()).toEqual(["long", "short one", "short two"]);
    const long = span("long");
    const third = span("short two");
    expect(long?.settledAt).not.toBeNull();
    expect(third?.startedAt).toBeLessThan(long?.settledAt ?? Number.NEGATIVE_INFINITY);
    expect(cycle.results.map((result) => result.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
    expect(tallies).toEqual([expect.objectContaining({ event: "cycle_complete", eligible: 3, dispatched: 3, lanes: 2, tasksProcessed: 3 })]);
  });

  test("a lane freed by the last of the first two tasks takes the next eligible one while a task started later still runs", async () => {
    const titles = ["first long", "short", "second long", "fourth"];
    const { projectId } = await project("chain", titles);
    const spans: Span[] = [];
    const tallies: CycleTally[] = [];
    const agent = timedAgent(spans, async () => {}, { "first long": 600, "second long": LONG_MS });

    await loopOver(projectId, agent, tallies).runCycle();

    const span = (title: string) => spans.find((each) => each.title === title);
    expect(spans.map((each) => each.title).sort()).toEqual([...titles].sort());
    const firstLong = span("first long");
    const secondLong = span("second long");
    const fourth = span("fourth");
    expect(firstLong?.settledAt).not.toBeNull();
    expect(fourth?.startedAt).toBeGreaterThanOrEqual(firstLong?.settledAt ?? Number.POSITIVE_INFINITY);
    expect(fourth?.startedAt).toBeLessThan(secondLong?.settledAt ?? Number.NEGATIVE_INFINITY);
    expect(tallies).toEqual([expect.objectContaining({ eligible: 4, dispatched: 4, lanes: 2 })]);
  });

  test("a message of the client's arriving while the lanes run stops the refills, so the cycle's steps read it once the lanes settle", async () => {
    const { projectId } = await project("message");
    const spans: Span[] = [];
    const tallies: CycleTally[] = [];
    let arrived = false;
    const due = async (): Promise<ReadonlySet<string>> => new Set(arrived ? ["receipt:lanes-test-message"] : []);

    const cycle = await loopOver(projectId, timedAgent(spans, async () => void (arrived = true)), tallies, due).runCycle();

    expect(spans.map((each) => each.title).sort()).toEqual(["long", "short one"]);
    expect(spans.every((each) => each.settledAt !== null)).toBe(true);
    expect(cycle.tasksProcessed).toBe(2);
    expect(tallies).toEqual([expect.objectContaining({ eligible: 3, dispatched: 2, lanes: 2 })]);
  });

  test("a project halted while its long task runs gets no refill, and the long task still settles in its lane", async () => {
    const { projectId } = await project("halt");
    const projects = new ProjectHaltRepository(db);
    const spans: Span[] = [];
    const tallies: CycleTally[] = [];
    const halt = async () => {
      await projects.block(projectId, { category: "fault", errorClass: "LanesTestHalt", reason: "halted while a lane ran" });
    };

    const cycle = await loopOver(projectId, timedAgent(spans, halt), tallies).runCycle();

    expect(spans.map((each) => each.title).sort()).toEqual(["long", "short one"]);
    expect(spans.every((each) => each.settledAt !== null)).toBe(true);
    expect(cycle.tasksProcessed).toBe(2);
    expect(tallies).toEqual([expect.objectContaining({ eligible: 3, dispatched: 2, lanes: 2 })]);
  });
});
