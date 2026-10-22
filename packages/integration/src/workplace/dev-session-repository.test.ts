import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { workItems } from "@ashara/db/schema/delivery";
import { devSessions } from "@ashara/db/schema/workplace";
import type { Database, DbTransaction } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { DevSessionRepository, ORPHANED_SESSION_RESOLVER, sessionEvidenceOf, terminalizeOrphanedSessions } from "@ashara/workplace";

// Workplace's session log against real Postgres: its writes, its terminal writes' guard, and the
// end record parsed on every write and read.

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

describe("DevSessionRepository terminal writes", () => {
  const repo = () => new DevSessionRepository(db);

  test("an ended session is never rewritten: failing a Completed session is refused and the row stays Completed", async () => {
    const id = randomUUID();
    await repo().insert(id, taskId, {}, null, "test-trace");
    await repo().complete(id, null, { outcome: "completed", detail: "delivered" });

    await expect(repo().fail(id, { outcome: "failed", detail: "a late failure" }, null)).rejects.toMatchObject({
      name: "SessionTerminalWriteRefused",
      sessionId: id,
      phaseFound: "Completed",
    });
    await expect(repo().complete(id, null, { outcome: "completed", detail: "again" })).rejects.toMatchObject({
      name: "SessionTerminalWriteRefused",
      phaseFound: "Completed",
    });

    const [row] = await db.select().from(devSessions).where(sql`${devSessions.id} = ${id}`);
    expect(row?.phase).toBe("Completed");
    expect(row?.verificationResult).toEqual({ outcome: "completed", detail: "delivered" });
  });

  test("a terminal write to an id no session has is refused, never a silent no-op", async () => {
    const missing = randomUUID();
    await expect(repo().complete(missing, null, { outcome: "completed", detail: "x" })).rejects.toMatchObject({
      name: "SessionTerminalWriteRefused",
      sessionId: missing,
      phaseFound: null,
    });
    await expect(repo().fail(missing, { outcome: "failed", detail: "x" }, null)).rejects.toMatchObject({
      name: "SessionTerminalWriteRefused",
      sessionId: missing,
      phaseFound: null,
    });
  });

  test("an end record outside the schema is refused before the write, and the session stays open", async () => {
    const phase = await rolledBack(async (tx) => {
      const txRepo = new DevSessionRepository(tx);
      const id = randomUUID();
      await txRepo.insert(id, taskId, {}, null, "test-trace");
      await expect(txRepo.fail(id, { outcome: "completed", detail: "a failure dressed as a completion" }, null)).rejects.toBeInstanceOf(z.ZodError);
      // @ts-expect-error a failed end names its detail: fail's end record is typed, never unknown
      await expect(txRepo.fail(id, { outcome: "failed" }, null)).rejects.toBeInstanceOf(z.ZodError);
      await expect(
        txRepo.failStale(
          { outcome: "abandoned", detail: "x", resolvedBy: "", resolvedAt: new Date().toISOString() },
          { outcome: "abandoned", detail: "x", resolvedBy: "r", resolvedAt: "yesterday" },
          [],
        ),
      ).rejects.toBeInstanceOf(z.ZodError);
      const [row] = await tx.select({ phase: devSessions.phase }).from(devSessions).where(sql`${devSessions.id} = ${id}`);
      return row?.phase;
    });
    expect(phase).toBe("Preparing");
  });

  test("an end record the schema does not admit is never read as evidence", async () => {
    const plantMalformed = async (tx: DbTransaction) => {
      const id = randomUUID();
      await new DevSessionRepository(tx).insert(id, taskId, {}, null, "test-trace");
      await tx.execute(sql`UPDATE dev_sessions SET phase = 'Failed', verification_result = '{"resolvedBy": 7}'::jsonb WHERE id = ${id}`);
    };
    await expect(
      rolledBack(async (tx) => {
        await plantMalformed(tx);
        return new DevSessionRepository(tx).dispatchEvidence(taskId, ORPHANED_SESSION_RESOLVER);
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      rolledBack(async (tx) => {
        await plantMalformed(tx);
        return sessionEvidenceOf(tx, [taskId]);
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
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
