-- Migration 035: Finance's llm_calls ledger is the one spend authority (story
-- s-loop-never-stop-m1, task t-spend-one-ledger).
--
-- Before this, three counters capped spend: the orchestrator's BudgetTracker
-- (persisted in system_settings 'orchestrator.run_state'), the gateway's
-- in-memory BudgetLedger (reset on restart), and llm_calls, which no code read.
-- From here on the cap is the sum of llm_calls, per project and per deployment.
--
-- estimated_cost_usd is Finance's worst-case estimate of the call, made before
-- it was sent. A call whose cost_usd is NULL (unmeasured) counts against the cap
-- at this estimate, never at $0. It is required on every row written from now
-- on, by a CHECK added NOT VALID: the rows written before this migration were
-- never estimated, and a backfilled estimate would be invented. Postgres
-- enforces a NOT VALID CHECK on every INSERT and UPDATE and skips only existing
-- rows; llm_calls is append-only.
--
-- llm_calls_spend_known is VALIDATED: every row, old ones included, must carry a
-- cost or an estimate, or the cap would have to read an unmeasured row as $0.
-- On a database holding a pre-035 row with cost_usd NULL this migration fails;
-- that row's spend cannot be counted, and the owner decides what it cost.

ALTER TABLE llm_calls ADD COLUMN estimated_cost_usd NUMERIC(20, 12) CHECK (estimated_cost_usd > 0);

ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_estimate_recorded CHECK (estimated_cost_usd IS NOT NULL) NOT VALID;

ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_spend_known CHECK (cost_usd IS NOT NULL OR estimated_cost_usd IS NOT NULL);

-- The run record held the BudgetTracker's spend. It is deleted with that counter;
-- refuse to delete one that recorded more than llm_calls holds, since that spend
-- would silently leave the cap.
DO $$
DECLARE
  recorded NUMERIC;
  ledger NUMERIC;
BEGIN
  SELECT (value::jsonb ->> 'spendUsd')::numeric INTO recorded
    FROM system_settings WHERE key = 'orchestrator.run_state';
  SELECT COALESCE(SUM(cost_usd), 0) INTO ledger FROM llm_calls;
  IF recorded IS NOT NULL AND recorded > ledger THEN
    RAISE EXCEPTION 'orchestrator.run_state records $% spent but llm_calls sums to $%; that spend would leave the cap. Record it in llm_calls by hand before migrating.', recorded, ledger;
  END IF;
END $$;

DELETE FROM system_settings WHERE key = 'orchestrator.run_state';

-- task_cost_history fed only the deleted CostEstimator.
DROP TABLE task_cost_history;
