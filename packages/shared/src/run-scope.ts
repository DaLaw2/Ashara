/**
 * Published Language: the run-scope association on a work item.
 *
 * Every work item carries a run scope that says which run created it. The
 * value is either a runId (UUID from openRun), RUN_SCOPE_PRE_SCOPING for
 * rows that existed before the column was added, or RUN_SCOPE_AD_HOC for
 * items created outside any orchestrator run (HTTP API).
 *
 * No default: every insert site must supply the value explicitly (Discipline A).
 */

export const RUN_SCOPE_PRE_SCOPING = "pre-scoping" as const;

/**
 * Sentinel for work items created outside any orchestrator run — HTTP API
 * calls (POST /work-items, POST /work-items/bulk) that do not pass through the
 * core loop. Distinct from RUN_SCOPE_PRE_SCOPING (which marks migration
 * backfill) so the run summary can tell "historical data" from "someone poked
 * the API while no run was open." See Discipline A: two different epistemic
 * states must not collapse to one value.
 */
export const RUN_SCOPE_AD_HOC = "ad-hoc" as const;
