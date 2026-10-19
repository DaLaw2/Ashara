import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Database } from "./connection.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";

// Against the shared dev database: every row here is created by this suite under
// a unique name and deleted in afterAll; nothing else is read or written.
// A suite review row records how its judges stood to the check work: a tier the vocabulary names,
// a relation that fits the two tiers, and never a judge below the work; and each review's grade,
// the weaker being the judge tier.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `suite-review-tiers-test-${randomUUID().slice(0, 8)}`;

let db: Database;
let clientId: string;
let projectId: string;
let reviewTask: string;
let checkTask: string;

/** The message of `err` and of every error in its `cause` chain, joined. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/** The message chain of the statement's failure; a statement that succeeds fails the test. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return messageChain(e);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function workItem(title: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO work_items (id, level, status, title, project_id) VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId})`);
  return id;
}

/**
 * The judge columns, then each review's grade: unless given, both the judge tier's, or Frontier where
 * that is no tier, so a row refused for its judge columns is refused for them alone.
 */
type Tiers =
  | readonly [judge: string | null, judged: string | null, relation: string | null]
  | readonly [judge: string | null, judged: string | null, relation: string | null, first: string | null, second: string | null];

const TIER_NAMES: readonly string[] = ["Light", "Medium", "Strong", "Frontier"];

function reviewTiers(tiers: Tiers): readonly [string | null, string | null] {
  if (tiers.length === 5) return [tiers[3], tiers[4]];
  const grade = tiers[0] !== null && TIER_NAMES.includes(tiers[0]) ? tiers[0] : "Frontier";
  return [grade, grade];
}

function claim(tiers: Tiers) {
  const [judge, judged, relation] = tiers;
  const [first, second] = reviewTiers(tiers);
  return db.execute(sql`
    INSERT INTO suite_review_claims (project_id, review_task_id, basis, covered, first_model, second_model, second_strength, passed_over, second_findings, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
    VALUES (${projectId}, ${reviewTask}, 'second-opinion-clean', ${JSON.stringify([checkTask])}::jsonb, 'p/m', 'q/n', 'other-family', '[]'::jsonb, '[]'::jsonb, ${judge}, ${judged}, ${relation}, ${first}, ${second})`);
}

function judgement(tiers: Tiers) {
  const [judge, judged, relation] = tiers;
  const [first, second] = reviewTiers(tiers);
  const finding = JSON.stringify({ checkTasks: [checkTask], kind: "undecided-item", item: "S1", problem: "p", evidence: "e" });
  return db.execute(sql`
    INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
    VALUES (${projectId}, ${reviewTask}, ${checkTask}, NULL, 'advisory', 'second-opinion-disagreed', ${finding}::jsonb, '[]'::jsonb, 'p/m', 'q/n', 'other-family', '[]'::jsonb, ${judge}, ${judged}, ${relation}, ${first}, ${second})`);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
  reviewTask = await workItem("Review the plan's checks");
  checkTask = await workItem("Checks of Store keys");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe.each([
  ["suite_review_claims", claim],
  ["suite_review_judgements", judgement],
] as const)("%s judge tiers", (table, insert) => {
  test("a judge above the work, or at its tier, is recorded with the relation that fits", async () => {
    await insert(["Frontier", "Strong", "above"]);
    await insert(["Strong", "Strong", "equal"]);
    await insert(["Strong", "Strong", "equal", "Frontier", "Strong"]);
  });

  test.each([
    ["a relation that is neither above nor equal", ["Frontier", "Strong", "below"], `${table}_tier_relation_known`],
    ["a judge tier the vocabulary does not name", ["Ultra", "Strong", "above"], `${table}_judge_tier_known`],
    ["a judged tier the vocabulary does not name", ["Frontier", "Standard", "above"], `${table}_judged_tier_known`],
    ["a judge graded below the work", ["Medium", "Strong", "above"], `${table}_tier_relation_fits`],
    ["equal over two different tiers", ["Frontier", "Strong", "equal"], `${table}_tier_relation_fits`],
    ["above over one tier", ["Strong", "Strong", "above"], `${table}_tier_relation_fits`],
    ["a row with no tiers", [null, null, null], `${table}_tiers_recorded`],
    ["a row with only some tiers", ["Frontier", null, "above"], `${table}_tiers_recorded`],
    ["a first review's grade the vocabulary does not name", ["Strong", "Strong", "equal", "Ultra", "Strong"], `${table}_first_tier_known`],
    ["a row with no first review's grade", ["Strong", "Strong", "equal", null, "Strong"], `${table}_review_tiers_recorded`],
    ["an answered second review with no grade", ["Strong", "Strong", "equal", "Strong", null], `${table}_review_tiers_recorded`],
    ["a judge tier that is not the weaker review's grade", ["Frontier", "Strong", "above", "Frontier", "Strong"], `${table}_judge_tier_weaker`],
  ] as const)("refuses %s", async (_what, tiers, constraint) => {
    expect(await failureOf(() => insert(tiers))).toContain(constraint);
  });
});
