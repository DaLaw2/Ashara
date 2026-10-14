-- Migration 050: an attempt whose turn was cut at the output token limit has its own terminal
-- (story c-walking-skeleton-run, task t-d92-cut-turn-no-tools; ADR-074 d92 c).
--
-- A turn whose output was cut ('length' from the SDK, 'truncated' in the gateway's TurnResult)
-- runs none of its tool calls: a call written in a cut response may itself be cut. The attempt
-- ends as 'output_truncated', a failure, and its dev_sessions row records that terminal.
ALTER TABLE dev_sessions
  DROP CONSTRAINT dev_sessions_attempt_terminal_check,
  ADD CONSTRAINT dev_sessions_attempt_terminal_check CHECK (attempt_terminal IN (
    'finished:done', 'finished:blocked', 'disputed', 'model_stopped_without_finish', 'output_truncated',
    'turn_cap', 'wall_clock', 'transport_exhausted', 'refused', 'environment_failure', 'cancelled'
  ));
