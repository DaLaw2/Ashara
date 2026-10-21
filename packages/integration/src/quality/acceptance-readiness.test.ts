import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type * as WorkItemLanguage from "@ashara/delivery/work-item";
import { OPEN_WORK_ITEM_STATUSES } from "@ashara/delivery/work-item";
import { createProjectWithTender, VisionRepository } from "@ashara/engagement";
import { listProjectsReadyForAcceptance } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";

// Acceptance readiness reads which statuses are settled from Delivery's work-item language, never a
// list of its own. A status Delivery has not named settled must hold a project back from acceptance
// whatever Quality knows of it, so this file stands in a language that names Abandoned open: a
// readiness query that lists the open statuses itself reads a project with an Abandoned task ready.
vi.mock("@ashara/delivery/work-item", async (importOriginal) => {
  const language = await importOriginal<typeof WorkItemLanguage>();
  return {
    ...language,
    SETTLED_WORK_ITEM_STATUSES: language.SETTLED_WORK_ITEM_STATUSES.filter((status) => status !== "Abandoned"),
    OPEN_WORK_ITEM_STATUSES: [...language.OPEN_WORK_ITEM_STATUSES, "Abandoned"],
  };
});

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `acceptance-readiness-test-${randomUUID().slice(0, 8)}`;
const TENDER = "A key store. Clients put and get keys.";

let db: ReturnType<typeof createDb>;
let clientId: string;

/** A planned project whose one goal task is Completed, with `other` tasks beside it in the given statuses. */
async function plannedProject(other: readonly string[]): Promise<ProjectId> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  await new VisionRepository(db).create(project.id, { visionText: TENDER, summary: "A key store.", inferences: [] });
  await db.execute(sql`UPDATE projects SET first_planned_at = now(), workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  for (const [index, status] of ["Completed", ...other].entries()) {
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, task_spec, project_id)
      VALUES (${randomUUID()}, 'Task', ${status}, ${`Task ${index}`}, ${JSON.stringify({ origin: "decomposition" })}::jsonb, ${project.id})`);
  }
  return project.id;
}

async function ready(projectId: ProjectId): Promise<boolean> {
  return (await listProjectsReadyForAcceptance(db)).some((row) => row.projectId === projectId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

afterAll(async () => {
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${`${NAME_PREFIX}%`}`;
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${`${NAME_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("acceptance readiness over Delivery's open statuses", () => {
  test("a project whose every task is settled reads ready", async () => {
    expect(await ready(await plannedProject(["Completed"]))).toBe(true);
  });

  test.each(OPEN_WORK_ITEM_STATUSES)("a project with a task %s, an open status, is not ready", async (status) => {
    expect(await ready(await plannedProject([status]))).toBe(false);
  });
});
