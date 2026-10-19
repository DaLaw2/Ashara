import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, ProjectRepository, createDb, devSessions, workItems, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database, DbTransaction } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { DevSessionRepository, ORPHANED_SESSION_RESOLVER, terminalizeOrphanedSessions } from "@ashara/workplace";

// Workplace's session log against real Postgres: one insert -> read round trip.

let db: Database;
let testProjectId: ProjectId;
let testClientId: string;
const taskId = randomUUID();
const sessionId = randomUUID();
const crashedTaskId = randomUUID();
const endedTaskId = randomUUID();

beforeAll(async () => {
  db = createDb(resolveTestDatabaseUrl(process.env));
  const nonce = randomUUID().slice(0, 8);
  testClientId = (await new ClientRepository(db).create(`dev-session-intg-${nonce}`)).id;
  testProjectId = (await new ProjectRepository(db).create(`dev-session-intg-${nonce}`, testClientId)).id;
  // A session requires a valid work_items FK; the work item's repository is Delivery's.
  await db.insert(workItems).values({ id: taskId, level: "Task", status: "Pending", title: "Task for DevSession test", projectId: testProjectId });
  // Both stay Pending: the reconcile reads which tasks the start found InProgress from its caller.
  await db.insert(workItems).values({ id: crashedTaskId, level: "Task", status: "Pending", title: "Task whose dispatch died", projectId: testProjectId });
  await db.insert(workItems).values({ id: endedTaskId, level: "Task", status: "Pending", title: "Task whose dispatch ended", projectId: testProjectId });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (${taskId}, ${crashedTaskId}, ${endedTaskId})`);
  await db.execute(sql`DELETE FROM work_items WHERE id IN (${taskId}, ${crashedTaskId}, ${endedTaskId})`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${testProjectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
  await db.$client.end();
});

describe("DevSessionRepository", () => {
  test("insert creates a session and it can be read back", async () => {
    const brief = { instructions: "do something" };
    const environmentVersion = "e".repeat(64);
    const traceId = randomUUID();
    await new DevSessionRepository(db).insert(sessionId, taskId, brief, environmentVersion, traceId);

    const [row] = await db.select().from(devSessions).where(sql`${devSessions.id} = ${sessionId}`).limit(1);

    expect(row).toBeDefined();
    expect(row?.id).toBe(sessionId);
    expect(row?.taskId).toBe(taskId);
    expect(row?.phase).toBe("Preparing");
    expect(row?.brief).toEqual(brief);
    expect(row?.environmentVersion).toBe(environmentVersion);
    // The session carries the trace of the attempt it was opened in.
    expect(row?.traceId).toBe(traceId);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  test("a session left open by an ended dispatch is closed at startup, but never counted as a crash orphan", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The startup reconcile closes every open session in the database, other test files' included,
    // so it runs in a transaction that is rolled back.
    const evidence = await rolledBack(async (tx) => {
      const repo = new DevSessionRepository(tx);
      // Both sessions are open: one's agent died with the process, the other's terminal write was lost.
      await repo.insert(randomUUID(), crashedTaskId, {}, null, "test-trace");
      await repo.insert(randomUUID(), endedTaskId, {}, null, "test-trace");
      const reconcile = await terminalizeOrphanedSessions(repo, [crashedTaskId]);
      return {
        reconcile,
        crashed: await repo.dispatchEvidence(crashedTaskId, ORPHANED_SESSION_RESOLVER),
        ended: await repo.dispatchEvidence(endedTaskId, ORPHANED_SESSION_RESOLVER),
      };
    });

    expect(evidence).toEqual({
      reconcile: { kind: "terminalized", orphaned: 1, ended: expect.any(Number) },
      crashed: { latestPhase: "Failed", orphanedBefore: 1 },
      ended: { latestPhase: "Failed", orphanedBefore: 0 },
    });
    vi.restoreAllMocks();
  });
});

/** Thrown to end `rolledBack`'s transaction, carrying what its body returned. */
class RolledBack extends Error {
  constructor(readonly value: unknown) {
    super("rolled back by the test");
    this.name = "RolledBack";
  }
}

/** Runs `body` in a transaction that is always rolled back, and returns what it returned. */
async function rolledBack(body: (tx: DbTransaction) => Promise<unknown>): Promise<unknown> {
  try {
    await db.transaction(async (tx) => {
      throw new RolledBack(await body(tx));
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.value;
    throw err;
  }
  throw new RolledBack("the transaction committed, which its body never lets it do");
}
