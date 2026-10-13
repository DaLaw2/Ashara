-- Migration 020: the first plan of a project (story s-liaison-intake-m1, Delivery per
-- ADR-075), and the Liaison's report on it (Engagement).
--
-- Delivery decomposes a project's vision into its first Epic -> Task plan on the
-- server. Each failed attempt is counted on the project's own row with the error
-- that ended it, so the count survives a restart. The plan transaction stamps
-- first_planned_at; giving up stamps plan_stopped_at and blocks the project.
-- Either stamp is what makes a report to the client due.
--
-- projects.status had no constraint and every writer left it at its default
-- 'active'; 'blocked' is the second value, set only together with plan_stopped_at.

ALTER TABLE projects
  ADD COLUMN plan_attempts INTEGER NOT NULL DEFAULT 0 CHECK (plan_attempts >= 0),
  ADD COLUMN plan_last_error TEXT,
  ADD COLUMN first_planned_at TIMESTAMPTZ,
  ADD COLUMN plan_stopped_at TIMESTAMPTZ;

ALTER TABLE projects
  ADD CONSTRAINT projects_status_known CHECK (status IN ('active', 'blocked')),
  -- A counted attempt always carries its error.
  ADD CONSTRAINT projects_plan_error_recorded CHECK (plan_attempts = 0 OR plan_last_error IS NOT NULL),
  -- A project is planned or stopped, never both; a stopped one is blocked.
  ADD CONSTRAINT projects_plan_outcome_single CHECK (first_planned_at IS NULL OR plan_stopped_at IS NULL),
  ADD CONSTRAINT projects_plan_stopped_blocks CHECK (plan_stopped_at IS NULL OR status = 'blocked');

-- What an outbound report reports on, when it reports on a planning outcome. The
-- unique index makes "one report per outcome" a property of the table, so a
-- retried or concurrent post cannot tell the client twice.
ALTER TABLE client_messages
  ADD COLUMN reports_on VARCHAR(20),
  ADD CONSTRAINT client_messages_reports_on_known CHECK (
    reports_on IS NULL
    OR (direction = 'outbound' AND kind = 'report' AND reports_on IN ('first-plan', 'planning-stopped'))
  );

CREATE UNIQUE INDEX client_messages_one_report_per_outcome
  ON client_messages (project_id, reports_on)
  WHERE reports_on IS NOT NULL;
