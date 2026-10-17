import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, DEFAULT_DATABASE_URL, ProjectRepository, createDb } from "@ashara/db";
import type { Database } from "@ashara/db";
import { WorkItemRowRepository } from "@ashara/delivery";
import type { ProjectId } from "@ashara/shared";

// Delivery's work item repository (O1): one insert -> read round trip against real Postgres, for
// the mechanics a mocked database cannot verify (jsonb, defaults, FK wiring).

let db: Database;
let projectId: ProjectId;
let clientId: string;
const epicId = randomUUID();
const taskIds: string[] = [];

beforeAll(async () => {
  db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const nonce = randomUUID().slice(0, 8);
  clientId = (await new ClientRepository(db).create(`delivery-wi-${nonce}`)).id;
  projectId = (await new ProjectRepository(db).create(`delivery-wi-${nonce}`, clientId)).id;
});

afterAll(async () => {
  for (const id of taskIds) await db.execute(sql`DELETE FROM work_items WHERE id = ${id}`);
  await db.execute(sql`DELETE FROM work_items WHERE id = ${epicId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("WorkItemRowRepository", () => {
  test("create inserts a work item and findById reads it back", async () => {
    const repo = new WorkItemRowRepository(db);
    const created = await repo.create({
      id: epicId,
      level: "Epic",
      status: "Pending",
      parentId: null,
      title: "Integration Test Epic",
      description: "Epic for integration testing",
      taskSpec: { type: "test" },
      northStar: "Verify all repos work",
      successCriteria: ["tests pass"],
      blockedReason: null,
      projectId,
    });
    expect(created.id).toBe(epicId);
    expect(created.taskSpec).toEqual({ type: "test" });

    const row = await repo.findById(epicId);
    expect(row).toMatchObject({ id: epicId, title: "Integration Test Epic", status: "Pending" });
  });
});

/** A task InProgress on its second dispatch, found InProgress by one startup already. */
async function crashedOnceTask(repo: WorkItemRowRepository): Promise<string> {
  const id = randomUUID();
  taskIds.push(id);
  await repo.create({ id, level: "Task", status: "InProgress", parentId: null, title: "crash orphan count", blockedReason: null, projectId, dispatchCount: 2 });
  expect(await repo.recordCrashOrphan(id)).toBe(1);
  return id;
}

async function countsOf(id: string): Promise<{ crashOrphans: number; dispatchCount: number }> {
  const result = await db.execute(sql`SELECT crash_orphans AS "crashOrphans", dispatch_count AS "dispatchCount" FROM work_items WHERE id = ${id}`);
  return z.object({ crashOrphans: z.number(), dispatchCount: z.number() }).parse(result.rows[0]);
}

function movedTo(id: string, status: string) {
  return { id, status, blockedReason: null, failureVerdict: null, updatedAt: new Date() };
}

// The crash-loop bound (ADR-084 d1) reads crash_orphans: a dispatch that ended in its own process
// sets it back to 0 in the write that routes it out of InProgress, never in a write of its own a
// fault could lose while the routing commits.
describe("WorkItemRowRepository: the startups in a row that found a task InProgress", () => {
  test("go back to 0 in the same write that routes the task out of InProgress", async () => {
    const repo = new WorkItemRowRepository(db);
    const id = await crashedOnceTask(repo);
    await repo.save(movedTo(id, "Pending"), "InProgress");
    expect(await countsOf(id)).toEqual({ crashOrphans: 0, dispatchCount: 2 });
  });

  test("go back to 0 with a refunded routing too", async () => {
    const repo = new WorkItemRowRepository(db);
    const id = await crashedOnceTask(repo);
    expect(await repo.saveRefunded(movedTo(id, "Pending"), "InProgress")).toBe(1);
    expect(await countsOf(id)).toEqual({ crashOrphans: 0, dispatchCount: 1 });
  });

  test("stay as they were when the routing write itself is refused", async () => {
    const repo = new WorkItemRowRepository(db);
    const id = await crashedOnceTask(repo);
    await expect(repo.save(movedTo(id, "Completed"), "Pending")).rejects.toThrow();
    expect(await countsOf(id)).toEqual({ crashOrphans: 1, dispatchCount: 2 });
  });

  test("are kept by the startup reconciler's exit of a crash orphan, whose dispatch did not end", async () => {
    const repo = new WorkItemRowRepository(db);
    const kept = await crashedOnceTask(repo);
    await repo.saveOrphanExit(movedTo(kept, "Pending"), "InProgress", "keep-counted");
    expect(await countsOf(kept)).toEqual({ crashOrphans: 1, dispatchCount: 2 });
    const refunded = await crashedOnceTask(repo);
    await repo.saveOrphanExit(movedTo(refunded, "Pending"), "InProgress", "refund");
    expect(await countsOf(refunded)).toEqual({ crashOrphans: 1, dispatchCount: 1 });
  });
});

// t-context-overflow-routing: the largest window a task overflowed is what its next dispatch must
// exceed, so a later, smaller record never lowers it, and it survives every routing of the task.
describe("WorkItemRowRepository: the largest context window an attempt of a task did not fit", () => {
  test("is null until recorded, rises to the largest recorded, never falls, and is read back with the item", async () => {
    const repo = new WorkItemRowRepository(db);
    const id = randomUUID();
    taskIds.push(id);
    await repo.create({ id, level: "Task", status: "InProgress", parentId: null, title: "overflowed window", blockedReason: null, projectId });
    expect((await repo.findById(id))?.overflowedWindowTokens).toBeNull();

    await repo.recordOverflowedWindow(id, 64_000);
    await repo.recordOverflowedWindow(id, 32_000);
    expect((await repo.findById(id))?.overflowedWindowTokens).toBe(64_000);

    await repo.save(movedTo(id, "Pending"), "InProgress");
    expect((await repo.findById(id))?.overflowedWindowTokens).toBe(64_000);
  });

  test("of an item that does not exist is refused", async () => {
    await expect(new WorkItemRowRepository(db).recordOverflowedWindow(randomUUID(), 64_000)).rejects.toThrow(/not found/i);
  });
});
