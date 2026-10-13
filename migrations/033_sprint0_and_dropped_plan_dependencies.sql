-- Migration 033: Sprint 0 replaces the scaffold task, a first plan records the
-- ordering hints its decomposition dropped, and a Sprint 0 task keeps its stack
-- statement (story s-platform-role-m1, task t-sprint0-replaces-scaffold).
--
-- The task decomposition adds to every plan was recorded as task_spec.origin
-- 'scaffold'; its producer is now Sprint 0, recorded as 'sprint0'. Stored rows
-- are renamed so the origin set stays closed ('decomposition', 'sprint0').

UPDATE work_items
SET task_spec = jsonb_set(task_spec, '{origin}', '"sprint0"'::jsonb)
WHERE jsonb_typeof(task_spec) = 'object' AND task_spec->>'origin' = 'scaffold';

-- The dependsOn entries the decomposition's re-ask dropped (each names the
-- dependent task's title and the reference that matched no task), written by the
-- first-plan transaction together with first_planned_at. A project planned before
-- this migration has NULL: how many hints its plan dropped was never recorded,
-- and an empty array would claim none were.
ALTER TABLE projects
  ADD COLUMN plan_dropped_dependencies JSONB;

ALTER TABLE projects
  ADD CONSTRAINT projects_plan_dropped_dependencies_planned CHECK (
    plan_dropped_dependencies IS NULL
    OR (first_planned_at IS NOT NULL AND jsonb_typeof(plan_dropped_dependencies) = 'array')
  );

-- The environment role's finish statement on its Sprint 0 task: the stack it
-- chose and why, written by Z0 when the substrate gate passed and before the
-- merge. Only environment work carries one; t-dispatch-by-env-version reads it.
ALTER TABLE work_items
  ADD COLUMN environment_statement TEXT;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_environment_statement_on_environment_work CHECK (
    environment_statement IS NULL
    OR (work_kind = 'environment' AND btrim(environment_statement) <> '')
  );
