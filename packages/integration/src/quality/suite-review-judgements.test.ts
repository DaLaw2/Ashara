import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, ProjectRepository } from "@ashara/db";
import type { ContextualLlm } from "@ashara/finance";
import { SuiteReviewJudgementRepository, SuiteReviewer, suiteReviewJudgementsOf } from "@ashara/quality";
import type { SuiteReviewSource } from "@ashara/quality";
import { parseProjectId, parseWorkItemId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";

// Migration 063: a suite review's judgements on the outside-vision rejections it routed or released
// are written whole before its outcome is acted on, and read back only through their schema. Every
// row belongs to a project this suite creates, and afterAll deletes it.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME = `suite-review-judgements-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: ProjectId;

async function workItem(title: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id)
    VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId})`);
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = parseProjectId((await new ProjectRepository(db).create(NAME, clientId)).id, "test project");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("suite review judgements (migration 063)", () => {
  test("a routed and a released rejection are recorded whole with both reviews' models, read back through their schema, and never updated", async () => {
    const reviewTask = parseWorkItemId(await workItem("Review the plan's checks"), "test review task");
    const implA = await workItem("Sum by month");
    const implB = await workItem("Refuse bad rows");
    const checkA = await workItem("Checks of Sum by month");
    const checkB = await workItem("Checks of Refuse bad rows");
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [
        { id: checkA, status: "Completed", checksFor: implA, visionItems: ["Monthly totals"], sources: null, checkedTitle: "Sum by month" },
        { id: checkB, status: "Completed", checksFor: implB, visionItems: ["Malformed rows are refused"], sources: null, checkedTitle: "Refuse bad rows" },
      ],
      latest: async (taskId) => ({
        checkTaskId: taskId === implA ? checkA : checkB,
        revision: 1,
        environmentVersion: "v1",
        baselineCommit: null,
        checks: [{ name: taskId === implA ? "prints-count" : "stdout-empty", command: "sh check.sh", decides: ["item 1"] }],
        files: [],
      }),
    };
    const rejectA = { checkTasks: [checkA], kind: "outside-vision", check: "prints-count", judgedItems: ["item 1"], missingClause: "prints the row count", problem: "a row count is asked for by nothing", evidence: "sh check.sh" };
    const rejectB = { checkTasks: [checkB], kind: "outside-vision", check: "stdout-empty", judgedItems: ["item 1"], missingClause: "an empty stdout", problem: "an empty stdout is asked for by nothing", evidence: "sh check.sh" };
    // The second review's undecided-item on check B is kept whole among its findings, and B is still released.
    const undecidedB = { checkTasks: [checkB], kind: "undecided-item", item: "item 1", problem: "no check reads a malformed row", evidence: "sh check.sh" };
    const answers = [{ problems: [rejectA, rejectB] }, { problems: [{ ...rejectA, missingClause: "a count of the rows" }, undecidedB] }];
    let next = 0;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          const answer = answers[next++];
          const by = request.otherThan === undefined ? { provider: "first", model: "strong-a" } : { provider: "second", model: "strong-b" };
          return { data: request.schema.parse(answer), ...by };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });

    const outcome = await reviewer.review({ id: reviewTask, projectId, taskSpec: { origin: "review", visionItems: ["Monthly totals", "Malformed rows are refused"] } }, "/unused");

    expect(outcome).toMatchObject({ kind: "problems", released: [{ checkTaskId: checkB, check: "stdout-empty" }] });
    const recorded = (await suiteReviewJudgementsOf(db, projectId)).filter((judgement) => judgement.reviewTaskId === reviewTask);
    expect(recorded).toEqual([
      {
        reviewTaskId: reviewTask,
        checkTaskId: checkA,
        checkName: "prints-count",
        outcome: "routed",
        firstFinding: rejectA,
        secondFindings: [{ ...rejectA, missingClause: "a count of the rows" }],
        firstModel: "first/strong-a",
        secondModel: "second/strong-b",
        secondReview: "other-model",
      },
      {
        reviewTaskId: reviewTask,
        checkTaskId: checkB,
        checkName: "stdout-empty",
        outcome: "released",
        firstFinding: rejectB,
        secondFindings: [undecidedB],
        firstModel: "first/strong-a",
        secondModel: "second/strong-b",
        secondReview: "other-model",
      },
    ]);

    await expect(db.execute(sql`UPDATE suite_review_judgements SET outcome = 'released' WHERE review_task_id = ${reviewTask}`)).rejects.toThrow();
  });

  test("a stored judgement that does not parse is refused by name, never read as a judgement", async () => {
    const reviewTask = await workItem("Review with a corrupt judgement");
    const checkTask = await workItem("Checks with a corrupt judgement");
    await db.execute(sql`
      INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, first_finding, second_findings, first_model, second_model, second_review)
      VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', '{"kind":"outside-vision"}'::jsonb, '[]'::jsonb, 'p/m', 'p/m', 're-sample')`);
    await expect(suiteReviewJudgementsOf(db, projectId)).rejects.toMatchObject({ name: "SuiteReviewJudgementCorrupt" });
  });

  test("a re-sample must name the same model twice, and another model two different ones", async () => {
    const reviewTask = await workItem("Review with a mislabelled second review");
    const checkTask = await workItem("Checks with a mislabelled second review");
    const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check: "c", judgedItems: ["S1"], missingClause: "x", problem: "p", evidence: "e" });
    const insert = (secondModel: string, secondReview: string) =>
      db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, first_finding, second_findings, first_model, second_model, second_review)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', ${finding}::jsonb, '[]'::jsonb, 'p/m', ${secondModel}, ${secondReview})`);
    await expect(insert("q/n", "re-sample")).rejects.toThrow();
    await expect(insert("p/m", "other-model")).rejects.toThrow();
  });
});
