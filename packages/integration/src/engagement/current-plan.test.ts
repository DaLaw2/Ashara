import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { listProjectBurns, readChangeImpact } from "@ashara/engagement";
import type { ProjectId } from "@ashara/shared";
import { createWorkItemId } from "@ashara/shared";

// Delivery publishes two sets of a plan's tasks, and Engagement's readers each take the one their
// purpose needs: the burn warning counts every task of the current plan (inCurrentPlan), a given-up
// task among them, since the plan was repaired around it and its share of the work stays planned;
// a correction's impact lists only the tasks live in it (liveInCurrentPlan), since no work of a
// given-up task is left for a correction to touch. A task a revision superseded is in neither. An
// Abandoned task that records no reason was not superseded, so it reads as given up. Every row
// belongs to a project this suite creates; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const BUDGETS = { perTaskRequests: 50, perProjectRequests: 20, verificationReservePercent: 25 };

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<ProjectId>();

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`current-plan-test-${randomUUID()}`)).id;
});

afterAll(async () => {
  for (const id of ourProjects) {
    await db.execute(sql`DELETE FROM plan_repairs WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM work_items WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

/** A project at work whose implementation tasks all cite G1, one per status and blocked reason. */
async function planWithEveryEnding(): Promise<ProjectId> {
  const projectId = (await new ProjectHaltRepository(db).create(`current-plan-test-${randomUUID().slice(0, 8)}`, clientId)).id;
  ourProjects.add(projectId);
  const spec = JSON.stringify({ origin: "decomposition", sources: [{ id: "G1" }] });
  const task = (title: string, status: string, blockedReason: unknown) => sql`
    (${createWorkItemId()}, 'Task', ${status}, ${title}, ${projectId}, 'implementation', ${randomUUID()}, ${spec}::jsonb,
     ${blockedReason === null ? null : JSON.stringify(blockedReason)}::jsonb)`;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, blocked_reason) VALUES
    ${task("pending", "Pending", null)},
    ${task("merged", "Completed", null)},
    ${task("given up", "Abandoned", { source: "failure_given_up", reason: "kept failing", attempts: 3 })},
    ${task("abandoned with no reason", "Abandoned", null)},
    ${task("superseded", "Abandoned", { source: "superseded", revision: 1, reason: "replaced" })}`);
  return projectId;
}

describe("the current plan's tasks, as each reader needs them", () => {
  test("a correction's impact lists only the live tasks citing the key; the burn counts given-up tasks too, and neither a superseded one", async () => {
    const projectId = await planWithEveryEnding();

    const impact = await readChangeImpact(db, projectId, ["G1"], BUDGETS);
    expect(impact.tasks.map((task) => [task.title, task.status]).sort()).toEqual([
      ["merged", "merged"],
      ["pending", "pending"],
    ]);

    const [burn] = (await listProjectBurns(db)).filter((row) => row.projectId === projectId);
    expect(burn).toMatchObject({ plannedTasks: 4, completedTasks: 1 });
  });
});

// A task merged on main whose merge record could not be written (Blocked, merge_unrecorded) is merged
// work to a correction's impact: it reads as merged, and the requests it drew are a basis for the
// correction's cost band beside a Completed task's.
describe("a correction's impact reads merged work with its record unwritten as merged", () => {
  test("it is merged among the citing tasks and counted among the tasks whose drawn requests set the cost band", async () => {
    const projectId = (await new ProjectHaltRepository(db).create(`current-plan-test-${randomUUID().slice(0, 8)}`, clientId)).id;
    ourProjects.add(projectId);
    const spec = JSON.stringify({ origin: "decomposition", sources: [{ id: "G1" }] });
    const unrecorded = JSON.stringify({ source: "merge_unrecorded", mergeCommit: "a".repeat(40), mergeKind: "merged", reason: "the merge record could not be written" });
    const failed = JSON.stringify({ source: "task_failed", reason: "its checks did not pass" });
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, blocked_reason) VALUES
      (${createWorkItemId()}, 'Task', 'Completed', 'recorded', ${projectId}, 'implementation', ${randomUUID()}, ${spec}::jsonb, NULL),
      (${createWorkItemId()}, 'Task', 'Blocked', 'unrecorded', ${projectId}, 'implementation', ${randomUUID()}, ${spec}::jsonb, ${unrecorded}::jsonb),
      (${createWorkItemId()}, 'Task', 'Blocked', 'failed', ${projectId}, 'implementation', ${randomUUID()}, ${spec}::jsonb, ${failed}::jsonb)`);

    const impact = await readChangeImpact(db, projectId, ["G1"], BUDGETS);
    expect(impact.tasks.map((task) => [task.title, task.status]).sort()).toEqual([
      ["failed", "blocked"],
      ["recorded", "merged"],
      ["unrecorded", "merged"],
    ]);
    expect(impact.completedTaskRequests).toHaveLength(2);
  });
});
