-- Migration 046: what each attempt was, on its dev_sessions row (story c-walking-skeleton-run,
-- task t-w8-exit-evidence; roadmap M2 exit 7, ADR-074 d82 W8).
--
-- A dev session whose dispatch reached the Workplace attempt loop records, in the same write as
-- its terminal phase, the attempt's typed terminal, its turns, the model it ran on, the cell it
-- ran in, and the prompt digest: sha256 (hex) over the system prompt, messages and tools of its
-- first model call (workplace/src/prompt-digest.ts). All six columns are NULL together or set
-- together. NULL means only that no attempt was recorded: a session still open, one that ended
-- before the model (stale checks, work already delivered on main), one whose attempt threw, a crash
-- orphan the startup reconciler closed, and every row from before this migration all read NULL, so
-- NULL is never read as "no model call". The environment version stays migration 034's column; the cell
-- column says explicitly which attempts ran on the BaseCell, so a NULL environment version is
-- never read as "base cell" by absence.
ALTER TABLE dev_sessions
  ADD COLUMN attempt_prompt_digest TEXT CHECK (attempt_prompt_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN attempt_terminal TEXT CHECK (attempt_terminal IN (
    'finished:done', 'finished:blocked', 'disputed', 'model_stopped_without_finish', 'turn_cap',
    'wall_clock', 'transport_exhausted', 'refused', 'environment_failure', 'cancelled'
  )),
  ADD COLUMN attempt_turns INTEGER CHECK (attempt_turns >= 0),
  ADD COLUMN attempt_provider TEXT CHECK (attempt_provider <> ''),
  ADD COLUMN attempt_model TEXT CHECK (attempt_model <> ''),
  ADD COLUMN attempt_cell TEXT CHECK (attempt_cell IN ('base-cell', 'environment')),
  ADD CONSTRAINT dev_sessions_attempt_whole CHECK (
    num_nulls(attempt_prompt_digest, attempt_terminal, attempt_turns, attempt_provider, attempt_model, attempt_cell)
      IN (0, 6)
  ),
  ADD CONSTRAINT dev_sessions_attempt_cell_version CHECK (
    attempt_cell IS NULL OR (attempt_cell = 'environment') = (environment_version IS NOT NULL)
  );
