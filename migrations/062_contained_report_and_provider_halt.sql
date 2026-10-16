-- Migration 062: a delivered report that fails is that project's failure, and a plan revision whose
-- provider failed is not the model's.
--
-- acceptance_sweeps.report_failures, report_last_error, report_retry_at: a delivered report that
-- cannot be written (its records unreadable, its product's public interface file unreadable on
-- main, its post failing) is recorded on its sweep, with its error and when it is tried again,
-- instead of failing the loop's cycle for every project. A sweep whose report_retry_at is in the
-- future is not listed as due. report_interface_read_failures counts the failed reads of the public
-- interface file alone: past its bound the report is posted without the quote, whatever else failed.
--
-- replan_provider_failed: a plan revision whose every attempt failed, the last because the planning
-- model's provider failed the request (an HTTP error status, or no answer), so no answer was read.
-- replan_stopped is kept for a revision whose model answered and never validated; a revision
-- exhausted by any other error is still 'fault'. Existing rows keep the kind they were written with.

ALTER TABLE acceptance_sweeps
  ADD COLUMN report_failures integer NOT NULL DEFAULT 0 CHECK (report_failures >= 0),
  ADD COLUMN report_interface_read_failures integer NOT NULL DEFAULT 0 CHECK (report_interface_read_failures >= 0),
  ADD COLUMN report_last_error text,
  ADD COLUMN report_retry_at timestamptz;

ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed')
  );
