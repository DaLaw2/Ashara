import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { TaskCheckRepository } from "@ashara/quality";

// What a check set that holds whole on its foundation is evidence of, read from the records alone:
// the client corrections the plan revisions took in (correction_holds) and the checks of the work
// already merged. Every row belongs to a project this suite creates, and afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `hold-evidence-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let repo: TaskCheckRepository;
let clientId: string;
let projectId: string;
/** When the correction's plan revision was written: the first plan's tasks are older, the revision's are not. */
const REVISED_AT = new Date("2026-10-20T12:00:00Z");
const FIRST_PLAN_AT = new Date("2026-10-20T10:00:00Z");

/** An implementation task citing `cited`, planned at `at`. */
async function task(status: "Pending" | "Completed", cited: readonly string[], at: Date): Promise<string> {
  const id = randomUUID();
  const spec = { goal: "g", endState: "e", scope: "s", deliverables: [], sources: cited.map((key) => ({ type: "scope", id: key, text: `What ${key} states.`, side: "in" })) };
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, created_at, updated_at)
    VALUES (${id}, 'Task', ${status}, ${`Deliver ${cited.join(", ")}`}, ${projectId}, 'implementation', ${randomUUID()}, ${JSON.stringify(spec)}::jsonb, ${at}, ${at})`);
  return id;
}

/** The merged first-plan task whose stored checks decide `decided`. */
async function delivered(decided: readonly [string, ...string[]]): Promise<void> {
  const taskId = await task("Completed", decided, FIRST_PLAN_AT);
  const checkTaskId = await task("Completed", decided, FIRST_PLAN_AT);
  await repo.append({
    projectId,
    taskId,
    checkTaskId,
    environmentVersion: "e".repeat(64),
    baselineCommit: "a".repeat(40),
    checks: [{ name: "holds", command: "true", decides: decided }],
    files: [],
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  repo = new TaskCheckRepository(db);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
  await delivered(["G1"]);
  const message = await db.execute(sql`INSERT INTO client_messages (project_id, direction, kind, body)
    VALUES (${projectId}, 'inbound', 'change', 'Messages are in French.') RETURNING id`);
  const [requested] = z.array(z.object({ id: z.string() })).length(1).parse(message.rows);
  await db.execute(sql`INSERT INTO vision_documents (project_id, version, vision_text, summary) VALUES (${projectId}, 1, 'v', 'v'), (${projectId}, 2, 'v', 'v')`);
  await db.execute(sql`INSERT INTO vision_revisions (project_id, based_on_version, version, author, approver, direction, cause, source_message_id, ops, status)
    VALUES (${projectId}, 1, 2, 'client', 'client', 'neutral', 'client-change', ${requested?.id ?? null}, '[{"op": "amend-assumption"}]'::jsonb, 'applied')`);
  const revision = await db.execute(sql`INSERT INTO plan_revisions (project_id, revision, vision_version, requested_by, summary, created_at)
    VALUES (${projectId}, 2, 2, ${requested?.id ?? null}, '{}'::jsonb, ${REVISED_AT}) RETURNING id`);
  const [revised] = z.array(z.object({ id: z.string() })).length(1).parse(revision.rows);
  await db.execute(sql`INSERT INTO correction_holds (project_id, vision_version, requested_by, affected, plan_revision_id)
    VALUES (${projectId}, 2, ${requested?.id ?? null}, ${"{A1,G1,G2}"}::text[], ${revised?.id ?? null})`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("the evidence a check set holding on its foundation gives", () => {
  test("a guarantee a correction put in scope that merged work's checks decide still holds", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G1"], REVISED_AT))).toEqual({ kind: "still-holds", items: ["G1"] });
  });

  test("a first plan's task is untested, though a later correction affects what it cites", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G1"], FIRST_PLAN_AT))).toMatchObject({ kind: "untested", why: expect.stringContaining("affects G1") });
  });

  test("a guarantee a correction put in scope that no merged work's checks decide is untested", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G2"], REVISED_AT))).toMatchObject({ kind: "untested", why: expect.stringContaining("decide G2") });
  });

  test("a task citing an item no correction affects beside one it does is untested", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G1", "G5"], REVISED_AT))).toMatchObject({ kind: "untested", why: expect.stringContaining("affects G5") });
  });
});
