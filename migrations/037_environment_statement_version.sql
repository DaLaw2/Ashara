-- Migration 038: an environment task's statement is kept with the environment
-- version it was tested on (story s-independent-verify-m1, task
-- t-regression-suite-postmerge; evidence docs/investigations/sprint0-run-2026-10-14.md D5).
--
-- Every later task is briefed with the statement of the environment version it
-- runs on, chosen by that version: the latest Completed environment task that
-- recorded a statement for it. A version no environment task recorded one for
-- (a non-environment commit moved the owned files) has no statement, and its
-- dispatch is environment_undefined. A statement recorded before this migration
-- has no version, so it matches no version: those projects fail closed until an
-- environment task records its statement again.

ALTER TABLE work_items
  ADD COLUMN environment_statement_version TEXT;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_environment_statement_version_shape CHECK (
    environment_statement_version IS NULL
    OR (environment_statement IS NOT NULL AND environment_statement_version ~ '^[0-9a-f]{64}$')
  );
