-- Migration 048: no work item waits on a person (story s-loop-never-stop-m1, task
-- t-w6-no-item-waits; ADR-074 addendum 2 d76, d82 W6).
--
-- Before this migration a task could be parked at Blocked with an exit only an operator took
-- (PATCH /work-items/:id/status to Pending), and the Liaison told the client so, once per block.
-- Now every cause routes without a person: an infrastructure fault requeues the task uncharged
-- within a fault budget and then halts the project as 'infrastructure', which resumes by itself
-- once the substrate probe passes; every other cause gives the task up (Abandoned), and the plan
-- is repaired around it, at most twice before the project halts as undeliverable (plan_repair).

-- Every task given up opens a plan repair, whatever its cause: the failure router's attempt bound
-- (migration 045), and now a dispute or review bound, the environment-change bound, stale checks
-- that cannot be rewritten, an unsatisfiable dependency, an operator's abandonment through the API,
-- or a Blocked row from before this migration that the loop gives up. A task a plan revision
-- superseded is replaced by that revision already: it opens none.
CREATE OR REPLACE FUNCTION plan_repair_on_abandon() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'Abandoned' AND OLD.status <> 'Abandoned' AND NEW.level = 'Task'
     AND NEW.project_id IS NOT NULL AND NEW.blocked_reason->>'source' IS DISTINCT FROM 'superseded' THEN
    INSERT INTO plan_repairs (work_item_id, project_id) VALUES (NEW.id, NEW.project_id)
      ON CONFLICT (work_item_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- A project halted because the machines its work runs on kept failing.
ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure')
  );

-- An infrastructure halt ends by itself: the loop re-probes the substrate each cycle, and the probe
-- that passes ends the episode as 'probe_passed' with what it observed (resume_evidence); the
-- project returns to work and the Liaison reports the resumption once, as after an unblock.
ALTER TABLE project_blocks
  ADD COLUMN resume_evidence TEXT,
  DROP CONSTRAINT project_blocks_end_kind_check,
  ADD CONSTRAINT project_blocks_end_kind_check CHECK (end_kind IN ('unblocked', 'client_stop', 'probe_passed')),
  ADD CONSTRAINT project_blocks_probe_recorded CHECK ((end_kind = 'probe_passed') = (resume_evidence IS NOT NULL)),
  ADD CONSTRAINT project_blocks_probe_ends_infrastructure CHECK (end_kind IS DISTINCT FROM 'probe_passed' OR kind = 'infrastructure'),
  DROP CONSTRAINT project_blocks_resumed_after_unblock,
  ADD CONSTRAINT project_blocks_resumed_after_unblock CHECK (resumed_report_id IS NULL OR end_kind IN ('unblocked', 'probe_passed'));

-- The infrastructure faults observed on a task's dispatches, none of which charged an attempt:
-- the bound of the task's uncharged requeues (orchestrator execution.ts).
ALTER TABLE work_items
  ADD COLUMN infrastructure_faults INTEGER NOT NULL DEFAULT 0 CHECK (infrastructure_faults >= 0);

-- An operator's unblock was written on the Pending item for its next attempt's brief; that source
-- is gone with the unblock. An item that still carries one (a Pending one not dispatched since, or
-- one that completed after it) keeps the note as replan context, which a next brief shows as the
-- prior attempt's account.
UPDATE work_items
  SET blocked_reason = jsonb_build_object(
    'source', 'replan',
    'replanContext', jsonb_build_object(
      'attempt', dispatch_count,
      'detail', 'An operator returned this task to work after a block. Their note: ' || COALESCE(blocked_reason->>'note', '(none)'),
      'raw', blocked_reason))
  WHERE blocked_reason->>'source' = 'operator_unblock';

-- The Liaison's per-task block report is gone: a Blocked task now waits only on an exit the loop
-- takes by itself, and the client hears about the project, not the task.
DROP TABLE blocked_task_reports;
DROP TRIGGER work_items_blocked_at ON work_items;
DROP FUNCTION work_item_blocked_at();
ALTER TABLE work_items DROP COLUMN blocked_at;
