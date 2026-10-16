-- Migration 063: a suite review's judgements are kept whole, one subject's failure in a step of the
-- loop's cycle is that subject's, and only a delivered report's unreadable records count toward its
-- substitute notice.
--
-- suite_review_judgements (Quality): one row per outside-vision rejection a review of a plan
-- revision's suites made that Z0 could not disprove, written before the review's outcome is acted
-- on: whether it was routed (the second review rejected the same check too) or released (it did
-- not), the first review's finding whole, every finding the second review made on that check task
-- whole, and both reviews' models with what the second was: another model, or a re-sample of the
-- first's. Append-only.
--
-- step_faults: a subject of a cycle step (a tender, an answer, a project, a report) whose run failed
-- is recorded here with how many faults in a row, the last error, and when it is tried again,
-- instead of failing the loop's cycle for every project. A subject whose retry_at is in the future
-- is skipped by its step; one that runs through has its row deleted. These faults never count
-- against the client's input or the work. A subject that exhausted its faults halted its project
-- and is parked (parked_at): skipped while its project is not at work, so a subject of a project
-- already halted, stopped or accepted stops retrying, and an owner's unblock returns it.
--
-- model_failed, provider_failed: a halt is blamed on whose failure its cause was, read by the one
-- classifier of a failed model call: model_failed when the model's structured answer never
-- validated or was unfit to act on, provider_failed when the model's provider failed the request so
-- no answer was read. 'fault' stays Ashara's own. replan_stopped and replan_provider_failed are kept
-- for an exhausted plan revision. Existing rows keep the kind they were written with.
--
-- acceptance_sweeps.report_record_failures: the failed attempts at a delivered report whose
-- records are on file but do not read as a report; only these count toward the acceptance notice
-- sent in its place. A report whose records could not be reached (a lost connection) is retried
-- under report_failures and its backoff, never counted here.

CREATE TABLE suite_review_judgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  check_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL CHECK (length(check_name) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('routed', 'released')),
  first_finding JSONB NOT NULL CHECK (jsonb_typeof(first_finding) = 'object'),
  second_findings JSONB NOT NULL CHECK (jsonb_typeof(second_findings) = 'array'),
  first_model TEXT NOT NULL CHECK (length(first_model) > 0),
  second_model TEXT NOT NULL CHECK (length(second_model) > 0),
  second_review TEXT NOT NULL CHECK (second_review IN ('other-model', 're-sample')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suite_review_judgements_routed_has_second CHECK (outcome = 'released' OR jsonb_array_length(second_findings) >= 1),
  CONSTRAINT suite_review_judgements_resample_same_model CHECK ((second_review = 're-sample') = (first_model = second_model))
);

CREATE INDEX suite_review_judgements_review_task ON suite_review_judgements (review_task_id, created_at);

CREATE OR REPLACE FUNCTION suite_review_judgements_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_judgements is append-only (judgement % of review task %)', OLD.id, OLD.review_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER suite_review_judgements_append_only
  BEFORE UPDATE ON suite_review_judgements
  FOR EACH ROW EXECUTE FUNCTION suite_review_judgements_refuse_update();

CREATE TABLE step_faults (
  step TEXT NOT NULL CHECK (length(step) > 0),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  faults INTEGER NOT NULL CHECK (faults > 0),
  last_error TEXT NOT NULL,
  retry_at TIMESTAMPTZ NOT NULL,
  parked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (step, subject_id)
);

ALTER TABLE acceptance_sweeps
  ADD COLUMN report_record_failures INTEGER NOT NULL DEFAULT 0 CHECK (report_record_failures >= 0);

ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed', 'model_failed', 'provider_failed')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed', 'model_failed', 'provider_failed')
  );
