-- Migration 075: the context window guard (m3-scope X3, task t-context-window-guard; architecture
-- §13.6 "Fail-closed").
--
-- llm_calls.context_window_tokens: the context window of the model a call was sent to
-- (model_configs.max_context_tokens at the time), so each call's utilisation is its input_tokens
-- over it. Written with the call's record; NULL on rows recorded before this migration and on rows
-- not recorded yet. A row whose input_tokens is NULL has an unknown utilisation, never 0%.
--
-- dev_sessions.attempt_terminal admits 'context_budget_exceeded': an attempt whose turn would not
-- fit its model's window (the gateway's preflight), or that the provider rejected as longer than
-- the window, ends on it, a failure.
ALTER TABLE llm_calls
  ADD COLUMN context_window_tokens INTEGER,
  ADD CONSTRAINT llm_calls_context_window_positive CHECK (context_window_tokens IS NULL OR context_window_tokens > 0);

ALTER TABLE dev_sessions
  DROP CONSTRAINT dev_sessions_attempt_terminal_check,
  ADD CONSTRAINT dev_sessions_attempt_terminal_check CHECK (attempt_terminal IN (
    'finished:done', 'finished:blocked', 'disputed', 'model_stopped_without_finish', 'output_truncated',
    'context_budget_exceeded', 'turn_cap', 'wall_clock', 'transport_exhausted', 'refused', 'environment_failure',
    'cancelled'
  ));
