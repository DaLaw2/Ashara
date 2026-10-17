import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, ProjectRepository } from "@ashara/db";
import { NoOtherFamilyAnswered, ProviderError } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
import { CheckSetFreezeRepository, SuiteReviewJudgementRepository, SuiteReviewer, suiteReviewJudgementsOf } from "@ashara/quality";
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
  await db.execute(sql`DELETE FROM check_set_freezes WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM undecided_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM dependencies WHERE from_id IN (SELECT id FROM work_items WHERE project_id = ${projectId})`);
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
        { id: checkA, status: "Completed", checksFor: implA, visionItems: ["Monthly totals"], sources: null, checkedTitle: "Sum by month", reviewReopens: 0 },
        { id: checkB, status: "Completed", checksFor: implB, visionItems: ["Malformed rows are refused"], sources: null, checkedTitle: "Refuse bad rows", reviewReopens: 0 },
      ],
      latest: async (taskId) => ({
        checkTaskId: taskId === implA ? checkA : checkB,
        revision: 1,
        environmentVersion: "v1",
        baselineCommit: null,
        checks: [{ name: taskId === implA ? "prints-count" : "stdout-empty", command: "sh check.sh", decides: ["item 1"] }],
        files: [],
      }),
      frozen: async () => false,
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
        basis: "two-reviews",
        firstFinding: rejectA,
        secondFindings: [{ ...rejectA, missingClause: "a count of the rows" }],
        firstModel: "first/strong-a",
        secondModel: "second/strong-b",
        secondReview: "other-model",
        secondFailure: null,
      },
      {
        reviewTaskId: reviewTask,
        checkTaskId: checkB,
        checkName: "stdout-empty",
        outcome: "released",
        basis: "two-reviews",
        firstFinding: rejectB,
        secondFindings: [undecidedB],
        firstModel: "first/strong-a",
        secondModel: "second/strong-b",
        secondReview: "other-model",
        secondFailure: null,
      },
    ]);

    await expect(db.execute(sql`UPDATE suite_review_judgements SET outcome = 'released' WHERE review_task_id = ${reviewTask}`)).rejects.toThrow();
  });

  test("a stored judgement that does not parse is refused by name, never read as a judgement", async () => {
    const reviewTask = await workItem("Review with a corrupt judgement");
    const checkTask = await workItem("Checks with a corrupt judgement");
    await db.execute(sql`
      INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_review)
      VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', 'two-reviews', '{"kind":"outside-vision"}'::jsonb, '[]'::jsonb, 'p/m', 'p/m', 're-sample')`);
    await expect(suiteReviewJudgementsOf(db, projectId)).rejects.toMatchObject({ name: "SuiteReviewJudgementCorrupt" });
    // The corrupt row is this test's alone: the project's other judgements are read whole after it.
    await db.execute(sql`DELETE FROM suite_review_judgements WHERE review_task_id = ${reviewTask}`);
  });

  test("a re-sample must name the same model twice, and another model two different ones", async () => {
    const reviewTask = await workItem("Review with a mislabelled second review");
    const checkTask = await workItem("Checks with a mislabelled second review");
    const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check: "c", judgedItems: ["S1"], missingClause: "x", problem: "p", evidence: "e" });
    const insert = (secondModel: string, secondReview: string) =>
      db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_review)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', 'two-reviews', ${finding}::jsonb, '[]'::jsonb, 'p/m', ${secondModel}, ${secondReview})`);
    await expect(insert("q/n", "re-sample")).rejects.toThrow();
    await expect(insert("p/m", "other-model")).rejects.toThrow();
  });
});

