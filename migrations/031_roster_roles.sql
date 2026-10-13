-- Migration 031: a project's roster and who owns each work item (story
-- s-team-roster-m1, task t-roster-derivation; ADR-075 Organization).
--
-- Organization derives a roster from vision v1 before the first plan. Each role
-- is one row; a roster is the rows of one revision. The table is append-only: a
-- changed roster is a new revision, never an edit, so an UPDATE is refused by a
-- trigger. DELETE is not refused: nothing in Ashara deletes a role, and a test
-- suite removes the projects it created.
--
-- capabilities holds Organization's capability classes (ADR-073 Q11, with the
-- addendum's write-environment); a value outside them is refused here as well as
-- by Organization's parser.

CREATE TABLE roster_roles (
  project_id UUID NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  role_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  responsibility TEXT NOT NULL CHECK (btrim(responsibility) <> ''),
  capabilities TEXT[] NOT NULL CHECK (
    cardinality(capabilities) >= 1
    AND capabilities <@ ARRAY['client-comms', 'write-source', 'author-checks', 'write-environment']::TEXT[]
  ),
  vision_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roster_roles_unique_role UNIQUE (project_id, revision, role_id),
  -- The roster is derived from a vision the project actually has.
  CONSTRAINT roster_roles_vision_exists FOREIGN KEY (project_id, vision_version)
    REFERENCES vision_documents (project_id, version)
);

CREATE UNIQUE INDEX roster_roles_unique_name ON roster_roles (project_id, revision, lower(name));

CREATE OR REPLACE FUNCTION roster_roles_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'roster_roles is append-only: a changed roster is a new revision (project %, revision %, role %)',
    OLD.project_id, OLD.revision, OLD.role_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_roles_append_only
  BEFORE UPDATE ON roster_roles
  FOR EACH ROW EXECUTE FUNCTION roster_roles_refuse_update();

-- Who owns a work item: the kind of work it is and the role holding the
-- capability that kind needs, set when the plan is written. Rows written before
-- this migration have neither; an Epic has neither.
ALTER TABLE work_items
  ADD COLUMN work_kind TEXT,
  ADD COLUMN owner_role_id UUID;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_work_kind_known CHECK (work_kind IN ('environment', 'implementation', 'check')),
  -- The kind and its owner are recorded together, and only on a Task.
  ADD CONSTRAINT work_items_owner_whole CHECK ((work_kind IS NULL) = (owner_role_id IS NULL)),
  ADD CONSTRAINT work_items_owner_on_task CHECK (work_kind IS NULL OR level = 'Task');
