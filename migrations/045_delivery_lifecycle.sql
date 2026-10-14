-- Migration 045: a fixed red-run baseline, and a plan repair after an abandonment (story
-- s-independent-verify-m1, task t-delivery-lifecycle; ADR-074 addendum 2 d74;
-- docs/investigations/operator-blocks-root-cause-2026-10-14.md).
--
-- task_checks.baseline_commit: the commit a revision's checks were red-run on, the plan
-- revision's foundation (the product scaffold's recorded merge, work_items.merge_commit of
-- migration 041; for a revision with no scaffold of its own, its environment task's merge).
-- Rows written before this migration were red-run on main as it was then, a commit nothing
-- recorded: they stay NULL, and a check of theirs that must be red-run again is written again.

ALTER TABLE task_checks
  ADD COLUMN baseline_commit TEXT;

ALTER TABLE task_checks
  ADD CONSTRAINT task_checks_baseline_commit_shape CHECK (
    baseline_commit IS NULL OR baseline_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  );

-- A plan revision is asked for by a client's answer (migration 042) or by a plan repair: the
-- failure router gave up a task, and Delivery re-plans the remaining work around it instead of
-- parking every task that depends on it for the operator.
ALTER TABLE plan_revisions
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'client_change' CHECK (kind IN ('client_change', 'repair')),
  ADD CONSTRAINT plan_revisions_cause_recorded CHECK ((kind = 'client_change') = (requested_by IS NOT NULL));

-- One row per task the failure router abandoned, written by the abandonment itself (the trigger
-- below), in the same statement: no abandonment is missed and none is invented. A row with no
-- plan_revision_id is a repair the project awaits; the revision that re-planned around it is
-- recorded on it. A task abandoned before this migration has no row: its project is not
-- re-planned on its account.
CREATE TABLE plan_repairs (
  work_item_id UUID PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision_id UUID REFERENCES plan_revisions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plan_repairs_pending ON plan_repairs (project_id) WHERE plan_revision_id IS NULL;

CREATE FUNCTION plan_repair_on_abandon() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'Abandoned' AND OLD.status <> 'Abandoned' AND NEW.level = 'Task'
     AND NEW.project_id IS NOT NULL AND NEW.blocked_reason->>'source' = 'failure_router' THEN
    INSERT INTO plan_repairs (work_item_id, project_id) VALUES (NEW.id, NEW.project_id)
      ON CONFLICT (work_item_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_items_plan_repair
  AFTER UPDATE OF status ON work_items
  FOR EACH ROW EXECUTE FUNCTION plan_repair_on_abandon();

-- A project whose plan was repaired its bound of times since the operator last reviewed it is
-- blocked as 'plan_repair', with one report naming the task given up.
ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair')
  );
