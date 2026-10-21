import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { attemptGrade } from "@ashara/finance";
import { TaskCheckRepository } from "@ashara/quality";

// The grade of an attempt's work is Finance's one reading of the model catalog: the catalog row of
// the model the attempt recorded, served by the provider it recorded, graded the higher of its
// thinking-on and thinking-off grades since the mode an attempt was called in is not recorded. A
// model id the catalog holds under another provider grades nothing. Quality's suite review reads
// the same grade for every attempt of a check task. Every row belongs to this suite and afterAll
// deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const SUFFIX = randomUUID().slice(0, 8);
/** Graded Medium with thinking on and Strong with thinking off, catalogued under the deepseek provider only. */
const MODEL = `attempt-grade-test-${SUFFIX}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`attempt-grade-test-${SUFFIX}`)).id;
  projectId = (await new ProjectRepository(db).create(`attempt-grade-test-${SUFFIX}`, clientId)).id;
  await db.execute(sql`
    INSERT INTO model_configs (model_id, provider_name, capability, capability_thinking_off, input_cost_per_1m, output_cost_per_1m, max_context_tokens)
    VALUES (${MODEL}, 'deepseek', 'Medium', 'Strong', 1, 1, 100000)`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (SELECT id FROM work_items WHERE project_id = ${projectId})`);
  await db.execute(sql`DELETE FROM dependencies WHERE from_id IN (SELECT id FROM work_items WHERE project_id = ${projectId})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${MODEL}`);
  await db.$client.end();
});

async function task(title: string, workKind: string | null, taskSpec: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec)
    VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId}, ${workKind}, ${workKind === null ? null : randomUUID()}, ${JSON.stringify(taskSpec)}::jsonb)`);
  return id;
}

async function attempt(taskId: string, provider: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO dev_sessions (id, task_id, phase, attempt_prompt_digest, attempt_terminal, attempt_turns, attempt_provider, attempt_model, attempt_cell)
    VALUES (${randomUUID()}, ${taskId}, 'Completed', ${"d".repeat(64)}, 'finished:done', 3, ${provider}, ${MODEL}, 'base-cell')`);
}

describe("an attempt's grade", () => {
  test("is the higher of the model's two grades under the provider the attempt ran on, and none under a provider the catalog does not hold it from", async () => {
    const result = await db.execute(sql`
      SELECT ${attemptGrade(sql`${MODEL}`, sql`'deepseek'`)} AS "served", ${attemptGrade(sql`${MODEL}`, sql`'anthropic'`)} AS "elsewhere"`);
    expect(z.array(z.object({ served: z.string().nullable(), elsewhere: z.string().nullable() })).parse(result.rows)).toEqual([{ served: "Strong", elsewhere: null }]);
  });

  test("Quality's suite review reads every attempt of a check task with that grade", async () => {
    const impl = await task("Store keys", "implementation", { origin: "decomposition" });
    const checker = await task("Checks of Store keys", "check", { origin: "check", checksFor: impl, capability: "Light" });
    const review = await task("Review the plan's checks", null, { origin: "review" });
    await db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${review}, ${checker})`);
    await attempt(checker, "deepseek");
    await attempt(checker, "anthropic");

    const [read] = await new TaskCheckRepository(db).checkTasksUnderReview(review);
    expect(read?.attemptModels).toEqual([
      { model: MODEL, grade: "Strong" },
      { model: MODEL, grade: null },
    ]);
  });
});
