import { z } from "zod";

/**
 * Published Language: the run-scope association on a work item.
 *
 * Every work item carries a run scope that says which run created it. The
 * value is either a runId (UUID from openRun), RUN_SCOPE_AD_HOC for items
 * created without a run id, or the migration backfill value "pre-scoping" on
 * rows that existed before the column was added. Today the only work-item
 * writer is the server's first-plan store, which writes RUN_SCOPE_AD_HOC; no
 * code path writes a runId.
 *
 * No default: every insert site must supply the value explicitly (Discipline A).
 * The DB column is NOT NULL for exactly this reason — an undefined appearing
 * on the read side would be a contradiction.
 */

/**
 * Sentinel for work items created without an orchestrator run id — today a
 * project's first plan, which the server's first-plan store writes without the
 * loop's run id. Distinct from the "pre-scoping" migration backfill value so
 * "historical data" and "created outside a run" stay two different epistemic
 * states (Discipline A).
 */
export const RUN_SCOPE_AD_HOC = "ad-hoc" as const;

/**
 * Schema for the run_scope column. A non-empty string: either a runId (UUID),
 * "pre-scoping", or RUN_SCOPE_AD_HOC. The set is open on the runId
 * side (new UUIDs appear every run) so this validates shape, not membership.
 */
const runScopeSchema = z.string().min(1);

/**
 * Typed failure for a run_scope value that is present but unreadable.
 * @testseam run-scope.test.ts asserts the typed rejection and its context
 */
export class RunScopeCorrupt extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly detail: string,
  ) {
    super(`run_scope value is not valid (${detail})`);
    this.name = "RunScopeCorrupt";
  }
}

/**
 * Parses a value from the `run_scope` column. THROWS on null, undefined,
 * empty string, or non-string — the column is NOT NULL and absence was
 * judged unacceptable when the column was added. A null on the read side
 * is a boundary violation, not a policy default (Discipline A).
 */
export function parseRunScope(raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new RunScopeCorrupt(raw, "run_scope is NOT NULL but received null/undefined");
  }
  const result = runScopeSchema.safeParse(raw);
  if (!result.success) {
    throw new RunScopeCorrupt(
      raw,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
