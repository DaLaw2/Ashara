-- Migration 018: clients, and every project and web session bound to one
-- (task t-client-scoping-m1, ADR-076 d1: a project-scoped client API).
--
-- Before this migration any web session could list, read and stop every
-- project. A client is now a row; a project belongs to exactly one client and a
-- session acts for exactly one client. There is no default client: a project or
-- a session without one is refused by NOT NULL, not filled in.

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN client_id UUID REFERENCES clients(id);

-- Backfill. Projects created before clients existed belong to nobody we can
-- name, so they are given ONE explicitly labelled client rather than left
-- ownerless (which NOT NULL forbids) or assigned to a real client (which would
-- hand that client rows it never tendered). The client is created only when
-- such rows exist; it has no access code until an operator stores one, so no
-- session can be opened for it by accident.
DO $$
DECLARE
  legacy_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE client_id IS NULL) THEN
    INSERT INTO clients (name) VALUES ('pre-client legacy rows (2026-10-13)') RETURNING id INTO legacy_id;
    UPDATE projects SET client_id = legacy_id WHERE client_id IS NULL;
  END IF;
END $$;

ALTER TABLE projects ALTER COLUMN client_id SET NOT NULL;
CREATE INDEX idx_projects_client_created ON projects (client_id, created_at DESC);

-- Existing sessions were opened with the single shared access code and act for
-- no client; they cannot be bound after the fact, so they are ended.
DELETE FROM client_sessions;
ALTER TABLE client_sessions ADD COLUMN client_id UUID NOT NULL REFERENCES clients(id);

-- Failed logins, keyed by the client name as presented (known or not, so an
-- unknown name is throttled exactly like a known one). Persisted so a restart
-- does not reset the throttle (Discipline B).
CREATE TABLE client_login_failures (
  client_name TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_client_login_failures_name_time ON client_login_failures (client_name, failed_at);

-- A question takes one answer. The route checks first and answers 409; this
-- index holds when two answers race past that check.
CREATE UNIQUE INDEX uq_client_messages_one_answer_per_question
  ON client_messages (in_reply_to) WHERE kind = 'answer';
