import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { ProviderError, SecondOpinionUnanswered, SecondOpinionUnavailable } from "@ashara/finance";
import type { CapabilityLevel, ContextualLlm, SecondOpinionStrength } from "@ashara/finance";
import { CheckSetFreezeRepository, SuiteReviewJudgementRepository, SuiteReviewer, TaskCheckRepository, suiteReviewClaimsOf, suiteReviewJudgementsOf } from "@ashara/quality";
import type { SuiteReviewSource } from "@ashara/quality";
import { parseProjectId, parseWorkItemId, recordingLogger } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";

// A suite review's judgements on the outside-vision rejections it routed or released
// are written whole before its outcome is acted on, and read back only through their schema. Every
// row belongs to a project this suite creates, and afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `suite-review-judgements-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: ProjectId;

/** The model a stub catalog serves the first review with. */
const FIRST = { provider: "first", model: "strong-a", grade: "Frontier" as const };

/** A judge graded Frontier over check work at Strong. */
const ABOVE_STRONG = { judgeTier: "Frontier", judgedTier: "Strong", relation: "above" } as const;

/**
 * The model each strength of second opinion goes to in a stub catalog, as the gateway resolves it:
 * a strength the catalog lacks is refused unsent with SecondOpinionUnavailable.
 */
function secondBy(request: ConstructorParameters<typeof SecondOpinionUnavailable>[1] & { readonly secondOpinion?: { readonly avoid: { readonly provider: string; readonly model: string }; readonly strength: SecondOpinionStrength } }, catalog: Partial<Record<SecondOpinionStrength, { readonly provider: string; readonly model: string; readonly grade: CapabilityLevel }>>) {
  const opinion = request.secondOpinion;
  if (opinion === undefined) return FIRST;
  const by = catalog[opinion.strength];
  if (by === undefined) throw new SecondOpinionUnavailable(opinion, request, []);
  return by;
}

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

