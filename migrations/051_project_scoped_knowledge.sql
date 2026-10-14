-- Migration 051: knowledge and lessons belong to one project (ADR-074 d92 a, task
-- t-d92-project-scoped-knowledge).
--
-- Before this migration knowledge_entries and failed_approaches carried no project, and their
-- readers matched every row with epic_id IS NULL, so a task in one project was briefed with
-- another project's findings and failed approaches once two projects shared one database.
-- Each row now names its project; every writer supplies it and every reader filters by it.
--
-- An existing row takes the project of the task that produced it (knowledge_entries.source_task_id,
-- failed_approaches.task_id). A row with no such task has no evidence of its project: it is
-- deleted, never assigned a guessed one, and the count is printed.
--
-- The 'Task completed: ... Files changed: ...' insights duplicated git (lessons-digest
-- 2026-10-14 H3); nothing writes them after this migration, and the existing ones are deleted.

DO $$
DECLARE
  completed_notes INTEGER;
  orphan_knowledge INTEGER;
  orphan_approaches INTEGER;
  cross_edges INTEGER;
BEGIN
  DELETE FROM knowledge_entries WHERE kind = 'insight' AND content LIKE 'Task completed: %';
  GET DIAGNOSTICS completed_notes = ROW_COUNT;
  RAISE NOTICE 'migration 051: % task-completed insight(s) deleted (they duplicated git)', completed_notes;

  ALTER TABLE knowledge_entries ADD COLUMN project_id UUID REFERENCES projects(id);
  UPDATE knowledge_entries k SET project_id = w.project_id FROM work_items w WHERE w.id = k.source_task_id;
  DELETE FROM knowledge_entries WHERE project_id IS NULL;
  GET DIAGNOSTICS orphan_knowledge = ROW_COUNT;
  RAISE NOTICE 'migration 051: % knowledge_entries row(s) deleted, no source task names their project', orphan_knowledge;
  ALTER TABLE knowledge_entries ALTER COLUMN project_id SET NOT NULL;

  ALTER TABLE failed_approaches ADD COLUMN project_id UUID REFERENCES projects(id);
  UPDATE failed_approaches f SET project_id = w.project_id FROM work_items w WHERE w.id = f.task_id;
  DELETE FROM failed_approaches WHERE project_id IS NULL;
  GET DIAGNOSTICS orphan_approaches = ROW_COUNT;
  RAISE NOTICE 'migration 051: % failed_approaches row(s) deleted, no task names their project', orphan_approaches;
  ALTER TABLE failed_approaches ALTER COLUMN project_id SET NOT NULL;

  -- A dependency edge whose two items are in different projects lets one project's plan wait on
  -- another's. No writer means to create one; such an edge is deleted and from now on refused.
  DELETE FROM dependencies d USING work_items a, work_items b
   WHERE a.id = d.from_id AND b.id = d.to_id AND a.project_id <> b.project_id;
  GET DIAGNOSTICS cross_edges = ROW_COUNT;
  RAISE NOTICE 'migration 051: % cross-project dependency edge(s) deleted', cross_edges;
END
$$;

CREATE INDEX idx_knowledge_project ON knowledge_entries(project_id);
CREATE INDEX idx_failed_approaches_project ON failed_approaches(project_id);

CREATE FUNCTION dependency_same_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  from_project UUID;
  to_project UUID;
BEGIN
  SELECT project_id INTO from_project FROM work_items WHERE id = NEW.from_id;
  SELECT project_id INTO to_project FROM work_items WHERE id = NEW.to_id;
  IF from_project IS DISTINCT FROM to_project THEN
    RAISE EXCEPTION 'dependency % -> % crosses projects (% -> %)', NEW.from_id, NEW.to_id, from_project, to_project;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dependencies_same_project
  BEFORE INSERT OR UPDATE OF from_id, to_id ON dependencies
  FOR EACH ROW EXECUTE FUNCTION dependency_same_project();
