-- Migration 007: Drop model_configs.format_group.
--
-- agent-runner runs the native function-calling path only (t-cut-w3); the
-- code-fence adapter that was the column's sole reader is deleted, so nothing
-- reads the per-model format group any more.

ALTER TABLE model_configs DROP COLUMN IF EXISTS format_group;
