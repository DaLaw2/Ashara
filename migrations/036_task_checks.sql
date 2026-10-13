-- Migration 036: the checks that decide whether an implementation task is done
-- (story s-independent-verify-m1, task t-verify-checks-from-plan; ADR-074
-- addendum 2 d63). Quality's table.
--
-- The check author writes them in the implementation task's check task, before
-- the implementation starts. Z0 keeps each check only after it failed on the
-- target's main (the red-run rule), and verifies the implementation task by
-- running them on its tentative merge. Nothing of a check task is merged.
--
-- One row per check. A check task that runs again appends a new revision; the
-- implementation task is verified by the rows of its latest revision. files is
-- every file the check task's attempt added or changed, as
-- [{"path": ..., "content": ...}], the same set on each row of a revision; Z0
-- writes them into the checkout the checks run in. environment_version is the
-- environment version the checks were red-run on. The table is append-only: an
-- UPDATE is refused by a trigger. DELETE is not refused: nothing in Ashara
-- deletes a check, and a test suite removes the projects it created.

CREATE TABLE task_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID NOT NULL REFERENCES work_items(id),
  check_task_id UUID NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  command TEXT NOT NULL CHECK (btrim(command) <> ''),
  files JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  environment_version TEXT NOT NULL CHECK (environment_version ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_checks_unique_name UNIQUE (task_id, revision, name),
  CONSTRAINT task_checks_not_self CHECK (task_id <> check_task_id)
);

CREATE INDEX task_checks_task_revision ON task_checks (task_id, revision);

CREATE OR REPLACE FUNCTION task_checks_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'task_checks is append-only: changed checks are a new revision (task %, revision %, check %)',
    OLD.task_id, OLD.revision, OLD.name;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_checks_append_only
  BEFORE UPDATE ON task_checks
  FOR EACH ROW EXECUTE FUNCTION task_checks_refuse_update();
