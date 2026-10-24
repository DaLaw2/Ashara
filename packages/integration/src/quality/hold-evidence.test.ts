import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { TaskCheckRepository } from "@ashara/quality";
import { parseProjectId, parseWorkItemId } from "@ashara/shared";

// What a check set that holds whole on its foundation is evidence of, read from the records alone:
// the client corrections the plan revisions took in (correction_holds) and the checks of the work
// already merged. Every row belongs to a project this suite creates, and afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `hold-evidence-test-${randomUUID().slice(0, 8)}`;

let db: Database;
let repo: TaskCheckRepository;
let clientId: string;
let projectId: string;
/** When the correction's plan revision was written: the first plan's tasks are older, the revision's are not. */
const REVISED_AT = new Date("2026-10-20T12:00:00Z");
const FIRST_PLAN_AT = new Date("2026-10-20T10:00:00Z");

/** A cited vision item as a task's task_spec.sources records it: an A<n> key is an assumption, any other a scope line. */
function source(key: string): Record<string, string> {
  return key.startsWith("A")
    ? { type: "assumption", id: key, text: `What ${key} assumes.`, status: "Inferred", standing: "stated", kind: "client-visible" }
    : { type: "scope", id: key, text: `What ${key} states.`, side: "in" };
}

/** An implementation task citing `cited`, planned at `at`. */
async function task(status: "Pending" | "Completed", cited: readonly string[], at: Date): Promise<string> {
  const id = randomUUID();
  const spec = { goal: "g", endState: "e", scope: "s", deliverables: [], sources: cited.map(source) };
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
    projectId: parseProjectId(projectId, "test"),
    taskId,
    checkTaskId: parseWorkItemId(checkTaskId, "test"),
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
  await db.execute(sql`DELETE FROM held_set_rejections WHERE project_id = ${projectId}`);
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

  test("a first plan's task is uncorrected, though a later correction affects what it cites", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G1"], FIRST_PLAN_AT))).toEqual({ kind: "uncorrected", items: ["G1"] });
  });

  test("a task citing no item is uncited", async () => {
    const taskId = await task("Pending", [], REVISED_AT);
    expect(await repo.holdEvidenceOf(taskId)).toEqual({ kind: "uncited", taskId });
  });

  test("a guarantee a correction put in scope that no merged work's checks decide is undelivered", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G2"], REVISED_AT))).toEqual({ kind: "undelivered", items: ["G2"] });
  });

  test("an amended assumption no merged work's checks decide is undecided as an assumption", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["A1"], REVISED_AT))).toEqual({ kind: "assumption-undecided", items: ["A1"] });
  });

  // An undelivered guarantee beside the assumption is new behaviour: the stronger reason is the one recorded.
  test("an amended assumption beside an undelivered guarantee is undelivered", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["A1", "G2"], REVISED_AT))).toEqual({ kind: "undelivered", items: ["A1", "G2"] });
  });

  test("a task citing an item no correction affects beside one it does is partly corrected", async () => {
    expect(await repo.holdEvidenceOf(await task("Pending", ["G1", "G5"], REVISED_AT))).toEqual({ kind: "partly-corrected", corrected: ["G1"], uncorrected: ["G5"] });
  });
});

// Identical rejections are counted from the records, so the bound survives a restart and a revision
// that plans the same items again under new task ids.
describe("the held-set rejections a project records", () => {
  test("identical rejections are counted across check tasks and attempts; another reason or other items are not identical", async () => {
    const checked = await task("Pending", ["G7", "G8"], REVISED_AT);
    const first = await task("Pending", ["G7", "G8"], REVISED_AT);
    const second = await task("Pending", ["G7", "G8"], REVISED_AT);
    const undelivered = { kind: "undelivered", items: ["G8", "G7"] } as const;
    const record = (checkTaskId: string, attempt: number, evidence: Parameters<TaskCheckRepository["recordSetRejection"]>[0]["evidence"]) =>
      repo.recordSetRejection({ projectId: parseProjectId(projectId, "test"), checkedTaskId: parseWorkItemId(checked, "test"), checkTaskId: parseWorkItemId(checkTaskId, "test"), attempt, evidence });
    expect(await record(first, 1, undelivered)).toBe(1);
    // The same attempt's rejection written again is the same record.
    expect(await record(first, 1, undelivered)).toBe(1);
    expect(await record(second, 1, { kind: "undelivered", items: ["G7", "G8"] })).toBe(2);
    expect(await record(first, 2, { kind: "uncorrected", items: ["G7", "G8"] })).toBe(1);
    expect(await record(second, 2, { kind: "undelivered", items: ["G7"] })).toBe(1);
  });

  // Tasks of one plan are written together, before any of their check tasks runs: a sibling's
  // rejection for the same items is not this task's, so it never spends this task's bound.
  test("a sibling task of the same plan citing the same items counts only its own rejections", async () => {
    const [a, b, checkA, checkB] = [await task("Pending", ["G9"], FIRST_PLAN_AT), await task("Pending", ["G9"], FIRST_PLAN_AT), await task("Pending", ["G9"], FIRST_PLAN_AT), await task("Pending", ["G9"], FIRST_PLAN_AT)];
    expect(await repo.holdEvidenceOf(a)).toEqual({ kind: "uncorrected", items: ["G9"] });
    expect(await repo.holdEvidenceOf(b)).toEqual({ kind: "uncorrected", items: ["G9"] });
    const record = (checkedTaskId: string, checkTaskId: string, attempt: number) =>
      repo.recordSetRejection({ projectId: parseProjectId(projectId, "test"), checkedTaskId: parseWorkItemId(checkedTaskId, "test"), checkTaskId: parseWorkItemId(checkTaskId, "test"), attempt, evidence: { kind: "uncorrected", items: ["G9"] } });
    expect(await record(a, checkA, 1)).toBe(1);
    expect(await record(b, checkB, 1)).toBe(1);
    expect(await record(b, checkB, 2)).toBe(2);
    // A later plan's task for the same items is handed the verdict the earlier tasks were: their rejections count.
    const replanned = await task("Pending", ["G9"], new Date(Date.now() + 60_000));
    const checkReplanned = await task("Pending", ["G9"], new Date(Date.now() + 60_000));
    expect(await record(replanned, checkReplanned, 1)).toBe(4);
  });

  test("a task citing no item counts only its own rejections", async () => {
    const [one, other, checkTask] = [await task("Pending", [], REVISED_AT), await task("Pending", [], REVISED_AT), await task("Pending", [], REVISED_AT)];
    const record = (checkedTaskId: string, attempt: number) =>
      repo.recordSetRejection({ projectId: parseProjectId(projectId, "test"), checkedTaskId: parseWorkItemId(checkedTaskId, "test"), checkTaskId: parseWorkItemId(checkTask, "test"), attempt, evidence: { kind: "uncited", taskId: checkedTaskId } });
    expect(await record(one, 1)).toBe(1);
    expect(await record(other, 2)).toBe(1);
    expect(await record(one, 3)).toBe(2);
  });
});
