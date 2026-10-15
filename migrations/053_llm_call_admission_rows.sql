-- Migration 053: an admitted model call's worst-case estimate is durable (ADR-080 d3, group F7;
-- story s-legacy-review-ddd-shape, task t-ddd-fix-durable-reservation).
--
-- Before this, Finance held an admitted call's estimate in a process-memory Map until its row was
-- inserted after the call. A process that died between admission and record, or an insert that
-- failed, left a call that was paid for with no llm_calls row, and after a restart the cap did not
-- count it (Discipline B: a counter in memory is not a cap).
--
-- From here on the spend cap writes the row at admission, carrying only the estimate, and the call's
-- record completes that same row. `state` says which:
--   pending                 admitted, not yet recorded; counted at estimated_cost_usd
--   recorded                completed by the call's record; counted at cost_usd, or at the estimate
--                           when the cost was unmeasured
--   unmeasured_after_crash  found pending at a later process's startup: the call may have been sent
--                           and its cost is unknown, so it stays counted at its estimate forever
-- Every row written before this migration was recorded. The column has no default afterwards, so
-- every insert names its state.
--
-- llm_calls is no longer append-only: a row is updated once, from pending (or
-- unmeasured_after_crash) to recorded, and a startup reconciliation moves pending to
-- unmeasured_after_crash. No row is ever deleted, and no estimate is ever rewritten.

ALTER TABLE llm_calls ADD COLUMN state TEXT NOT NULL DEFAULT 'recorded'
  CHECK (state IN ('pending', 'recorded', 'unmeasured_after_crash'));
ALTER TABLE llm_calls ALTER COLUMN state DROP DEFAULT;

-- A row not yet recorded has no outcome: the call has not returned.
ALTER TABLE llm_calls ALTER COLUMN outcome DROP NOT NULL;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_outcome_when_recorded CHECK ((state = 'recorded') = (outcome IS NOT NULL));

-- Nothing about the call's result is known before it is recorded.
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_unrecorded_measures_nothing CHECK (
    state = 'recorded' OR (
      cost_usd IS NULL AND error_kind IS NULL AND finish_reason IS NULL AND input_tokens IS NULL
      AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
      AND reasoning_tokens IS NULL));

-- Migration 030 required a finish reason on every new row; only a recorded row has one. Still NOT
-- VALID: the rows written before 030 keep their NULL.
ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_finish_reason_recorded;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_finish_reason_recorded CHECK (state <> 'recorded' OR finish_reason IS NOT NULL) NOT VALID;

CREATE INDEX idx_llm_calls_pending ON llm_calls (id) WHERE state = 'pending';
