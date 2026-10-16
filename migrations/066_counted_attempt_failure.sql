-- Migration 066: a step whose counted attempts ran out halts under whose failure its last attempt
-- was, read from the record, so the halt is the same after a restart or an unblock as in the cycle
-- that counted it.
--
-- client_messages.intake_last_failure: whose failure the last counted attempt to read an answer
-- was, 'model' (its structured answer never validated or was unfit) or 'provider' (the provider
-- failed the request). Only an answer's reading counts a failure that halts a project; a tender's
-- failed intake closes the tender and keeps none.
--
-- projects.replan_last_failure: the same for the last counted attempt to revise the plan; reset
-- together with replan_attempts by a written revision and by the operator's unblock.
--
-- A row counted before this migration has no failure recorded: an exhaustion read from it names no
-- party and halts as Ashara's own ('fault'), never as the model's or the provider's.

ALTER TABLE client_messages
  ADD COLUMN intake_last_failure text,
  ADD CONSTRAINT client_messages_intake_last_failure_known CHECK (
    intake_last_failure IS NULL OR (intake_last_failure IN ('model', 'provider') AND kind = 'answer' AND intake_attempts > 0)
  );

ALTER TABLE projects
  ADD COLUMN replan_last_failure text,
  ADD CONSTRAINT projects_replan_last_failure_known CHECK (
    replan_last_failure IS NULL OR (replan_last_failure IN ('model', 'provider') AND replan_attempts > 0)
  );
