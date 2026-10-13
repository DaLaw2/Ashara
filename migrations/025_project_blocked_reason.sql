-- Migration 025: why a project is blocked (story s-loop-never-stop-m1).
--
-- One project's bad record (a first plan the Liaison cannot report truthfully, a
-- work_items jsonb value that does not parse, an attempt cap with no error on
-- record) used to throw out of the whole loop cycle, so every other project
-- stopped with it. Such a failure now blocks only that project, and the error's
-- class and full chain are recorded on the project's own row, so the cause
-- survives a restart and an operator can read it.
--
-- plan_last_error stays the record of a failed planning attempt: it is bounded by
-- plan_attempts and read by the first-plan step, and a bad record is not a
-- planning attempt.

ALTER TABLE projects
  ADD COLUMN blocked_error_class TEXT,
  ADD COLUMN blocked_reason TEXT;

-- Migration 020's CHECK makes a stopped project blocked, not a blocked project
-- stopped, so a blocked row with no planning outcome may already exist. Its cause
-- was never recorded; say so rather than invent one.
UPDATE projects
  SET blocked_error_class = 'Unrecorded',
      blocked_reason = 'blocked before migration 025; the cause was not recorded'
  WHERE status = 'blocked' AND plan_stopped_at IS NULL;

ALTER TABLE projects
  -- The class and the reason are recorded together.
  ADD CONSTRAINT projects_blocked_cause_whole CHECK ((blocked_error_class IS NULL) = (blocked_reason IS NULL)),
  -- A cause is only ever recorded on a blocked project.
  ADD CONSTRAINT projects_blocked_cause_blocks CHECK (blocked_reason IS NULL OR status = 'blocked'),
  -- Every blocked project says why: a recorded cause, or planning stopped (migration 020).
  ADD CONSTRAINT projects_blocked_has_cause CHECK (
    status <> 'blocked' OR blocked_reason IS NOT NULL OR plan_stopped_at IS NOT NULL
  );
