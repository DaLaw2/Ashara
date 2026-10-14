-- Migration 044: the review of a plan revision's check suites (story s-independent-verify-m1,
-- task t-run5-review-trace; ADR-074 addendum 2 d71 c; evidence
-- docs/investigations/fifth-run-2026-10-14.md N20). Quality's table.
--
-- After every check task of a plan revision completes and before any implementation starts,
-- a review task reads every stored suite together with the vision. When it finds problems
-- (checks no product can pass together, or checks of behaviour no vision item asks for),
-- each check task it names is reopened with the problems in its brief. Each review that names
-- a check task is one row per named check task, with the problems that name it. The rows of
-- one check task bound how often it is reopened for a review: past the bound the project is
-- blocked for its owner. The count must survive a restart, so it is this table, never process
-- memory. Append-only, as check_disputes is.

CREATE TABLE suite_review_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  review_task_id UUID NOT NULL REFERENCES work_items(id),
  check_task_id UUID NOT NULL REFERENCES work_items(id),
  problems JSONB NOT NULL CHECK (jsonb_typeof(problems) = 'array' AND jsonb_array_length(problems) >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suite_review_findings_not_self CHECK (review_task_id <> check_task_id)
);

CREATE INDEX suite_review_findings_check_task ON suite_review_findings (check_task_id);
CREATE INDEX suite_review_findings_project ON suite_review_findings (project_id, created_at);

CREATE OR REPLACE FUNCTION suite_review_findings_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_findings is append-only (finding % of check task %)', OLD.id, OLD.check_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER suite_review_findings_append_only
  BEFORE UPDATE ON suite_review_findings
  FOR EACH ROW EXECUTE FUNCTION suite_review_findings_refuse_update();

-- A project whose review named one check task past the bound is blocked as 'suite_review',
-- which the Liaison's plain report is chosen by.
ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review')
  );
