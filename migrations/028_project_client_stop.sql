-- Migration 028: the client stops a project (story s-client-channel-m1).
--
-- The web client posts an inbound 'stop' (migration 016) and promises that it
-- halts work on the project. The Liaison consumes it and moves the project to
-- 'stopped', a third status distinct from 'blocked': blocked is Ashara's failure
-- (planning gave up, a bad record), recorded with its cause and a candidate for
-- an operator's repair; stopped is the client's decision, and nothing on Ashara's
-- side resumes it. Every reader that gates, plans, takes in or reports admits
-- only 'active', so a stopped project is skipped by all of them.
--
-- A blocked project the client then stops keeps the record of why it was
-- blocked (blocked cause, plan_stopped_at): the client's decision does not erase
-- Ashara's failure.

ALTER TABLE projects
  DROP CONSTRAINT projects_status_known,
  ADD CONSTRAINT projects_status_known CHECK (status IN ('active', 'blocked', 'stopped')),
  DROP CONSTRAINT projects_plan_stopped_blocks,
  ADD CONSTRAINT projects_plan_stopped_blocks CHECK (plan_stopped_at IS NULL OR status IN ('blocked', 'stopped')),
  DROP CONSTRAINT projects_blocked_cause_blocks,
  ADD CONSTRAINT projects_blocked_cause_blocks CHECK (blocked_reason IS NULL OR status IN ('blocked', 'stopped'));

-- The Liaison's one report on the client's stop. The unique index on
-- (project_id, reports_on) from migration 020 makes it one per project, so a
-- second stop, or a retried consumption, cannot tell the client twice.
ALTER TABLE client_messages
  DROP CONSTRAINT client_messages_reports_on_known,
  ADD CONSTRAINT client_messages_reports_on_known CHECK (
    reports_on IS NULL
    OR (direction = 'outbound' AND kind = 'report' AND reports_on IN ('first-plan', 'planning-stopped', 'client-stop'))
  );
