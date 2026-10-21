import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl, workItems, type Database } from "@ashara/db";
import { completedGoalTasks, goalTaskSql, isGoalTask } from "@ashara/delivery/predicates";
import type { ProjectId } from "@ashara/shared";

// Every row here belongs to a project this suite creates under a unique name; deleting the project
// deletes its work items.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
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

  // SQL readers (Engagement's given-up goal tasks, Quality's acceptance readiness) take goalTaskSql;
  // it must select exactly the rows isGoalTask names, whatever their level, origin or status.
  test("goalTaskSql selects exactly the rows isGoalTask names, across levels, origins, a missing origin and statuses", async () => {
    const own = (await new ProjectRepository(db).create(`goal-tasks-test-${NONCE}-sql`, (await new ClientRepository(db).create(`goal-tasks-test-${NONCE}-sql-client`)).id)).id;
    const rows = [
      { level: "Epic", origin: "decomposition", status: "Completed" },
      { level: "Task", origin: "decomposition", status: "Completed" },
      { level: "Task", origin: "decomposition", status: "Abandoned" },
      { level: "Task", origin: "decomposition", status: "Pending" },
      { level: "Task", origin: "review", status: "Completed" },
      { level: "Task", origin: "environment-change", status: "Abandoned" },
      { level: "Task", origin: "sprint0", status: "Completed" },
      { level: "Task", origin: null, status: "Completed" },
    ] as const;
    const fixture = rows.map((row) => ({ ...row, id: randomUUID() }));
    await db.insert(workItems).values(
      fixture.map((row, i) => ({
        id: row.id,
        level: row.level,
        status: row.status,
        title: `row ${i}`,
        taskSpec: row.origin === null ? {} : { origin: row.origin },
        projectId: own,
      })),
    );

    const selected = await db.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.projectId, own), goalTaskSql));
    const expected = fixture.filter((row) => isGoalTask(row)).map((row) => row.id);
    expect(new Set(selected.map((row) => row.id))).toEqual(new Set(expected));
    expect(expected).toHaveLength(3);
  });
});
