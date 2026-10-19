import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "./connection.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";

// Every row here belongs to a project this suite creates under a unique name; afterAll deletes the
// project, which is the only way a reviewer_outcomes row leaves.
// A reviewer outcome is never changed or removed while its project stands, and names only a verdict
// kind, reviewer role, outcome and evidence kind the vocabulary holds.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `reviewer-outcomes-test-${randomUUID().slice(0, 8)}`;

let db: Database;
let clientId: string;
let projectId: string;

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

interface Outcome {
  readonly project?: string;
  readonly verdictKind?: string;
  readonly role?: string;
  readonly outcome?: string;
  readonly evidenceKind?: string;
  readonly evidenceRef?: string;
  readonly verdictId?: string;
}

/** Inserts one outcome, a pass a dispute contradicted unless `o` says otherwise; returns its id. */
async function insert(o: Outcome = {}): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO reviewer_outcomes (project_id, verdict_kind, verdict_id, reviewer_model, reviewer_role, outcome, evidence_kind, evidence_ref)
    VALUES (${o.project ?? projectId}, ${o.verdictKind ?? "claim"}, ${o.verdictId ?? randomUUID()}, 'p/m', ${o.role ?? "first"},
            ${o.outcome ?? "pass-contradicted"}, ${o.evidenceKind ?? "dispute-upheld"}, ${o.evidenceRef ?? randomUUID()})
    RETURNING id`);
  const [row] = z.array(z.object({ id: z.string() })).length(1).parse(result.rows);
  if (row === undefined) throw new Error("the insert returned no row");
  return row.id;
}

async function rowsOf(project: string): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM reviewer_outcomes WHERE project_id = ${project}`);
  return z.array(z.object({ n: z.number() })).length(1).parse(result.rows)[0]?.n ?? -1;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("reviewer_outcomes is append-only", () => {
  test("an update is refused", async () => {
    const id = await insert();
    expect(await failureOf(() => db.execute(sql`UPDATE reviewer_outcomes SET outcome = 'finding-witnessed' WHERE id = ${id}`))).toContain("reviewer_outcomes is append-only: UPDATE refused");
  });

  test("a delete is refused while the row's project stands", async () => {
    const id = await insert();
    expect(await failureOf(() => db.execute(sql`DELETE FROM reviewer_outcomes WHERE id = ${id}`))).toContain("reviewer_outcomes is append-only: DELETE refused");
  });

  test("the row leaves with its project", async () => {
    const other = (await new ProjectRepository(db).create(`${NAME}-gone`, clientId)).id;
    await insert({ project: other });
    expect(await rowsOf(other)).toBe(1);
    await db.execute(sql`DELETE FROM projects WHERE id = ${other}`);
    expect(await rowsOf(other)).toBe(0);
  });

  test("the same verdict, reviewer and evidence is one row", async () => {
    const verdictId = randomUUID();
    const evidenceRef = randomUUID();
    await insert({ verdictId, evidenceRef });
    expect(await failureOf(() => insert({ verdictId, evidenceRef }))).toContain("reviewer_outcomes_one_per_evidence");
    await insert({ verdictId, evidenceRef, role: "second" });
  });
});

describe("reviewer_outcomes vocabulary", () => {
  test("every kind the vocabulary holds is written", async () => {
    for (const verdictKind of ["claim", "judgement", "intake-reading"]) await insert({ verdictKind });
    for (const role of ["first", "second"]) await insert({ role });
    for (const evidenceKind of ["dispute-upheld", "acceptance-failed", "check-reauthored", "replay", "operator-probe"]) await insert({ evidenceKind });
    await insert({ verdictKind: "judgement", outcome: "finding-witnessed", evidenceKind: "check-reauthored" });
    await insert({ verdictKind: "judgement", outcome: "finding-refuted", evidenceKind: "check-reauthored" });
  });

  test.each([
    ["an unknown outcome", { outcome: "pass-held" }, "reviewer_outcomes_outcome_known"],
    ["an unknown evidence kind", { evidenceKind: "hunch" }, "reviewer_outcomes_evidence_kind_known"],
    ["an unknown verdict kind", { verdictKind: "plan" }, "reviewer_outcomes_verdict_kind_known"],
    ["an unknown reviewer role", { role: "third" }, "reviewer_outcomes_reviewer_role_known"],
    ["a finding refuted by a failing check", { outcome: "finding-refuted", evidenceKind: "acceptance-failed" }, "reviewer_outcomes_refuted_by_reading"],
    ["an empty evidence reference", { evidenceRef: "" }, "reviewer_outcomes_evidence_ref_check"],
  ] as const)("refuses %s", async (_what, outcome, constraint) => {
    expect(await failureOf(() => insert(outcome))).toContain(constraint);
  });
});
