import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { REPORT_SUBJECT, REPORT_SUBJECTS } from "@ashara/engagement/report-subjects";

// The subjects a report is on are Engagement's vocabulary, and the column's CHECK, written in a
// migration that cannot import it, must admit exactly that vocabulary: a subject added on one side
// only is a report the database refuses, or a value no reader names.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

let db: Database;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db.$client.end();
});

/** The values client_messages_reports_on_known admits for reports_on, as the migrated database holds the constraint. */
async function checkedSubjects(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'client_messages' AND c.conname = 'client_messages_reports_on_known'`);
  const [row] = z.array(z.object({ definition: z.string() })).length(1).parse(result.rows);
  if (row === undefined) return expect.unreachable("the constraint is not on record");
  const list = /reports_on\)::text = ANY \(\(ARRAY\[(.*?)\]\)::text\[\]\)/.exec(row.definition)?.[1];
  if (list === undefined) return expect.unreachable(`the constraint lists no reports_on values: ${row.definition}`);
  return [...list.matchAll(/'([^']+)'::character varying/g)].map((match) => z.string().parse(match[1]));
}

describe("the report-subject vocabulary", () => {
  test("names each subject once, and the tuple holds every named subject", () => {
    expect([...REPORT_SUBJECTS].sort()).toEqual(Object.values(REPORT_SUBJECT).sort());
    expect(new Set(REPORT_SUBJECTS).size).toBe(REPORT_SUBJECTS.length);
  });

  test("the reports_on CHECK admits exactly the vocabulary's subjects", async () => {
    expect((await checkedSubjects()).sort()).toEqual([...REPORT_SUBJECTS].sort());
  });
});
