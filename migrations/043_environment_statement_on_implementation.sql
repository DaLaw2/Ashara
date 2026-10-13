-- Migration 043: an implementation's verified merge may produce an environment version
-- (story s-platform-role-m1, task t-environment-fence; ADR-074 addendum 2 d66 a; evidence
-- docs/investigations/third-run-2026-10-14.md N7).
--
-- Only environment/ is protected now. An implementation task may change an owned file of
-- the environment outside it (a dependency manifest, or any single file the definition
-- owns); its post-merge verification rebuilds the environment from the merge and runs its
-- build and test. A merge that passes moves the project's environment version without any
-- environment task, so the statement of the version it ran on is recorded with the new
-- version on the implementation's own work item: the next dispatch resolves that version
-- through it. Migration 033 allowed a statement on environment work only.

ALTER TABLE work_items
  DROP CONSTRAINT work_items_environment_statement_on_environment_work;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_environment_statement_on_environment_work CHECK (
    environment_statement IS NULL
    OR (work_kind IN ('environment', 'implementation') AND btrim(environment_statement) <> '')
  );
