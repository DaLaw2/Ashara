import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { workItems } from "../schema/index.js";
import { ClientRepository } from "./client.js";
import { completedGoalTasks, isGoalTask } from "./goal-tasks.js";
import { ProjectRepository } from "./project.js";

// Every row here belongs to a project this suite creates under a unique name; deleting the project
// deletes its work items.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projectId: ProjectId;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const clientId = (await new ClientRepository(db).create(`goal-tasks-test-${NONCE}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`goal-tasks-test-${NONCE}-project`, clientId)).id;
});

afterAll(async () => {
  const pattern = `goal-tasks-test-${NONCE}-%`;
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("completedGoalTasks and isGoalTask: one definition of a goal task", () => {
  // A goal task is a Task whose task_spec.origin is 'decomposition', whatever its work kind: a
  // reading by work kind would miss the first two items and is not the definition.
  test("a decomposed Task is a goal task whatever its work kind, and both readers classify every row alike", async () => {
    const epic = randomUUID();
    const rows = [
      { id: randomUUID(), level: "Task", workKind: "check", origin: "decomposition", goal: true },
      { id: randomUUID(), level: "Task", workKind: null, origin: "decomposition", goal: true },
      { id: randomUUID(), level: "Task", workKind: "implementation", origin: "decomposition", goal: true },
      { id: randomUUID(), level: "Task", workKind: "implementation", origin: "product-scaffold", goal: false },
      { id: randomUUID(), level: "Task", workKind: "check", origin: "check", goal: false },
    ] as const;
    await db.insert(workItems).values({ id: epic, level: "Epic", status: "Completed", title: "epic", projectId });
    await db.insert(workItems).values(
      rows.map((row, i) => ({
        id: row.id,
        level: row.level,
        status: "Completed",
        parentId: epic,
        title: `task ${i}`,
        taskSpec: { origin: row.origin },
        projectId,
        workKind: row.workKind,
        ownerRoleId: row.workKind === null ? null : randomUUID(),
      })),
    );

    const listed = new Set((await completedGoalTasks(db, projectId)).map((row) => row.id));
    for (const row of rows) {
      expect({ id: row.id, listed: listed.has(row.id), predicate: isGoalTask(row) }).toEqual({ id: row.id, listed: row.goal, predicate: row.goal });
    }
    expect(listed.has(epic)).toBe(false);
  });
});
