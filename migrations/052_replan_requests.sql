-- Migration 052: every answer a plan revision takes in is on record (ADR-074 d94 a; evidence
-- docs/investigations/smoke1-python-wc-2026-10-15.md D2).
--
-- projects.replan_requested_by (migration 038) held one answer: a second answer that changed an
-- assumption while the first awaited its revision kept only the first (COALESCE), so the revision
-- that took in both was reported as answering the first alone, while the second answer's own
-- report had promised the client to be told what changed. The request is now one row per answer:
-- a row with no plan_revision_id is an answer whose revision the project awaits, and the revision
-- that took it in is recorded on it, as plan_repairs records a repair (migration 045).
--
-- plan_revisions.requested_by stays: the earliest answer the revision took in, which its report
-- replies to, and the CHECK of migration 045 that a client_change revision names one. A revision's
-- summary now lists every change it took in (`changes`), each with the client's words and the
-- decision; a summary written before this migration names one, and is rewritten to the list of it.

CREATE TABLE replan_requests (
  answer_id UUID PRIMARY KEY REFERENCES client_messages(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision_id UUID REFERENCES plan_revisions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX replan_requests_pending ON replan_requests (project_id) WHERE plan_revision_id IS NULL;

INSERT INTO replan_requests (answer_id, project_id, plan_revision_id, created_at)
  SELECT r.requested_by, r.project_id, r.id, r.created_at FROM plan_revisions r WHERE r.requested_by IS NOT NULL;

INSERT INTO replan_requests (answer_id, project_id, created_at)
  SELECT p.replan_requested_by, p.id, m.created_at
  FROM projects p JOIN client_messages m ON m.id = p.replan_requested_by
  WHERE p.replan_requested_by IS NOT NULL
  ON CONFLICT (answer_id) DO NOTHING;

ALTER TABLE projects DROP COLUMN replan_requested_by;

DO $$
DECLARE
  rewritten INTEGER;
BEGIN
  UPDATE plan_revisions
    SET summary = (summary - 'answer' - 'decision')
      || jsonb_build_object('changes', jsonb_build_array(jsonb_build_object('answer', summary->'answer', 'decision', summary->'decision')))
    WHERE kind = 'client_change' AND summary ? 'answer';
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  RAISE NOTICE 'migration 052: % client-change revision summar(ies) rewritten to the list of their one change', rewritten;
END $$;
