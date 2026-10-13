-- Migration 039: an implementer's disputes of its task's checks (story
-- s-independent-verify-m1, task t-check-dispute; ADR-074 addendum 2 d65 c).
-- Quality's table.
--
-- An implementer that holds a stored check cannot pass on correct work ends its
-- attempt with dispute_check. Each dispute is one row, naming the check task that
-- wrote the check, the revision and the check, the implementer's reason and its
-- evidence (the output of its last run of the checks, NULL when it never ran
-- them). The rows of one check task bound how often it is reopened to answer a
-- dispute: past the bound the project is blocked for its owner. The count must
-- survive a restart, so it is this table, never process memory. Append-only: an
-- UPDATE is refused by a trigger. DELETE is not refused: nothing in Ashara
-- deletes a dispute, and a test suite removes the projects it created.

CREATE TABLE check_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID NOT NULL REFERENCES work_items(id),
  check_task_id UUID NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  check_name TEXT NOT NULL CHECK (btrim(check_name) <> ''),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_disputes_not_self CHECK (task_id <> check_task_id)
);

CREATE INDEX check_disputes_check_task ON check_disputes (check_task_id);

CREATE OR REPLACE FUNCTION check_disputes_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'check_disputes is append-only (dispute % of check task %)', OLD.id, OLD.check_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_disputes_append_only
  BEFORE UPDATE ON check_disputes
  FOR EACH ROW EXECUTE FUNCTION check_disputes_refuse_update();
