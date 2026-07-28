-- Migration 003: Add run_scope column to work_items
--
-- Every work item carries a run scope — the runId of the run that created it,
-- "pre-scoping" for rows that predate this column, or "ad-hoc" for items
-- created outside any orchestrator run (HTTP API). NOT NULL with a represented
-- variant instead of a nullable column, because NULL would be an evidence
-- default: the sweep and the summary would each read it differently
-- (Discipline A).
--
-- Step 1: add the column with a temporary DEFAULT so existing rows are
--         backfilled to "pre-scoping" in the same DDL statement.
-- Step 2: drop the DEFAULT immediately. No default exists at either the
--         DB layer or the application layer — every insert site supplies
--         the value explicitly.

ALTER TABLE work_items
  ADD COLUMN run_scope VARCHAR(50) NOT NULL DEFAULT 'pre-scoping';

ALTER TABLE work_items
  ALTER COLUMN run_scope DROP DEFAULT;