describe("witnessed findings and the check set freeze (migration 069, ADR-084 decisions 2 and 3)", () => {
  async function task(title: string, spec: unknown, workKind: string | null): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, task_spec, work_kind, owner_role_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId}, ${JSON.stringify(spec)}::jsonb, ${workKind}, ${workKind === null ? null : randomUUID()})`);
    return id;
  }

  /** A review in which both reviews raise one undecided item, the second answering from `secondProvider`, or failing with its error. */
  async function reviewUndecided(secondProvider: string | Error) {
    const reviewTask = parseWorkItemId(await workItem("Review an undecided item"), "test review task");
    const impl = await workItem("Durable put");
    const check = await workItem("Checks of Durable put");
    const cited = { type: "scope" as const, id: "S9", text: "put survives a power loss", side: "in" as const };
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: check, status: "Completed", checksFor: impl, visionItems: [cited.text], sources: [cited], checkedTitle: "Durable put", reviewReopens: 0 }],
      latest: async () => ({ checkTaskId: check, revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [{ name: "put-then-get", command: "sh put.sh", decides: ["S9"] }], files: [] }),
      frozen: async () => false,
    };
    const undecided = { checkTasks: [check], kind: "undecided-item", item: "S9", problem: "no check distinguishes fsynced from written data", evidence: "sh put.sh" };
    const answers = [{ problems: [undecided] }, { problems: [undecided] }];
    let next = 0;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          const answer = answers[next++];
          if (secondProvider instanceof Error && request.otherThan !== undefined) throw secondProvider;
          const by = request.otherThan === undefined ? { provider: "first", model: "strong-a" } : { provider: secondProvider instanceof Error ? "unanswered" : secondProvider, model: "strong-b" };
          return { data: request.schema.parse(answer), ...by };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });
    const outcome = await reviewer.review({ id: reviewTask, projectId, taskSpec: { origin: "review", visionItems: [cited.text] } }, "/unused");
    const kept = await db.execute(sql`SELECT item_id AS "itemId", item_text AS "itemText", check_task_id AS "checkTaskId" FROM undecided_items WHERE review_task_id = ${reviewTask}`);
    const judged = (await suiteReviewJudgementsOf(db, projectId)).filter((judgement) => judgement.reviewTaskId === reviewTask);
    return { outcome, kept: kept.rows, judged, check };
  }

  test("an undecided item only one model family raised is kept advisory and stored undecided, never routed", async () => {
    const { outcome, kept, judged, check } = await reviewUndecided("first");
    expect(outcome).toMatchObject({ kind: "clean", undecided: [{ checkTaskId: check, itemId: "S9" }] });
    expect(kept).toEqual([{ itemId: "S9", itemText: "put survives a power loss", checkTaskId: check }]);
    expect(judged).toMatchObject([{ checkName: null, outcome: "advisory", basis: "no-other-family", secondModel: "first/strong-b" }]);
  });

  test("a second review no other family answered is stored as failed with its reason, the item kept advisory and undecided (migration 071)", async () => {
    const failure = new NoOtherFamilyAnswered({ provider: "first", model: "strong-a" }, "second", { cause: new ProviderError("second", "503", "provider") });
    const { outcome, kept, judged, check } = await reviewUndecided(failure);
    expect(outcome).toMatchObject({ kind: "clean", undecided: [{ checkTaskId: check, itemId: "S9" }] });
    expect(kept).toEqual([{ itemId: "S9", itemText: "put survives a power loss", checkTaskId: check }]);
    expect(judged).toMatchObject([{ outcome: "advisory", basis: "second-review-failed", secondModel: null, secondReview: null, secondFindings: [] }]);
    expect(judged[0]?.secondFailure).toContain("got no answer");
  });

  test("a failed basis without its reason, or a reason on another basis, is refused by the table", async () => {
    const reviewTask = await workItem("Review with a mislabelled failure");
    const checkTask = await workItem("Checks with a mislabelled failure");
    const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check: "c", judgedItems: ["S1"], missingClause: "x", problem: "p", evidence: "e" });
    const insert = (basis: string, failure: string | null) =>
      db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_failure)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'advisory', ${basis}, ${finding}::jsonb, '[]'::jsonb, 'p/m', ${failure})`);
    await expect(insert("second-review-failed", null)).rejects.toThrow();
    await expect(insert("frozen", "a reason")).rejects.toThrow();
    await insert("second-review-failed", "no other family answered");
    await db.execute(sql`DELETE FROM suite_review_judgements WHERE review_task_id = ${reviewTask}`);
  });

  test("an undecided item another model family agrees on is routed once and not stored undecided", async () => {
    const { outcome, kept, judged } = await reviewUndecided("second");
    expect(outcome).toMatchObject({ kind: "problems", undecided: [], problems: [{ kind: "undecided-item" }] });
    expect(kept).toEqual([]);
    expect(judged).toMatchObject([{ outcome: "routed", basis: "other-family-agreed", secondModel: "second/strong-b", secondReview: "other-model" }]);
  });

  /** A review whose first pass finds nothing, its second answering `second` from another family, or failing with it. */
  async function reviewClean(second: ((check: string) => { readonly problems: readonly unknown[] }) | Error) {
    const reviewTask = parseWorkItemId(await workItem("Review a clean suite"), "test review task");
    const impl = await workItem("Durable put");
    const check = await workItem("Checks of Durable put");
    const cited = [
      { type: "scope" as const, id: "S8", text: "put then get returns the value", side: "in" as const },
      { type: "scope" as const, id: "S9", text: "put survives a power loss", side: "in" as const },
    ];
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: check, status: "Completed", checksFor: impl, visionItems: cited.map((item) => item.text), sources: cited, checkedTitle: "Durable put", reviewReopens: 0 }],
      latest: async () => ({ checkTaskId: check, revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [{ name: "put-then-get", command: "sh put.sh", decides: ["S8", "S9"] }], files: [] }),
      frozen: async () => false,
    };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          if (request.otherThan === undefined) return { data: request.schema.parse({ problems: [] }), provider: "first", model: "strong-a" };
          if (second instanceof Error) throw second;
          return { data: request.schema.parse(second(check)), provider: "second", model: "strong-b" };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });
    const outcome = await reviewer.review({ id: reviewTask, projectId, taskSpec: { origin: "review", visionItems: cited.map((item) => item.text) } }, "/unused");
    const kept = await db.execute(sql`
      SELECT u.item_id AS "itemId", u.judgement_id AS "judgementId", c.basis FROM undecided_items u JOIN suite_review_claims c ON c.id = u.claim_id
      WHERE u.review_task_id = ${reviewTask} ORDER BY u.item_id`);
    const claims = await db.execute(sql`
      SELECT basis, covered, first_model AS "firstModel", second_model AS "secondModel", second_review AS "secondReview", second_findings AS "secondFindings", second_failure AS "secondFailure"
      FROM suite_review_claims WHERE review_task_id = ${reviewTask}`);
    return { outcome, kept: kept.rows, claims: claims.rows, check };
  }

  test("a clean review another family confirms is recorded as a claim and leaves nothing undecided (migration 072)", async () => {
    const { outcome, kept, claims, check } = await reviewClean(() => ({ problems: [] }));
    expect(outcome).toMatchObject({ kind: "clean", claim: { basis: "other-family-clean", unconfirmed: [] } });
    expect(kept).toEqual([]);
    expect(claims).toEqual([{ basis: "other-family-clean", covered: [check], firstModel: "first/strong-a", secondModel: "second/strong-b", secondReview: "other-model", secondFindings: [], secondFailure: null }]);
  });

  test("a clean review the other family contradicts stores only the items it named undecided, tied to the claim", async () => {
    const doubt = (check: string) => ({ checkTasks: [check], kind: "undecided-item", item: "S9", problem: "no check distinguishes fsynced from written data", evidence: "sh put.sh" });
    const { outcome, kept, claims } = await reviewClean((check) => ({ problems: [doubt(check)] }));
    expect(outcome).toMatchObject({ kind: "clean", claim: { basis: "other-family-found", unconfirmed: [{ itemId: "S9" }] } });
    expect(kept).toEqual([{ itemId: "S9", judgementId: null, basis: "other-family-found" }]);
    expect(claims).toMatchObject([{ basis: "other-family-found", secondFindings: [{ kind: "undecided-item", item: "S9" }] }]);
  });

  test("a clean review whose second review failed stores every covered item undecided, with why", async () => {
    const failure = new NoOtherFamilyAnswered({ provider: "first", model: "strong-a" }, "second", { cause: new ProviderError("second", "503", "provider") });
    const { kept, claims } = await reviewClean(failure);
    expect(kept).toEqual([
      { itemId: "S8", judgementId: null, basis: "second-review-failed" },
      { itemId: "S9", judgementId: null, basis: "second-review-failed" },
    ]);
    expect(claims).toMatchObject([{ basis: "second-review-failed", secondModel: null, secondReview: null, secondFindings: [], secondFailure: expect.stringContaining("got no answer") }]);
  });

  test("an undecided item tied to neither a judgement nor a claim is refused, and a claim's basis must fit its second review", async () => {
    const reviewTask = await workItem("Review with a mislabelled claim");
    const checkTask = await workItem("Checks with a mislabelled claim");
    await expect(
      db.execute(sql`
        INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'S1', 'Keys can be stored')`),
    ).rejects.toThrow();
    // A claim another family confirmed holds another model; one that failed holds why and no model.
    const claim = (basis: string, secondModel: string | null, secondReview: string | null, failure: string | null) =>
      db.execute(sql`
        INSERT INTO suite_review_claims (project_id, review_task_id, basis, covered, first_model, second_model, second_review, second_findings, second_failure)
        VALUES (${projectId}, ${reviewTask}, ${basis}, ${JSON.stringify([checkTask])}::jsonb, 'p/m', ${secondModel}, ${secondReview}, '[]'::jsonb, ${failure})`);
    await expect(claim("other-family-clean", "p/m", "re-sample", null)).rejects.toThrow();
    await expect(claim("second-review-failed", null, null, null)).rejects.toThrow();
    await expect(claim("other-family-found", "q/n", "other-model", null)).rejects.toThrow();
    await claim("second-review-failed", null, null, "no other family answered");
    await expect(db.execute(sql`UPDATE suite_review_claims SET basis = 'other-family-clean' WHERE review_task_id = ${reviewTask}`)).rejects.toThrow();
  });

  test("the first task dispatched on a review's check set freezes it once, with the set as it stood; the freeze is never updated", async () => {
    const freezes = new CheckSetFreezeRepository(db);
    const cited = [{ type: "scope", id: "S1", text: "Keys can be stored", side: "in" }];
    const impl = await task("Store keys", { origin: "decomposition" }, "implementation");
    const checker = await task("Checks of Store keys", { origin: "check", checksFor: impl, visionItems: ["Keys can be stored"], sources: cited }, "check");
    const review = await task("Review the plan's checks", { origin: "review" }, null);
    await db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${review}, ${checker}), (${impl}, ${review})`);
    for (const revision of [1, 2]) {
      await db.execute(sql`
        INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
        VALUES (${projectId}, ${impl}, ${checker}, ${revision}, ${`stores-r${revision}`}, 'sh store.sh', '[]'::jsonb, ${"e".repeat(64)}, '["S1"]'::jsonb)`);
    }

    expect(await freezes.frozen(review)).toBe(false);
    expect(await freezes.freezeFor(checker)).toEqual([]);
    expect(await freezes.freezeFor(impl)).toEqual([review]);
    expect(await freezes.freezeFor(impl)).toEqual([]);
    expect(await freezes.frozen(review)).toBe(true);
    const rows = await db.execute(sql`SELECT frozen_by AS "frozenBy", check_set AS "checkSet" FROM check_set_freezes WHERE review_task_id = ${review}`);
    expect(rows.rows).toEqual([
      { frozenBy: impl, checkSet: [{ checkTaskId: checker, checksFor: impl, cited, revision: 2, checks: [{ name: "stores-r2", decides: ["S1"] }] }] },
    ]);
    await expect(db.execute(sql`UPDATE check_set_freezes SET frozen_by = ${checker} WHERE review_task_id = ${review}`)).rejects.toThrow();
  });
});
