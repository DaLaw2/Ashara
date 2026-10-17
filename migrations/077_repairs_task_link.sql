-- Migration 077: the recorded link from a repair task to the task it repairs (m3-scope C4, task
-- t-goal-task-one-definition).
--
-- work_items.repairs_task_id: on an environment-change task (task_spec.origin
-- 'environment-change'), the task it was opened for, the one whose implementer needed the change.
-- Written with the task when Delivery creates it. NULL on every other task, and on an
-- environment-change task created before this migration: the run report names that spend
-- unattributed rather than reading the link back out of the dependency graph.
ALTER TABLE work_items
  ADD COLUMN repairs_task_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  ADD CONSTRAINT work_items_repairs_task_only_environment_change CHECK (
    repairs_task_id IS NULL OR (task_spec->>'origin' = 'environment-change' AND repairs_task_id <> id)
  );
