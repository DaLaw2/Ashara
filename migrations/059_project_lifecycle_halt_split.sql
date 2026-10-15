-- Migration 059: a project's engagement lifecycle and its halt are separate records, each written
-- by its one owner (O3 c, ADR-080 d3 (d)).
--
-- projects.status held four values for two owners: Engagement's lifecycle (active, stopped,
-- accepted) and Delivery's halt (blocked). The halt is already recorded whole in project_blocks
-- (migration 040): a project is halted exactly while it has an open episode, and that row carries
-- the halt's kind, cause, report and end. So the halt is read from the open episode and from nothing
-- else; a halt column beside it would be a second copy of one fact, kept equal only by a trigger.
-- projects.status becomes projects.lifecycle and holds Engagement's three states only.
--
-- Every blocked project's lifecycle is 'active'. Derived from the record: a halt is entered only
-- from 'active' (Delivery's halt guard; migration 049's trigger lets 'accepted' leave only for
-- 'stopped'), and the client's stop moves a blocked project to 'stopped' and ends its episode in the
-- same write, so no stopped project is blocked. The record is checked against that first: a blocked
-- project with a passed acceptance sweep or a client-stop report, a blocked project with no open
-- episode, or an open episode on a project not blocked aborts the migration instead of being guessed.
--
-- projects.blocked_category, blocked_error_class, blocked_reason and plan_stopped_at stay Delivery's
-- record of the current halt's cause, written only by its halt guard. Their CHECKs that named
-- 'blocked' cannot name another table, so a deferred constraint trigger holds them to the episode.

DO $$
DECLARE
  offending UUID;
BEGIN
  SELECT p.id INTO offending FROM projects p
   WHERE p.status = 'blocked'
     AND (EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.project_id = p.id AND s.passed)
          OR EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = p.id AND m.reports_on = 'client-stop'))
   LIMIT 1;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'project % is blocked yet its record shows it accepted or stopped: its lifecycle cannot be derived', offending;
  END IF;

  SELECT p.id INTO offending FROM projects p
   WHERE (p.status = 'blocked') <> EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = p.id AND b.ended_at IS NULL)
   LIMIT 1;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'project % has a status and an open block episode that disagree: the halt cannot be carried by the episode alone', offending;
  END IF;
END;
$$;

DROP TRIGGER projects_block_episode ON projects;
DROP FUNCTION project_block_episode();
DROP TRIGGER projects_acceptance_guard ON projects;
DROP FUNCTION project_acceptance_guard();

ALTER TABLE projects
  DROP CONSTRAINT projects_status_known,
  DROP CONSTRAINT projects_plan_stopped_blocks,
  DROP CONSTRAINT projects_blocked_cause_blocks,
  DROP CONSTRAINT projects_blocked_has_cause;

UPDATE projects SET status = 'active' WHERE status = 'blocked';

ALTER TABLE projects RENAME COLUMN status TO lifecycle;

ALTER TABLE projects
  ADD CONSTRAINT projects_lifecycle_known CHECK (lifecycle IN ('active', 'stopped', 'accepted')),
  -- A cause is recorded on a halted project, and kept when the client stops it (migration 028).
  ADD CONSTRAINT projects_plan_stopped_lifecycle CHECK (plan_stopped_at IS NULL OR lifecycle IN ('active', 'stopped')),
  ADD CONSTRAINT projects_blocked_cause_lifecycle CHECK (blocked_reason IS NULL OR lifecycle IN ('active', 'stopped'));

-- The halt and the lifecycle agree, checked at commit once both owners' writes of a transaction are
-- in: an open episode only on an active project; an active project's recorded cause (planning
-- stopped, or a blocked cause) only while it is halted; a halted project says why.
CREATE FUNCTION project_halt_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  project RECORD;
  halted BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    target := NEW.id;
  ELSE
    target := NEW.project_id;
  END IF;
  SELECT p.lifecycle, p.plan_stopped_at, p.blocked_error_class INTO project FROM projects p WHERE p.id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  halted := EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = target AND b.ended_at IS NULL);
  IF halted AND project.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'project % is halted while its lifecycle is %: only an active project is halted', target, project.lifecycle;
  END IF;
  IF halted AND project.plan_stopped_at IS NULL AND project.blocked_error_class IS NULL THEN
    RAISE EXCEPTION 'project % is halted with no cause recorded: neither planning stopped nor a blocked cause', target;
  END IF;
  IF NOT halted AND project.lifecycle = 'active' AND (project.plan_stopped_at IS NOT NULL OR project.blocked_error_class IS NOT NULL) THEN
    RAISE EXCEPTION 'project % records a halt''s cause but has no open block episode', target;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER projects_halt_consistent
  AFTER INSERT OR UPDATE ON projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_halt_consistent();

CREATE CONSTRAINT TRIGGER project_blocks_halt_consistent
  AFTER INSERT OR UPDATE ON project_blocks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_halt_consistent();

-- The client's stop ends the halt it finds, as 'client_stop': Engagement writes the lifecycle, and
-- the episode's end follows from it in the same transaction, as it did under migration 040.
CREATE FUNCTION project_stop_ends_halt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'stopped' AND OLD.lifecycle IS DISTINCT FROM 'stopped' THEN
    UPDATE project_blocks SET ended_at = now(), end_kind = 'client_stop'
      WHERE project_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_stop_ends_halt
  AFTER UPDATE OF lifecycle ON projects
  FOR EACH ROW EXECUTE FUNCTION project_stop_ends_halt();

-- Migration 049's rule, on the lifecycle: 'accepted' is entered only with a passed sweep on record,
-- and left only by the client's stop.
CREATE FUNCTION project_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'accepted' AND OLD.lifecycle IS DISTINCT FROM 'accepted'
     AND NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.project_id = NEW.id AND s.passed) THEN
    RAISE EXCEPTION 'project % cannot become accepted: no passed acceptance sweep is recorded for it', NEW.id;
  END IF;
  IF OLD.lifecycle = 'accepted' AND NEW.lifecycle NOT IN ('accepted', 'stopped') THEN
    RAISE EXCEPTION 'project % cannot leave accepted for %: only the client''s stop ends it', NEW.id, NEW.lifecycle;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_acceptance_guard
  BEFORE UPDATE OF lifecycle ON projects
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_guard();
