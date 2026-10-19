import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { CheckDisputeRepository, reviewerRecordOf, TaskCheckRepository } from "@ashara/quality";

// A check task's re-authored revision is the evidence its disputes and routed rejections are judged
// by: the reviewer record it writes is read back from reviewer_outcomes. Every row belongs to a
// project this suite creates, and afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `reviewer-outcomes-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: string;

const OutcomeRowSchema = z.strictObject({
  verdictKind: z.string(),
  verdictId: z.string(),
  reviewerModel: z.string(),
  reviewerRole: z.string(),
  outcome: z.string(),
  evidenceKind: z.string(),
  evidenceRef: z.string(),
});

async function outcomesOf(verdictIds: readonly string[]): Promise<Array<z.infer<typeof OutcomeRowSchema>>> {
  const result = await db.execute(sql`
    SELECT verdict_kind AS "verdictKind", verdict_id AS "verdictId", reviewer_model AS "reviewerModel", reviewer_role AS "reviewerRole",
           outcome, evidence_kind AS "evidenceKind", evidence_ref AS "evidenceRef"
    FROM reviewer_outcomes WHERE project_id = ${projectId}
    ORDER BY created_at, reviewer_role, id`);
  return z.array(OutcomeRowSchema).parse(result.rows).filter((row) => verdictIds.includes(row.verdictId));
}

async function workItem(title: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO work_items (id, level, status, title, project_id) VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId})`);
  return id;
}

/** A suite review claim covering `checkTask`; with no second model, its second opinion failed. */
async function claim(reviewTask: string, checkTask: string, second: { readonly model: string; readonly findings: readonly unknown[] } | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO suite_review_claims (id, project_id, review_task_id, basis, covered, first_model, second_model, second_strength, passed_over, second_findings, second_failure, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
    VALUES (${id}, ${projectId}, ${reviewTask}, ${second === null ? "second-review-failed" : second.findings.length === 0 ? "second-opinion-clean" : "second-opinion-found"},
            ${JSON.stringify([checkTask])}::jsonb, 'first/judge-a', ${second?.model ?? null}, ${second === null ? null : "other-family"}, '[]'::jsonb,
            ${JSON.stringify(second?.findings ?? [])}::jsonb, ${second === null ? "every strength failed" : null}, 'Frontier', 'Strong', 'above', 'Frontier', ${second === null ? null : "Frontier"})`);
  return id;
}

/** A rejection a suite review routed against `check` of `checkTask`, both reviews agreeing. */
async function routedRejection(reviewTask: string, checkTask: string, check: string): Promise<string> {
  const id = randomUUID();
  const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check, judgedItems: ["S1"], missingClause: "c", problem: "p", evidence: "e" });
  await db.execute(sql`
    INSERT INTO suite_review_judgements (id, project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
    VALUES (${id}, ${projectId}, ${reviewTask}, ${checkTask}, ${check}, 'routed', 'two-reviews', ${finding}::jsonb, ${`[${finding}]`}::jsonb, 'first/judge-a', 'second/judge-b', 'other-family', '[]'::jsonb, 'Frontier', 'Strong', 'above', 'Frontier', 'Frontier')`);
  return id;
}

/** One implementation task, its check task and the review task over it, with the check task's first revision stored. */
async function checkedTask(checks: ReadonlyArray<{ readonly name: string; readonly command: string }>) {
  const task = await workItem("Store keys");
  const checkTask = await workItem("Checks of Store keys");
  const reviewTask = await workItem("Review the plan's checks");
  const repo = new TaskCheckRepository(db);
  const revise = (next: ReadonlyArray<{ readonly name: string; readonly command: string }>, files: ReadonlyArray<{ readonly path: string; readonly content: string }> = [{ path: "checks/run.sh", content: "exit 0\n" }]) =>
    repo.append({
      projectId,
      taskId: task,
      checkTaskId: checkTask,
      environmentVersion: "e".repeat(64),
      baselineCommit: "a".repeat(40),
      checks: next.map((check) => ({ ...check, decides: ["S1"] as const })),
      files,
    });
  expect(await revise(checks)).toBe(1);
  return { task, checkTask, reviewTask, revise };
}

function dispute(task: string, checkTask: string, revision: number, checkName: string): Promise<number> {
  return new CheckDisputeRepository(db).record({ projectId, taskId: task, checkTaskId: checkTask, revision, checkName, reason: "the check reads a torn record as data loss", evidence: null });
}

