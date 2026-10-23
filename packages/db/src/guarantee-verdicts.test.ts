import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "./connection.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";

// Every row here belongs to a project this suite creates under a unique name; afterAll deletes the
// project, and its sweep, report and verdict rows with it.
// A stored verdict speaks the hidden suite's vocabulary and nothing else: a reason outside it, an
// unjudged verdict with no reason, a reason on a judged verdict, or a pass resting on a review's
// reading are refused by the table itself, whatever writes the row. A verdict of a message no sweep
// is on record for judges nothing: it is unjudged for want of a sweep on a commit, or refused.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `guarantee-verdicts-test-${randomUUID().slice(0, 8)}`;
const MAIN = "c4".repeat(20);

let db: Database;
let clientId: string;
let projectId: string;
let sweepId: string;
let reportId: string;

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

const idRows = z.array(z.object({ id: z.string() })).length(1);

async function insertedId(statement: ReturnType<typeof sql>): Promise<string> {
  const [row] = idRows.parse((await db.execute(statement)).rows);
  if (row === undefined) throw new Error("the insert returned no row");
  return row.id;
}

interface VerdictRow {
  readonly guaranteeId: string;
  readonly verdict: string;
  readonly reason: string | null;
  readonly evidenceClass: string;
}

async function insertVerdict(row: VerdictRow, swept: "swept" | "no-sweep" = "swept"): Promise<void> {
  await db.execute(sql`
    INSERT INTO guarantee_verdicts (project_id, report_id, sweep_id, vision_version, guarantee_id, verdict, reason, basis, evidence_class)
    VALUES (${projectId}, ${reportId}, ${swept === "swept" ? sweepId : null}, 1, ${row.guaranteeId}, ${row.verdict}, ${row.reason}, 'client-stated', ${row.evidenceClass})`);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
  sweepId = await insertedId(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, check_outcomes)
    VALUES (${projectId}, ${MAIN}, 'v1', '[]'::jsonb, '[]'::jsonb, true, 'all suites passed', '[]'::jsonb)
    RETURNING id`);
  reportId = await insertedId(sql`
    INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'outbound', 'report', 'Your project is delivered.')
    RETURNING id`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("guarantee_verdicts", () => {
  test("an unjudged verdict is stored with a reason of the vocabulary, and refused with one outside it", async () => {
    await insertVerdict({ guaranteeId: "G1", verdict: "unjudged", reason: "no-sweep-on-commit", evidenceClass: "none" });
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G2", verdict: "unjudged", reason: "confirmed-by-review", evidenceClass: "review-only" }))).toMatch(
      /guarantee_verdicts_reason_known/,
    );
  });

  test("a reason is stored exactly when the verdict is unjudged", async () => {
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G3", verdict: "unjudged", reason: null, evidenceClass: "none" }))).toMatch(/guarantee_verdicts_reason_when_unjudged/);
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G4", verdict: "fail", reason: "review-only", evidenceClass: "implementer-visible" }))).toMatch(
      /guarantee_verdicts_reason_when_unjudged/,
    );
  });

  test("a pass rests on executed evidence: one resting on a review's reading is refused", async () => {
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G5", verdict: "pass", reason: null, evidenceClass: "review-only" }))).toMatch(/guarantee_verdicts_pass_executed/);
    await insertVerdict({ guaranteeId: "G5", verdict: "pass", reason: null, evidenceClass: "implementer-visible" });
  });

  test("a verdict naming no sweep is unjudged for want of a sweep on a commit or as not verifiable by Ashara, and refused as anything else", async () => {
    await insertVerdict({ guaranteeId: "G6", verdict: "unjudged", reason: "no-sweep-on-commit", evidenceClass: "none" }, "no-sweep");
    await insertVerdict({ guaranteeId: "G9", verdict: "unjudged", reason: "not-verifiable-by-ashara", evidenceClass: "none" }, "no-sweep");
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G7", verdict: "unjudged", reason: "no-executed-evidence", evidenceClass: "none" }, "no-sweep"))).toMatch(
      /guarantee_verdicts_no_sweep_unjudged/,
    );
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G8", verdict: "fail", reason: null, evidenceClass: "implementer-visible" }, "no-sweep"))).toMatch(
      /guarantee_verdicts_no_sweep_unjudged/,
    );
  });

  test("one report holds one verdict per guarantee", async () => {
    expect(await failureOf(() => insertVerdict({ guaranteeId: "G1", verdict: "fail", reason: null, evidenceClass: "implementer-visible" }))).toMatch(/guarantee_verdicts_one_per_report/);
  });
});
