-- Migration 032: environment builds (story s-platform-role-m1, task t-environment-build).
--
-- One row per podman build of a project's environment version: the sha256 over
-- the owned files' tree entries (execution-infra environment.ts) and the last
-- commit that touched them. The image is built from those files only.
--
-- network is the network the build ran with. Builds are the one thing that may
-- reach a network (ADR-074 addendum 2 d62), so every row says which.
-- log_digest is the sha256 of the captured build log.
--
-- A succeeded row carries the image id and no error; a failed row carries the
-- error and no image id. Failed rows are history and accumulate; the one
-- succeeded row of a (project, version) is the image cells of that version run
-- from, replaced when the image is rebuilt.

CREATE TABLE environment_builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    version TEXT NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'),
    commit TEXT NOT NULL CHECK (commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
    image_ref TEXT NOT NULL CHECK (image_ref <> ''),
    image_id TEXT CHECK (image_id ~ '^sha256:[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
    network TEXT NOT NULL CHECK (network <> ''),
    log_digest TEXT NOT NULL CHECK (log_digest ~ '^[0-9a-f]{64}$'),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT environment_builds_outcome_columns CHECK (
        (status = 'succeeded' AND image_id IS NOT NULL AND error IS NULL)
        OR (status = 'failed' AND image_id IS NULL AND error IS NOT NULL AND error <> '')
    )
);

CREATE UNIQUE INDEX environment_builds_one_succeeded
    ON environment_builds (project_id, version)
    WHERE status = 'succeeded';
