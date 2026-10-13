-- Migration 040: every Blocked state has a stated exit, and the client hears about it
-- (story s-loop-never-stop-m1, tasks t-blocked-project-reported, t-blocked-exits-review).
--
-- A project's block (migration 025) recorded only a cause on the row: the client was
-- told nothing and there was no transition out of 'blocked'. A blocked work item was
-- likewise never reported. This migration records each block as an episode, so the
-- Liaison reports each one once and an operator's unblock is recorded with who and why.
--
-- projects.blocked_category: what kind of cause blocked the project, in the closed
-- vocabulary the Liaison's plain report is chosen by. Written with the cause.

ALTER TABLE projects
  ADD COLUMN blocked_category TEXT;

-- Backfill: a project blocked by the per-project spend cap recorded the refusal's class,
-- BudgetExceeded (finance spend-cap.ts); one blocked because its check disputes passed their
-- bound (migration 039) recorded CheckDisputeBoundReached (engagement block-report.ts); any
-- other recorded cause is Ashara's own fault or its configuration, and is reported as a
-- fault, the conservative reading.
UPDATE projects
  SET blocked_category = CASE blocked_error_class
    WHEN 'BudgetExceeded' THEN 'budget_cap'
    WHEN 'CheckDisputeBoundReached' THEN 'check_dispute'
    ELSE 'fault' END
  WHERE blocked_error_class IS NOT NULL;

ALTER TABLE projects
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute')
  ),
  -- The category is recorded with the cause, and only with it.
  ADD CONSTRAINT projects_blocked_category_with_cause CHECK ((blocked_category IS NULL) = (blocked_error_class IS NULL));

-- One row per time a project entered 'blocked'. `kind` is the cause's category, or
-- 'planning_stopped' for a block that first planning giving up wrote. Ended when the
-- project leaves 'blocked': by an operator's unblock (who and why recorded) or by the
-- client's stop. `report_id` / `resumed_report_id` are the Liaison's one report on the
-- block and, after an unblock, its one report that work resumed. A report message that is
-- deleted was never read: its reference clears and the report is due again. The episodes of a
-- deleted project go with it.
CREATE TABLE project_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute')),
  error_class TEXT,
  reason TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report_id UUID UNIQUE REFERENCES client_messages(id) ON DELETE SET NULL,
  ended_at TIMESTAMPTZ,
  end_kind TEXT CHECK (end_kind IN ('unblocked', 'client_stop')),
  unblocked_by TEXT,
  unblock_reason TEXT,
  resumed_report_id UUID UNIQUE REFERENCES client_messages(id) ON DELETE SET NULL,
  CONSTRAINT project_blocks_end_whole CHECK ((ended_at IS NULL) = (end_kind IS NULL)),
  CONSTRAINT project_blocks_unblock_recorded CHECK (
    (end_kind = 'unblocked') = (unblocked_by IS NOT NULL AND unblock_reason IS NOT NULL)
    OR (end_kind IS NULL AND unblocked_by IS NULL AND unblock_reason IS NULL)
  ),
  CONSTRAINT project_blocks_resumed_after_unblock CHECK (resumed_report_id IS NULL OR end_kind = 'unblocked')
);

-- A project is in at most one open block.
CREATE UNIQUE INDEX project_blocks_one_open ON project_blocks (project_id) WHERE ended_at IS NULL;

-- Every writer of projects.status opens and ends episodes the same way: ProjectRepository.block,
-- first planning giving up, the client's stop, the operator's unblock. A project leaving
-- 'blocked' for 'active' must have had its episode ended by the unblock, with who and why,
-- in the same transaction: any other way back to work is refused here.
CREATE FUNCTION project_block_episode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'blocked' AND OLD.status IS DISTINCT FROM 'blocked' THEN
    INSERT INTO project_blocks (project_id, kind, error_class, reason)
    VALUES (
      NEW.id,
      CASE WHEN NEW.plan_stopped_at IS NOT NULL AND OLD.plan_stopped_at IS NULL THEN 'planning_stopped' ELSE NEW.blocked_category END,
      NEW.blocked_error_class,
      COALESCE(NEW.blocked_reason, NEW.plan_last_error)
    );
  ELSIF OLD.status = 'blocked' AND NEW.status <> 'blocked' THEN
    IF NEW.status = 'stopped' THEN
      UPDATE project_blocks SET ended_at = now(), end_kind = 'client_stop'
        WHERE project_id = NEW.id AND ended_at IS NULL;
    ELSIF EXISTS (SELECT 1 FROM project_blocks WHERE project_id = NEW.id AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'project % left blocked for % with its block episode still open: only a recorded unblock returns a project to work', NEW.id, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_block_episode
  AFTER UPDATE OF status ON projects
  FOR EACH ROW EXECUTE FUNCTION project_block_episode();

-- Projects blocked before this migration: one open episode each. A block first planning
-- wrote is dated by plan_stopped_at, so the planning-stopped report (posted after it) stays
-- that block's one report. Any other block's time was not recorded: the migration's time.
INSERT INTO project_blocks (project_id, kind, error_class, reason, blocked_at)
SELECT id,
       CASE WHEN plan_stopped_at IS NOT NULL THEN 'planning_stopped' ELSE blocked_category END,
       blocked_error_class,
       COALESCE(blocked_reason, plan_last_error),
       COALESCE(plan_stopped_at, now())
  FROM projects
  WHERE status = 'blocked';

-- A dispute-bound block written before this migration posted its own report in the same
-- transaction (migration 039's code): that report is the episode's one report, so it is not
-- told twice. Its opening sentence is the only mark it carries.
UPDATE project_blocks b
  SET report_id = (
    SELECT m.id FROM client_messages m
     WHERE m.project_id = b.project_id AND m.direction = 'outbound' AND m.kind = 'report'
       AND m.body LIKE 'Work on this project is paused. While building %'
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 1)
  WHERE b.kind = 'check_dispute' AND b.ended_at IS NULL AND b.report_id IS NULL;

-- work_items.blocked_at: when the item last entered Blocked, NULL while it is not Blocked.
-- Kept by a trigger, so every writer of status keeps it: it is the key of the Liaison's one
-- report per time a task is blocked.
ALTER TABLE work_items
  ADD COLUMN blocked_at TIMESTAMPTZ;

-- Items Blocked before this migration: their last write is the best record of when. This
-- runs before the trigger below exists: that trigger keeps OLD.blocked_at on a Blocked ->
-- Blocked update, which would overwrite this backfill with NULL.
UPDATE work_items SET blocked_at = updated_at WHERE status = 'Blocked';

CREATE FUNCTION work_item_blocked_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'Blocked' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'Blocked' THEN
      NEW.blocked_at := clock_timestamp();
    ELSE
      NEW.blocked_at := OLD.blocked_at;
    END IF;
  ELSE
    NEW.blocked_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_items_blocked_at
  BEFORE INSERT OR UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_item_blocked_at();


-- The Liaison's one report per time a task was blocked.
CREATE TABLE blocked_task_reports (
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  blocked_at TIMESTAMPTZ NOT NULL,
  report_id UUID NOT NULL UNIQUE REFERENCES client_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (work_item_id, blocked_at)
);

-- owner_unresolved now records the roster revision it was decided against (the exit is a
-- newer revision). One stored before records none it can know: null, so any stored roster
-- revision re-checks it once.
UPDATE work_items
  SET blocked_reason = blocked_reason || '{"rosterRevision": null}'::jsonb
  WHERE blocked_reason->>'source' = 'owner_unresolved' AND NOT (blocked_reason ? 'rosterRevision');
