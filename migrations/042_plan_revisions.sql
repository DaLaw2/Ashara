-- Migration 042: a late client change is planned (story s-liaison-intake-m1, task
-- t-replan-on-change).
--
-- Migration 038 flagged a project whose planned work relied on an assumption the client's
-- answer changed (projects.replan_requested_by) and stopped its dispatch, with nothing that
-- cleared the flag. Delivery now revises the plan once no task of the project is in
-- progress: a new revision from the current vision supersedes the open work, keeps the
-- completed work, and clears the flag in the same transaction. The Liaison reports each
-- revision once.
--
-- plan_revisions: one row per revision after the first plan (the first plan is revision 1
-- and is stamped on projects.first_planned_at). `requested_by` is the answer whose flag the
-- revision cleared; `summary` is what the revision did, recorded when it was written, which
-- the Liaison's report is composed from; `report_id` is that report.

CREATE TABLE plan_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 2),
  vision_version INTEGER NOT NULL,
  requested_by UUID NOT NULL REFERENCES client_messages(id) ON DELETE CASCADE,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report_id UUID UNIQUE REFERENCES client_messages(id) ON DELETE SET NULL,
  CONSTRAINT plan_revisions_one_per_number UNIQUE (project_id, revision)
);

-- Failed attempts to revise the plan for the current request, with the last error; reset
-- by a written revision and by the operator's unblock.
ALTER TABLE projects
  ADD COLUMN replan_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN replan_last_error TEXT,
  ADD CONSTRAINT projects_replan_failure_recorded CHECK (replan_attempts = 0 OR replan_last_error IS NOT NULL);

-- A project whose plan was revised its bound of times since the operator last reviewed it is
-- blocked as 'replan_bound', which the Liaison's plain report is chosen by.
ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound')
  );
