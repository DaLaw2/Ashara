-- Migration 078: the trace id on the two rows an operator starts a reading from (story
-- c-observability, task t-obs-correlation; Decided: owner 2026-10-17, c-observability O1).
--
-- llm_calls.trace_id: the trace of the log scope the call was admitted in, written with its
-- admission, so a call's row leads to the records of the cycle or dispatch that made it.
-- dev_sessions.trace_id: the trace of the dispatched attempt the session was opened in.
-- Both are NULL only on rows written before this migration; every row written after it carries one.
ALTER TABLE llm_calls
  ADD COLUMN trace_id TEXT,
  ADD CONSTRAINT llm_calls_trace_id_nonempty CHECK (trace_id IS NULL OR trace_id <> '');

ALTER TABLE dev_sessions
  ADD COLUMN trace_id TEXT,
  ADD CONSTRAINT dev_sessions_trace_id_nonempty CHECK (trace_id IS NULL OR trace_id <> '');
