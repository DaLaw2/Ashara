import { Column, is, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { qualifiedColumn } from "@ashara/db";
import { CAPABILITY_RANK, CapabilityLevelSchema } from "@ashara/model-access";

// The grade of the work an attempt did, read from Model Access's catalog: Finance is the context
// that reads the catalog for every other one, so this is the one spelling every reader imports.

/** The catalog's tiers, weakest first, as a Postgres text array. */
const TIERS_WEAKEST_FIRST = sql`ARRAY[${sql.join(
  [...CapabilityLevelSchema.options].sort((a, b) => CAPABILITY_RANK[a] - CAPABILITY_RANK[b]).map((tier) => sql`${tier}`),
  sql`, `,
)}]::text[]`;

/** A column named with its table, so a select list does not hand the subquery a bare name; an aliased reference as written. */
const named = (ref: AnyColumn | SQL): SQL => (is(ref, Column) ? qualifiedColumn(ref) : ref);

/**
 * The catalog grade of the model an attempt ran on, as a scalar SQL expression over the attempt's
 * recorded model and provider (dev_sessions.attempt_model, attempt_provider): the catalog row of
 * that model served by that provider, since a model id under another provider is another model.
 * The thinking mode an attempt was called in is not recorded, so its grade is the higher of the
 * model's two grades: the work's tier is never understated. Null when the catalog holds no such
 * model under that provider, which a reader reports as an ungraded attempt, never as a low one.
 */
export function attemptGrade(model: AnyColumn | SQL, provider: AnyColumn | SQL): SQL<unknown> {
  const on = sql`array_position(${TIERS_WEAKEST_FIRST}, graded.capability)`;
  const off = sql`array_position(${TIERS_WEAKEST_FIRST}, graded.capability_thinking_off)`;
  return sql`(SELECT CASE WHEN ${on} IS NULL OR ${off} IS NULL THEN NULL
      WHEN ${on} >= ${off} THEN graded.capability ELSE graded.capability_thinking_off END
    FROM model_configs graded WHERE graded.model_id = ${named(model)} AND graded.provider_name = ${named(provider)})`;
}
