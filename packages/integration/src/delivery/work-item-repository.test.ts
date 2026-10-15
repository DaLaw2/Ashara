import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
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

beforeAll(async () => {
  db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const nonce = randomUUID().slice(0, 8);
  clientId = (await new ClientRepository(db).create(`delivery-wi-${nonce}`)).id;
  projectId = (await new ProjectRepository(db).create(`delivery-wi-${nonce}`, clientId)).id;
});

afterAll(async () => {
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
