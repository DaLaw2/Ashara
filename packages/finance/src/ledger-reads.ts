import { sql } from "drizzle-orm";
import type { DbHandle } from "@ashara/db";

// Finance's published reads of the call ledger (llm_calls) for the run report and the reviewer
// record: what another context reads of the ledger goes through these, never a query of its own.
// Each returns the rows as Postgres returns them; the reader parses them with its own schema.

/**
 * The project's calls per task (null for the project's own) and provider: counts, measured and estimated cost, and
 * tokens. `unestimatedCalls` counts the calls with neither a measured cost nor an estimate, which `unmeasuredEstimateUsd`
 * leaves out.
 */
export async function callTotalsByTaskAndProvider(db: DbHandle, projectId: string): Promise<readonly unknown[]> {
  const result = await db.execute(sql`
    SELECT task_id AS "taskId", provider,
           COUNT(*)::int AS calls,
           COUNT(cost_usd)::int AS "measuredCalls",
           COALESCE(SUM(cost_usd), 0)::float8 AS "measuredUsd",
           COALESCE(SUM(estimated_cost_usd) FILTER (WHERE cost_usd IS NULL), 0)::float8 AS "unmeasuredEstimateUsd",
           COUNT(*) FILTER (WHERE cost_usd IS NULL AND estimated_cost_usd IS NULL)::int AS "unestimatedCalls",
           COUNT(*) FILTER (WHERE state = 'pending')::int AS "pendingCalls",
           COUNT(*) FILTER (WHERE state = 'unmeasured_after_crash')::int AS "lostCalls",
           COUNT(*) FILTER (WHERE cost_usd = 0)::int AS "zeroCostCalls",
           COUNT(*) FILTER (WHERE input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL)::int AS "cacheCountedCalls",
           COALESCE(SUM(input_tokens) FILTER (WHERE cache_read_tokens IS NOT NULL), 0)::bigint AS "inputTokens",
           COALESCE(SUM(cache_read_tokens) FILTER (WHERE input_tokens IS NOT NULL), 0)::bigint AS "cacheReadTokens"
    FROM llm_calls
    WHERE project_id = ${projectId}
    GROUP BY task_id, provider
    ORDER BY task_id NULLS FIRST, provider`);
  return result.rows;
}

/** Every call of the project made for a task, oldest first: its task, site, when, cost, input tokens and the window of the model it was sent to. */
export async function taskCallsOf(db: DbHandle, projectId: string): Promise<readonly unknown[]> {
  const result = await db.execute(sql`
    SELECT task_id AS "taskId", call_site AS "callSite", created_at AS "createdAt",
           cost_usd::float8 AS "costUsd", input_tokens AS "inputTokens", context_window_tokens AS "contextWindowTokens"
    FROM llm_calls
    WHERE project_id = ${projectId} AND task_id IS NOT NULL
    ORDER BY created_at, id`);
  return result.rows;
}

/** One row: the project's calls at `callSite` to the model `providerModel` names ("<provider>/<model>"), how many were measured, and their measured cost. */
export async function siteCostOf(db: DbHandle, projectId: string, callSite: string, providerModel: string): Promise<readonly unknown[]> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS calls, count(cost_usd)::int AS "measuredCalls", coalesce(sum(cost_usd), 0)::float8 AS "measuredUsd"
    FROM llm_calls
    WHERE project_id = ${projectId} AND call_site = ${callSite} AND provider || '/' || model = ${providerModel}`);
  return result.rows;
}
