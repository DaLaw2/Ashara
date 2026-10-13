-- Migration 034: every task after Sprint 0 runs in cells built from the project's
-- current environment version, and the stack Sprint 0 chose is reported to the
-- client (story s-platform-role-m1, task t-dispatch-by-env-version).
--
-- The environment version a dev session's cells were built from: sha256 (hex)
-- over the owned files of environment/environment.toml on the target's main.
-- NULL when the cells ran on the BaseCell, which only the Sprint 0 task does.
ALTER TABLE dev_sessions
  ADD COLUMN environment_version TEXT;

ALTER TABLE dev_sessions
  ADD CONSTRAINT dev_sessions_environment_version_digest CHECK (
    environment_version IS NULL OR environment_version ~ '^[0-9a-f]{64}$'
  );

-- The Liaison's one report on the stack Sprint 0 chose. The unique index on
-- (project_id, reports_on) from migration 020 makes it one per project.
ALTER TABLE client_messages
  DROP CONSTRAINT client_messages_reports_on_known,
  ADD CONSTRAINT client_messages_reports_on_known CHECK (
    reports_on IS NULL
    OR (direction = 'outbound' AND kind = 'report'
        AND reports_on IN ('first-plan', 'planning-stopped', 'client-stop', 'stack-choice'))
  );
