import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClientRepository, DEFAULT_DATABASE_URL, ProjectRepository, createDb, devSessions, workItems } from "@ashara/db";
import type { Database } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { DevSessionRepository } from "@ashara/workplace";

// Workplace's session log against real Postgres: one insert -> read round trip.

let db: Database;
let testProjectId: ProjectId;
let testClientId: string;
const taskId = randomUUID();
const sessionId = randomUUID();

beforeAll(async () => {
  db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const nonce = randomUUID().slice(0, 8);
  testClientId = (await new ClientRepository(db).create(`dev-session-intg-${nonce}`)).id;
  testProjectId = (await new ProjectRepository(db).create(`dev-session-intg-${nonce}`, testClientId)).id;
  // A session requires a valid work_items FK; the work item's repository is Delivery's.
  await db.insert(workItems).values({ id: taskId, level: "Task", status: "Pending", title: "Task for DevSession test", projectId: testProjectId });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM dev_sessions WHERE id = ${sessionId}`);
  await db.execute(sql`DELETE FROM work_items WHERE id = ${taskId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${testProjectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
  await db.$client.end();
});

describe("DevSessionRepository", () => {
  test("insert creates a session and it can be read back", async () => {
    const brief = { instructions: "do something" };
    const environmentVersion = "e".repeat(64);
    await new DevSessionRepository(db).insert(sessionId, taskId, brief, environmentVersion);

    const [row] = await db.select().from(devSessions).where(sql`${devSessions.id} = ${sessionId}`).limit(1);

    expect(row).toBeDefined();
    expect(row?.id).toBe(sessionId);
    expect(row?.taskId).toBe(taskId);
    expect(row?.phase).toBe("Preparing");
    expect(row?.brief).toEqual(brief);
    expect(row?.environmentVersion).toBe(environmentVersion);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
});