describe("suite review judgements", () => {
  test("a routed and a released rejection are recorded whole with both reviews' models, read back through their schema, and never updated", async () => {
    const reviewTask = parseWorkItemId(await workItem("Review the plan's checks"), "test review task");
    const implA = await workItem("Sum by month");
    const implB = await workItem("Refuse bad rows");
    const checkA = await workItem("Checks of Sum by month");
    const checkB = await workItem("Checks of Refuse bad rows");
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [
        { id: checkA, status: "Completed", checksFor: implA, visionItems: ["Monthly totals"], sources: null, checkedTitle: "Sum by month", reviewReopens: 0, grade: "Strong", attemptModels: [] },
        { id: checkB, status: "Completed", checksFor: implB, visionItems: ["Malformed rows are refused"], sources: null, checkedTitle: "Refuse bad rows", reviewReopens: 0, grade: "Strong", attemptModels: [] },
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
          const by = secondBy(request, { "other-family": { provider: "second", model: "strong-b", grade: "Frontier" as const } });
          const answer = answers[next++];
          return { data: request.schema.parse(answer), ...by };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ logger: recordingLogger(), llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });

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
        secondStrength: "other-family",
        passedOver: [],
        secondFailure: null,
        tiers: { kind: "recorded", judge: "Frontier", judged: "Strong", relation: "above", reviews: { kind: "graded", first: "Frontier", second: "Frontier" } },
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
        secondStrength: "other-family",
        passedOver: [],
        secondFailure: null,
        tiers: { kind: "recorded", judge: "Frontier", judged: "Strong", relation: "above", reviews: { kind: "graded", first: "Frontier", second: "Frontier" } },
      },
    ]);

    await expect(db.execute(sql`UPDATE suite_review_judgements SET outcome = 'released' WHERE review_task_id = ${reviewTask}`)).rejects.toThrow();
  });

  test("a stored judgement that does not parse is refused by name, never read as a judgement", async () => {
    const reviewTask = await workItem("Review with a corrupt judgement");
    const checkTask = await workItem("Checks with a corrupt judgement");
    await db.execute(sql`
      INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
      VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', 'two-reviews', '{"kind":"outside-vision"}'::jsonb, '[]'::jsonb, 'p/m', 'p/m', 'same-model', '[]'::jsonb, 'Frontier', 'Strong', 'above', 'Frontier', 'Frontier')`);
    await expect(suiteReviewJudgementsOf(db, projectId)).rejects.toMatchObject({ name: "SuiteReviewJudgementCorrupt" });
    // The corrupt row is this test's alone: the project's other judgements are read whole after it.
    await db.execute(sql`DELETE FROM suite_review_judgements WHERE review_task_id = ${reviewTask}`);
  });

  test("a second review's strength must fit its two models: the same model twice, another of the provider, or another provider", async () => {
    const reviewTask = await workItem("Review with a mislabelled second review");
    const checkTask = await workItem("Checks with a mislabelled second review");
    const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check: "c", judgedItems: ["S1"], missingClause: "x", problem: "p", evidence: "e" });
    const insert = (secondModel: string, secondStrength: string) =>
      db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'released', 'two-reviews', ${finding}::jsonb, '[]'::jsonb, 'p/m', ${secondModel}, ${secondStrength}, '[]'::jsonb, 'Frontier', 'Strong', 'above', 'Frontier', 'Frontier')`);
    await expect(insert("q/n", "same-model")).rejects.toThrow();
    await expect(insert("p/m", "same-family-other-model")).rejects.toThrow();
    await expect(insert("p/n", "other-family")).rejects.toThrow();
    await expect(insert("q/m", "same-family-other-model")).rejects.toThrow();
    await insert("p/n", "same-family-other-model");
    await db.execute(sql`DELETE FROM suite_review_judgements WHERE review_task_id = ${reviewTask}`);
  });
});

describe("witnessed findings and the check set freeze", () => {
  async function task(title: string, spec: unknown, workKind: string | null): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, task_spec, work_kind, owner_role_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId}, ${JSON.stringify(spec)}::jsonb, ${workKind}, ${workKind === null ? null : randomUUID()})`);
    return id;
  }

  /**
   * A review whose first pass raises one undecided item; the second answers from the model `catalog`
   * serves its strength with, raising the item too when `agrees`, or fails with `failure`.
   */
  async function reviewUndecided(catalog: Partial<Record<SecondOpinionStrength, { readonly provider: string; readonly model: string; readonly grade: CapabilityLevel }>>, agrees: boolean, failure: Error | null = null) {
    const reviewTask = parseWorkItemId(await workItem("Review an undecided item"), "test review task");
    const impl = await workItem("Durable put");
    const check = await workItem("Checks of Durable put");
    const cited = { type: "scope" as const, id: "S9", text: "put survives a power loss", side: "in" as const };
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: check, status: "Completed", checksFor: impl, visionItems: [cited.text], sources: [cited], checkedTitle: "Durable put", reviewReopens: 0, grade: "Strong", attemptModels: [] }],
      latest: async () => ({ checkTaskId: check, revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [{ name: "put-then-get", command: "sh put.sh", decides: ["S9"] }], files: [] }),
      frozen: async () => false,
    };
    const undecided = { checkTasks: [check], kind: "undecided-item", item: "S9", problem: "no check distinguishes fsynced from written data", evidence: "sh put.sh" };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          const by = secondBy(request, catalog);
          if (request.secondOpinion !== undefined && failure !== null) throw failure;
          const answer = request.secondOpinion === undefined || agrees ? { problems: [undecided] } : { problems: [] };
          return { data: request.schema.parse(answer), ...by };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ logger: recordingLogger(), llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });
    const outcome = await reviewer.review({ id: reviewTask, projectId, taskSpec: { origin: "review", visionItems: [cited.text] } }, "/unused");
    const kept = await db.execute(sql`SELECT item_id AS "itemId", item_text AS "itemText", check_task_id AS "checkTaskId" FROM undecided_items WHERE review_task_id = ${reviewTask}`);
    const judged = (await suiteReviewJudgementsOf(db, projectId)).filter((judgement) => judgement.reviewTaskId === reviewTask);
    return { outcome, kept: kept.rows, judged, check };
  }

  test("an undecided item the second review does not reach is kept advisory and stored undecided, never routed, with the second's strength", async () => {
    const { outcome, kept, judged, check } = await reviewUndecided({ "same-family-other-model": { provider: "first", model: "strong-b", grade: "Frontier" as const } }, false);
    expect(outcome).toMatchObject({ kind: "clean", undecided: [{ checkTaskId: check, itemId: "S9" }] });
    expect(kept).toEqual([{ itemId: "S9", itemText: "put survives a power loss", checkTaskId: check }]);
    expect(judged).toMatchObject([
      {
        checkName: null,
        outcome: "advisory",
        basis: "second-opinion-disagreed",
        secondModel: "first/strong-b",
        secondStrength: "same-family-other-model",
        passedOver: [{ strength: "other-family", outcome: "unavailable" }],
      },
    ]);
  });

  test("a second review no model answered is stored as failed with its reason, the item kept advisory and undecided", async () => {
    const failure = new SecondOpinionUnanswered({ avoid: FIRST, strength: "other-family" }, { provider: "second", model: "strong-b" }, { cause: new ProviderError("second", "503", "provider") });
    const { outcome, kept, judged, check } = await reviewUndecided({ "other-family": { provider: "second", model: "strong-b", grade: "Frontier" as const } }, true, failure);
    expect(outcome).toMatchObject({ kind: "clean", undecided: [{ checkTaskId: check, itemId: "S9" }] });
    expect(kept).toEqual([{ itemId: "S9", itemText: "put survives a power loss", checkTaskId: check }]);
    expect(judged).toMatchObject([{ outcome: "advisory", basis: "second-review-failed", secondModel: null, secondStrength: null, secondFindings: [] }]);
    expect(judged[0]?.secondFailure).toContain("got no answer");
    expect(judged[0]?.passedOver.map((over) => [over.strength, over.outcome])).toEqual([
      ["other-family", "failed"],
      ["same-family-other-model", "unavailable"],
      ["same-model", "unavailable"],
    ]);
  });

  test("a failed basis without its reason, or a reason on another basis, is refused by the table", async () => {
    const reviewTask = await workItem("Review with a mislabelled failure");
    const checkTask = await workItem("Checks with a mislabelled failure");
    const finding = JSON.stringify({ checkTasks: [checkTask], kind: "outside-vision", check: "c", judgedItems: ["S1"], missingClause: "x", problem: "p", evidence: "e" });
    const insert = (basis: string, failure: string | null) =>
      db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, passed_over, second_failure, judge_tier, judged_tier, tier_relation, first_tier)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'c', 'advisory', ${basis}, ${finding}::jsonb, '[]'::jsonb, 'p/m', '[]'::jsonb, ${failure}, 'Frontier', 'Strong', 'above', 'Frontier')`);
    await expect(insert("second-review-failed", null)).rejects.toThrow();
    await expect(insert("frozen", "a reason")).rejects.toThrow();
    await insert("second-review-failed", "no second opinion answered");
    await db.execute(sql`DELETE FROM suite_review_judgements WHERE review_task_id = ${reviewTask}`);
  });

  test("an undecided item another model family agrees on is routed once and not stored undecided", async () => {
    const { outcome, kept, judged } = await reviewUndecided({ "other-family": { provider: "second", model: "strong-b", grade: "Frontier" as const } }, true);
    expect(outcome).toMatchObject({ kind: "problems", undecided: [], problems: [{ kind: "undecided-item" }] });
    expect(kept).toEqual([]);
    expect(judged).toMatchObject([{ outcome: "routed", basis: "second-opinion-agreed", secondModel: "second/strong-b", secondStrength: "other-family", passedOver: [] }]);
  });

  test("in a deployment with one model, its own agreement from the other angle routes the item, recorded as the same model", async () => {
    const { outcome, judged } = await reviewUndecided({ "same-model": FIRST }, true);
    expect(outcome).toMatchObject({ kind: "problems", problems: [{ kind: "undecided-item" }] });
    expect(judged).toMatchObject([{ outcome: "routed", basis: "second-opinion-agreed", secondModel: "first/strong-a", secondStrength: "same-model" }]);
  });

  /** A review whose first pass finds nothing, its second answering `second` from another family, or failing with it. */
  async function reviewClean(second: ((check: string) => { readonly problems: readonly unknown[] }) | Error) {
    const catalog = { "other-family": { provider: "second", model: "strong-b", grade: "Frontier" as const } };
    const reviewTask = parseWorkItemId(await workItem("Review a clean suite"), "test review task");
    const impl = await workItem("Durable put");
    const check = await workItem("Checks of Durable put");
    const cited = [
      { type: "scope" as const, id: "S8", text: "put then get returns the value", side: "in" as const },
      { type: "scope" as const, id: "S9", text: "put survives a power loss", side: "in" as const },
    ];
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: check, status: "Completed", checksFor: impl, visionItems: cited.map((item) => item.text), sources: cited, checkedTitle: "Durable put", reviewReopens: 0, grade: "Strong", attemptModels: [] }],
      latest: async () => ({ checkTaskId: check, revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [{ name: "put-then-get", command: "sh put.sh", decides: ["S8", "S9"] }], files: [] }),
      frozen: async () => false,
    };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          const by = secondBy(request, catalog);
          if (request.secondOpinion === undefined) return { data: request.schema.parse({ problems: [] }), ...by };
          if (second instanceof Error) throw second;
          return { data: request.schema.parse(second(check)), ...by };
        },
      }),
    };
    const reviewer = new SuiteReviewer({ logger: recordingLogger(), llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });
    const outcome = await reviewer.review({ id: reviewTask, projectId, taskSpec: { origin: "review", visionItems: cited.map((item) => item.text) } }, "/unused");
    const kept = await db.execute(sql`
      SELECT u.item_id AS "itemId", u.judgement_id AS "judgementId", c.basis FROM undecided_items u JOIN suite_review_claims c ON c.id = u.claim_id
      WHERE u.review_task_id = ${reviewTask} ORDER BY u.item_id`);
    const claims = await db.execute(sql`
      SELECT basis, covered, first_model AS "firstModel", second_model AS "secondModel", second_strength AS "secondStrength", second_findings AS "secondFindings", second_failure AS "secondFailure"
      FROM suite_review_claims WHERE review_task_id = ${reviewTask}`);
    return { outcome, kept: kept.rows, claims: claims.rows, check };
  }

  test("a clean review another family confirms is recorded as a claim and leaves nothing undecided", async () => {
    const { outcome, kept, claims, check } = await reviewClean(() => ({ problems: [] }));
    expect(outcome).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-clean", strength: "other-family", unconfirmed: [] } });
    expect(kept).toEqual([]);
    expect(claims).toEqual([
      { basis: "second-opinion-clean", covered: [check], firstModel: "first/strong-a", secondModel: "second/strong-b", secondStrength: "other-family", secondFindings: [], secondFailure: null },
    ]);
  });

  test("a clean review the other family contradicts stores only the items it named undecided, tied to the claim", async () => {
    const doubt = (check: string) => ({ checkTasks: [check], kind: "undecided-item", item: "S9", problem: "no check distinguishes fsynced from written data", evidence: "sh put.sh" });
    const { outcome, kept, claims, check } = await reviewClean((check) => ({ problems: [doubt(check)] }));
    expect(outcome).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-found", unconfirmed: [{ itemId: "S9" }] } });
    expect(kept).toEqual([{ itemId: "S9", judgementId: null, basis: "second-opinion-found" }]);
    expect(claims).toMatchObject([{ basis: "second-opinion-found", secondFindings: [{ kind: "undecided-item", item: "S9" }] }]);
    const read = (await suiteReviewClaimsOf(db, projectId)).filter((claim) => claim.covered.includes(check));
    expect(read).toMatchObject([
      { basis: "second-opinion-found", second: { kind: "answered", strength: "other-family", findings: [{ item: "S9" }] }, unverified: [{ checkTaskId: check, itemId: "S9" }] },
    ]);
  });

  test("a clean review whose second review failed stores every covered item undecided, with why", async () => {
    const failure = new SecondOpinionUnanswered({ avoid: FIRST, strength: "other-family" }, { provider: "second", model: "strong-b" }, { cause: new ProviderError("second", "503", "provider") });
    const { kept, claims, check } = await reviewClean(failure);
    expect(kept).toEqual([
      { itemId: "S8", judgementId: null, basis: "second-review-failed" },
      { itemId: "S9", judgementId: null, basis: "second-review-failed" },
    ]);
    expect(claims).toMatchObject([{ basis: "second-review-failed", secondModel: null, secondStrength: null, secondFindings: [], secondFailure: expect.stringContaining("got no answer") }]);
    const read = (await suiteReviewClaimsOf(db, projectId)).filter((claim) => claim.covered.includes(check));
    expect(read).toMatchObject([{ basis: "second-review-failed", second: { kind: "failed", reason: expect.stringContaining("got no answer") }, unverified: [{ itemId: "S8" }, { itemId: "S9" }] }]);
  });

  test("an undecided item tied to neither a judgement nor a claim is refused, and a claim's basis must fit its second review", async () => {
    const reviewTask = await workItem("Review with a mislabelled claim");
    const checkTask = await workItem("Checks with a mislabelled claim");
    await expect(
      db.execute(sql`
        INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'S1', 'Keys can be stored')`),
    ).rejects.toThrow();
    // A confirmed claim holds the second model and its strength; one that failed holds why and no model.
    const claim = (basis: string, secondModel: string | null, secondStrength: string | null, failure: string | null) =>
      db.execute(sql`
        INSERT INTO suite_review_claims (project_id, review_task_id, basis, covered, first_model, second_model, second_strength, passed_over, second_findings, second_failure, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
        VALUES (${projectId}, ${reviewTask}, ${basis}, ${JSON.stringify([checkTask])}::jsonb, 'p/m', ${secondModel}, ${secondStrength}, '[]'::jsonb, '[]'::jsonb, ${failure}, 'Frontier', 'Strong', 'above', 'Frontier', ${secondModel === null ? null : "Frontier"})`);
    await expect(claim("second-opinion-clean", "p/m", null, null)).rejects.toThrow();
    await expect(claim("second-opinion-clean", "p/m", "other-family", null)).rejects.toThrow();
    await expect(claim("second-review-failed", null, null, null)).rejects.toThrow();
    // A found claim holds the findings that left items unverified.
    await expect(claim("second-opinion-found", "q/n", "other-family", null)).rejects.toThrow();
    await expect(claim("no-other-family", "q/n", "other-family", null)).rejects.toThrow();
    await claim("second-opinion-clean", "p/m", "same-model", null);
    await claim("second-review-failed", null, null, "no second opinion answered");
    await expect(db.execute(sql`UPDATE suite_review_claims SET basis = 'second-opinion-clean' WHERE review_task_id = ${reviewTask}`)).rejects.toThrow();
  });

  test("a no-other-family claim, whose second opinion came from the first's provider, reads back as no-other-family, its item unverified", async () => {
    const reviewTask = await workItem("Review with a same-provider second opinion");
    const checkTask = await workItem("Checks with a same-provider second opinion");
    const inserted = await db.execute(sql`
      INSERT INTO suite_review_claims (project_id, review_task_id, basis, covered, first_model, second_model, second_strength, passed_over, second_findings, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
      VALUES (${projectId}, ${reviewTask}, 'no-other-family', ${JSON.stringify([checkTask])}::jsonb, 'p/m', 'p/n', 'same-family-other-model', '[]'::jsonb, '[]'::jsonb, 'Strong', 'Strong', 'equal', 'Frontier', 'Strong')
      RETURNING id`);
    const claimId = z.array(z.object({ id: z.string() })).parse(inserted.rows)[0]?.id;
    await db.execute(sql`
      WITH tie AS (INSERT INTO undecided_item_claims (claim_id, check_task_id, item_id) VALUES (${claimId}, ${checkTask}, 'S1'))
      INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text, claim_id)
      VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'S1', 'Keys can be stored', ${claimId})`);
    const read = (await suiteReviewClaimsOf(db, projectId)).filter((claim) => claim.reviewTaskId === reviewTask);
    expect(read).toEqual([
      {
        reviewTaskId: reviewTask,
        basis: "no-other-family",
        covered: [checkTask],
        firstModel: "p/m",
        passedOver: [],
        unverified: [{ checkTaskId: checkTask, itemId: "S1", itemText: "Keys can be stored" }],
        second: { kind: "answered", model: "p/n", strength: "same-family-other-model", findings: [] },
        tiers: { kind: "recorded", judge: "Strong", judged: "Strong", relation: "equal", reviews: { kind: "graded", first: "Frontier", second: "Strong" } },
      },
    ]);
  });

  test("an undecided item tied to a claim is refused without that claim's tie in undecided_item_claims", async () => {
    const reviewTask = await workItem("Review with an untied claim item");
    const checkTask = await workItem("Checks with an untied claim item");
    const inserted = await db.execute(sql`
      INSERT INTO suite_review_claims (project_id, review_task_id, basis, covered, first_model, passed_over, second_findings, second_failure, judge_tier, judged_tier, tier_relation, first_tier)
      VALUES (${projectId}, ${reviewTask}, 'second-review-failed', ${JSON.stringify([checkTask])}::jsonb, 'p/m', '[]'::jsonb, '[]'::jsonb, 'no second opinion answered', 'Frontier', 'Strong', 'above', 'Frontier')
      RETURNING id`);
    const claimId = z.array(z.object({ id: z.string() })).parse(inserted.rows)[0]?.id;
    await expect(
      db.execute(sql`
        INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text, claim_id)
        VALUES (${projectId}, ${reviewTask}, ${checkTask}, 'S1', 'Keys can be stored', ${claimId})`),
    ).rejects.toThrow();
    await db.execute(sql`DELETE FROM suite_review_claims WHERE id = ${claimId}`);
  });

  test("an item two claims on one check task leave undecided is kept once and listed under both claims", async () => {
    const impl = await task("Durable put", { origin: "decomposition" }, "implementation");
    const check = await task("Checks of Durable put", { origin: "check", checksFor: impl }, "check");
    const repository = new SuiteReviewJudgementRepository(db);
    const item = { checkTaskId: check, itemId: "S9", itemText: "put survives a power loss" };
    const found = { checkTasks: [check], kind: "undecided-item" as const, item: "S9", problem: "no check distinguishes fsynced from written data", evidence: "sh put.sh" };
    const first = parseWorkItemId(await workItem("First review of Durable put"), "test review task");
    await repository.record({
      projectId,
      reviewTaskId: first,
      judgements: [],
      claim: {
        basis: "second-opinion-found",
        covered: [check],
        firstModel: FIRST,
        secondReview: { first: FIRST, second: { provider: "second", model: "strong-b", grade: "Frontier" as const }, strength: "other-family" },
        passedOver: [],
        second: [found],
        secondFailure: null,
        unconfirmed: [item],
        tiers: ABOVE_STRONG,
      },
    });
    const later = parseWorkItemId(await workItem("Later review of Durable put"), "test review task");
    await repository.record({
      projectId,
      reviewTaskId: later,
      judgements: [],
      claim: { basis: "second-review-failed", covered: [check], firstModel: FIRST, secondReview: null, passedOver: [], second: [], secondFailure: "no second opinion answered", unconfirmed: [item], tiers: ABOVE_STRONG },
    });

    const kept = await db.execute(sql`SELECT review_task_id AS "reviewTaskId" FROM undecided_items WHERE check_task_id = ${check}`);
    expect(kept.rows).toEqual([{ reviewTaskId: first }]);
    const read = (await suiteReviewClaimsOf(db, projectId)).filter((claim) => claim.covered.includes(check));
    expect(read.map((claim) => [claim.reviewTaskId, claim.basis, claim.unverified])).toEqual([
      [first, "second-opinion-found", [item]],
      [later, "second-review-failed", [item]],
    ]);
  });

  test("a check task under review is read with its grade and every model its attempts ran on, each with its catalog grade or none", async () => {
    const impl = await task("Store keys", { origin: "decomposition" }, "implementation");
    const graded = await task("Checks of Store keys", { origin: "check", checksFor: impl, capability: "Strong" }, "check");
    const ungraded = await task("Checks of Store keys, ungraded", { origin: "check", checksFor: impl }, "check");
    const review = await task("Review the plan's checks", { origin: "review" }, null);
    await db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${review}, ${graded}), (${review}, ${ungraded})`);
    const attempt = (taskId: string, model: string | null) =>
      model === null
        ? db.execute(sql`INSERT INTO dev_sessions (id, task_id, phase) VALUES (${randomUUID()}, ${taskId}, 'Completed')`)
        : db.execute(sql`
            INSERT INTO dev_sessions (id, task_id, phase, attempt_prompt_digest, attempt_terminal, attempt_turns, attempt_provider, attempt_model, attempt_cell)
            VALUES (${randomUUID()}, ${taskId}, 'Completed', ${"d".repeat(64)}, 'finished:done', 3, 'anthropic', ${model}, 'base-cell')`);
    await attempt(graded, "claude-opus-5-5");
    await attempt(graded, "a-model-no-catalog-holds");
    await attempt(graded, null);

    const read = await new TaskCheckRepository(db).checkTasksUnderReview(review);
    const byId = new Map(read.map((each) => [each.id, each]));
    expect(byId.get(graded)).toMatchObject({
      grade: "Strong",
      attemptModels: [
        { model: "claude-opus-5-5", grade: "Frontier" },
        { model: "a-model-no-catalog-holds", grade: null },
      ],
    });
    expect(byId.get(ungraded)).toMatchObject({ grade: null, attemptModels: [] });
    await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (${graded}, ${ungraded})`);
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
