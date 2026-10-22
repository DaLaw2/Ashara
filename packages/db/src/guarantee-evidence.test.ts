import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "./connection.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";

// Every row here belongs to a project this suite creates under a unique name; afterAll deletes the
// project, and its sweep and evidence rows with it.
// A sweep holds one evidence row per guarantee: a second row for the same guarantee on the same
// sweep is refused, so no reader ever has two verdicts' worth of evidence to choose between.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `guarantee-evidence-test-${randomUUID().slice(0, 8)}`;
const MAIN = "b7".repeat(20);

let db: Database;
let clientId: string;
let projectId: string;
let sweepId: string;

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

async function insertEvidence(guaranteeId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO guarantee_evidence (project_id, sweep_id, vision_version, guarantee_id, main_commit, checks)
    VALUES (${projectId}, ${sweepId}, 1, ${guaranteeId}, ${MAIN}, '[]'::jsonb)`);
}

async function rowsOf(guaranteeId: string): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM guarantee_evidence WHERE sweep_id = ${sweepId} AND guarantee_id = ${guaranteeId}`);
  return z.array(z.object({ n: z.number() })).length(1).parse(result.rows)[0]?.n ?? -1;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
  const result = await db.execute(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, check_outcomes)
    VALUES (${projectId}, ${MAIN}, 'v1', '[]'::jsonb, '[]'::jsonb, true, 'all suites passed', '[]'::jsonb)
    RETURNING id`);
  const [row] = z.array(z.object({ id: z.string() })).length(1).parse(result.rows);
  if (row === undefined) throw new Error("the sweep insert returned no row");
  sweepId = row.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("guarantee_evidence", () => {
  test("one sweep holds one row per guarantee: a second row for the same guarantee is refused, another guarantee's is not", async () => {
    await insertEvidence("G1");
    expect(await failureOf(() => insertEvidence("G1"))).toMatch(/guarantee_evidence_one_per_sweep/);
    await insertEvidence("G2");
    expect([await rowsOf("G1"), await rowsOf("G2")]).toEqual([1, 1]);
  });
});