async function disputeId(checkTask: string, checkName: string): Promise<string> {
  const result = await db.execute(sql`SELECT id FROM check_disputes WHERE check_task_id = ${checkTask} AND check_name = ${checkName}`);
  const [row] = z.array(z.object({ id: z.string() })).length(1).parse(result.rows);
  if (row === undefined) throw new Error(`no dispute of ${checkName}`);
  return row.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM check_disputes WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a re-authored check revision writes the reviewer record", () => {
  test("a dispute whose check the next revision changes contradicts the pass of the claim covering the check task, once", async () => {
    const { task, checkTask, reviewTask, revise } = await checkedTask([
      { name: "torn first record", command: "sh checks/run.sh torn" },
      { name: "round trip", command: "sh checks/run.sh trip" },
    ]);
    const passed = await claim(reviewTask, checkTask, null);
    await dispute(task, checkTask, 1, "torn first record");

    expect(await revise([{ name: "torn first record", command: "sh checks/run.sh torn --tail-only" }, { name: "round trip", command: "sh checks/run.sh trip" }])).toBe(2);

    expect(await outcomesOf([passed])).toEqual([
      {
        verdictKind: "claim",
        verdictId: passed,
        reviewerModel: "first/judge-a",
        reviewerRole: "first",
        outcome: "pass-contradicted",
        evidenceKind: "dispute-upheld",
        evidenceRef: await disputeId(checkTask, "torn first record"),
      },
    ]);
    const record = (await reviewerRecordOf(db, projectId)).find((line) => line.reviewerModel === "first/judge-a" && line.verdictKind === "claim");
    expect(record).toMatchObject({ site: "suite-review", passesContradicted: 1, findingsWitnessed: 0, findingsRefuted: 0, cost: { calls: 0, measuredCalls: 0 } });
  });

  test("a dropped check upholds its dispute; the second opinion's pass is contradicted, or its finding on the check task witnessed", async () => {
    const { task, checkTask, reviewTask, revise } = await checkedTask([{ name: "torn first record", command: "sh checks/run.sh torn" }, { name: "round trip", command: "sh checks/run.sh trip" }]);
    const clean = await claim(reviewTask, checkTask, { model: "second/judge-b", findings: [] });
    const found = await claim(reviewTask, checkTask, { model: "second/judge-b", findings: [{ checkTasks: [checkTask], kind: "undecided-item", item: "S1", problem: "p", evidence: "e" }] });
    await dispute(task, checkTask, 1, "torn first record");

    await revise([{ name: "round trip", command: "sh checks/run.sh trip" }]);

    const outcomes = (await outcomesOf([clean, found])).map((row) => [row.verdictId, row.reviewerRole, row.outcome, row.evidenceKind]);
    expect(outcomes).toHaveLength(4);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        [clean, "first", "pass-contradicted", "dispute-upheld"],
        [clean, "second", "pass-contradicted", "dispute-upheld"],
        [found, "first", "pass-contradicted", "dispute-upheld"],
        [found, "second", "finding-witnessed", "dispute-upheld"],
      ]),
    );
  });

  test("a dispute raised by another task's implementer, of a merged task's check, is upheld by that check task's next revision", async () => {
    const { checkTask, reviewTask, revise } = await checkedTask([{ name: "torn first record", command: "sh checks/run.sh torn" }]);
    const passed = await claim(reviewTask, checkTask, null);
    const disputer = await workItem("Rotate keys");
    await dispute(disputer, checkTask, 1, "torn first record");

    await revise([{ name: "torn first record", command: "sh checks/run.sh torn --tail-only" }]);

    expect((await outcomesOf([passed])).map((row) => [row.outcome, row.evidenceKind])).toEqual([["pass-contradicted", "dispute-upheld"]]);
  });

  test("a dispute the next revision answers by keeping the check as it was contradicts nothing", async () => {
    const checks = [{ name: "torn first record", command: "sh checks/run.sh torn" }];
    const { task, checkTask, reviewTask, revise } = await checkedTask(checks);
    const passed = await claim(reviewTask, checkTask, null);
    await dispute(task, checkTask, 1, "torn first record");

    await revise(checks);

    expect(await outcomesOf([passed])).toEqual([]);
  });

  test("a routed rejection is witnessed when the next revision changes its check, refuted when it keeps it", async () => {
    const { checkTask, reviewTask, revise } = await checkedTask([{ name: "prints count", command: "sh checks/run.sh count" }, { name: "round trip", command: "sh checks/run.sh trip" }]);
    const changed = await routedRejection(reviewTask, checkTask, "prints count");
    const keptCheck = await routedRejection(reviewTask, checkTask, "round trip");

    await revise([{ name: "prints count", command: "sh checks/run.sh count --quiet" }, { name: "round trip", command: "sh checks/run.sh trip" }]);

    const outcomes = (await outcomesOf([changed, keptCheck])).map((row) => [row.verdictId, row.reviewerRole, row.outcome, row.evidenceKind]);
    expect(outcomes).toHaveLength(4);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        [changed, "first", "finding-witnessed", "check-reauthored"],
        [changed, "second", "finding-witnessed", "check-reauthored"],
        [keptCheck, "first", "finding-refuted", "check-reauthored"],
        [keptCheck, "second", "finding-refuted", "check-reauthored"],
      ]),
    );
  });
});
