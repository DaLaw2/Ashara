-- Migration 049: a delivered project is Accepted, and every report states what is on record
-- (story s-independent-verify-m1, task t-w7-honest-reports; ADR-074 addendum 2 d82 W7; design
-- s-independent-verify-m1.md P11, §2.8).
--
-- Before this migration a project whose goal tasks were all done stayed 'active' with nothing
-- left to dispatch, and the client heard nothing after the stack choice (eighth run E3). Now Z0
-- runs one acceptance sweep on main HEAD once every task of the plan is settled and a goal task
-- is done: the environment's test and the latest checks of every completed implementation task,
-- in one CI cell. A sweep that passes makes the project 'accepted' in the same transaction; the
-- Liaison then posts the delivered report once. A sweep that fails is a defect: Z0 opens a work
-- item recording it, given up at once ('acceptance_failed'), and the plan is repaired around it
-- (migration 048's trigger), never accepted.

-- 'accepted': delivered and checked on main. Nothing is dispatched for it (every reader that
-- gates, plans or takes in admits only 'active'); it waits until the client stops it.
ALTER TABLE projects
  DROP CONSTRAINT projects_status_known,
  ADD CONSTRAINT projects_status_known CHECK (status IN ('active', 'blocked', 'stopped', 'accepted'));

-- Acceptance sweeps that could not run, counted per project against the dispatch path's fault
-- budget (INFRASTRUCTURE_FAULT_BUDGET): the fault past it halts the project as undeliverable, so a
-- sweep that keeps failing to run never loops through halts and resumptions. Never reset.
ALTER TABLE projects
  ADD COLUMN acceptance_faults INTEGER NOT NULL DEFAULT 0 CHECK (acceptance_faults >= 0);

-- One row per acceptance sweep Z0 ran on main HEAD, or that faulted within the budget for a cause
-- other than the substrate (a defect, `details` the fault). `checked_tasks` names the
-- implementation tasks whose checks ran (the regression suite), `unchecked_tasks` the completed
-- ones with no stored check, which nothing re-ran; `details` is the run as the verdict states it.
-- A failed sweep records the defect item it opened; a passed one the Liaison's delivered report.
CREATE TABLE acceptance_sweeps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL only on a sweep that faulted before main could be read (never a passed one).
  main_commit TEXT CHECK (main_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- NULL when main defines no environment the sweep's cells could be built from (a failed sweep).
  environment_version TEXT CHECK (environment_version <> ''),
  checked_tasks JSONB NOT NULL CHECK (jsonb_typeof(checked_tasks) = 'array'),
  unchecked_tasks JSONB NOT NULL CHECK (jsonb_typeof(unchecked_tasks) = 'array'),
  passed BOOLEAN NOT NULL,
  details TEXT NOT NULL CHECK (details <> ''),
  defect_item_id UUID UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
  report_id UUID UNIQUE REFERENCES client_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acceptance_sweeps_defect_on_failure CHECK (passed = (defect_item_id IS NULL)),
  CONSTRAINT acceptance_sweeps_pass_has_environment CHECK (NOT passed OR environment_version IS NOT NULL),
  CONSTRAINT acceptance_sweeps_pass_has_main CHECK (NOT passed OR main_commit IS NOT NULL),
  CONSTRAINT acceptance_sweeps_report_on_pass CHECK (report_id IS NULL OR passed)
);

-- A project is accepted once.
CREATE UNIQUE INDEX acceptance_sweeps_one_pass ON acceptance_sweeps (project_id) WHERE passed;

-- 'accepted' is entered only with a passed sweep on record, and left only by the client's stop.
CREATE FUNCTION project_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted'
     AND NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.project_id = NEW.id AND s.passed) THEN
    RAISE EXCEPTION 'project % cannot become accepted: no passed acceptance sweep is recorded for it', NEW.id;
  END IF;
  IF OLD.status = 'accepted' AND NEW.status NOT IN ('accepted', 'stopped') THEN
    RAISE EXCEPTION 'project % cannot leave accepted for %: only the client''s stop ends it', NEW.id, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_acceptance_guard
  BEFORE UPDATE OF status ON projects
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_guard();

-- How a task's recorded commit closed it: 'merged' when Z0's merge made it, 'already_delivered'
-- when the task changed nothing and its checks, the environment's test and the regression suite
-- passed on main at that commit (ADR-074 addendum 2 d67 b). Written with the commit. NULL on a
-- record from before this migration: how it closed was not recorded, and is not inferred.
ALTER TABLE work_items
  ADD COLUMN merge_kind TEXT,
  ADD CONSTRAINT work_items_merge_kind_known CHECK (merge_kind IS NULL OR merge_kind IN ('merged', 'already_delivered')),
  ADD CONSTRAINT work_items_merge_kind_with_commit CHECK (merge_kind IS NULL OR merge_commit IS NOT NULL);
