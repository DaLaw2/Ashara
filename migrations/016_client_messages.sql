-- Migration 016: client_messages, the client channel (story s-client-channel-m1, K1,
-- Engagement context per ADR-075).
--
-- One row per message between the client and the contractor. Inbound kinds are
-- what a client may say (tender, answer, change, stop); outbound kinds are what
-- the Liaison says (question, report). The pairing is a CHECK, so a row of the
-- wrong direction cannot exist whatever code wrote it.
--
-- Every inbound insert NOTIFYs 'ashara_events', the channel the domain_events
-- trigger (migration 001) uses, so the orchestrator's listener wakes the loop.
-- The listener wakes on any non-empty payload and does not read it; this payload
-- is JSON so a future reader can tell a client message from a domain event id.

CREATE TABLE client_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind VARCHAR(10) NOT NULL
    CHECK (kind IN ('tender', 'answer', 'change', 'stop', 'question', 'report')),
  body TEXT NOT NULL CHECK (length(body) > 0),
  in_reply_to UUID REFERENCES client_messages(id),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT client_messages_direction_kind CHECK (
    (direction = 'inbound' AND kind IN ('tender', 'answer', 'change', 'stop'))
    OR (direction = 'outbound' AND kind IN ('question', 'report'))
  ),
  -- An answer always names the question it answers.
  CONSTRAINT client_messages_answer_replies CHECK (kind <> 'answer' OR in_reply_to IS NOT NULL)
);

CREATE INDEX idx_client_messages_project_created ON client_messages(project_id, created_at);

CREATE OR REPLACE FUNCTION notify_client_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'ashara_events',
    json_build_object('type', 'client_message', 'project_id', NEW.project_id, 'message_id', NEW.id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_messages_inbound_notify
  AFTER INSERT ON client_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'inbound')
  EXECUTE FUNCTION notify_client_message();
