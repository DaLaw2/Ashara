import { afterAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, DEFAULT_DATABASE_URL, PROJECT_BLOCK_KINDS } from "@ashara/db";
import { WORK_ITEM_STATUSES } from "@ashara/delivery";
import { PROJECT_STATUSES } from "@ashara/engagement";
import { ATTEMPT_TERMINALS } from "@ashara/workplace";

// The code's lifecycle lists against the CHECK constraints the migrations wrote: a member one
// side has and the other lacks is either unwritable or unread.

const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
afterAll(() => db.$client.end());

const ConstraintRowSchema = z.object({ definition: z.string() });

async function checkedValues(table: string, constraint: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
     WHERE c.conrelid = to_regclass(${table}) AND c.conname = ${constraint}`);
  const [row] = z.tuple([ConstraintRowSchema]).parse(result.rows);
  return [...row.definition.matchAll(/'([^']*)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

describe("lifecycle lists match the schema", () => {
  test.each([
    ["work_items", "work_items_status_check", WORK_ITEM_STATUSES],
    ["projects", "projects_status_known", PROJECT_STATUSES],
    ["project_blocks", "project_blocks_kind_check", PROJECT_BLOCK_KINDS],
    ["dev_sessions", "dev_sessions_attempt_terminal_check", ATTEMPT_TERMINALS],
  ])("%s %s", async (table, constraint, list) => {
    expect([...(await checkedValues(table, constraint))].sort()).toEqual([...list].sort());
  });
});
