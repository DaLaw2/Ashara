-- Migration 022: the order of the Liaison's questions (story s-liaison-intake-m1,
-- Engagement per ADR-075).
--
-- Intake posts all of a tender's questions in one transaction, so they share one
-- created_at (NOW() is the transaction's start). Ordering by (created_at, id) then
-- broke the tie by random uuid, and the client saw the questions shuffled
-- (docs/investigations/liaison-intake-transcript-2026-10-13.md F3). The order the
-- Liaison ranked them in is recorded here as an explicit 1-based position.
--
-- Why a column and not distinct created_at values: the channel's `since` filter
-- compares created_at at millisecond precision, so timestamps a few microseconds
-- apart would collapse back into a tie there; and a timestamp says when, not which
-- comes first. A question posted alone has no sibling to be ordered against, so
-- the column stays nullable; intake always writes it.

ALTER TABLE client_messages
  ADD COLUMN position INTEGER,
  ADD CONSTRAINT client_messages_position_question_only CHECK (
    position IS NULL OR (direction = 'outbound' AND kind = 'question' AND position >= 1)
  );

-- Two questions posted in reply to one tender never share a position.
CREATE UNIQUE INDEX client_messages_question_position_unique
  ON client_messages (in_reply_to, position)
  WHERE position IS NOT NULL;

-- Questions posted before this migration: the vision's open_questions list holds
-- the order the Liaison wrote them in (intake, migration 019 onward). A vision
-- written by another path stores open_questions in another shape, which matches
-- no row here and is left alone. Intake writes only version 1.
UPDATE client_messages cm
SET position = q.ord
FROM vision_documents v,
  LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(v.open_questions) = 'array' THEN v.open_questions ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS q(elem, ord)
WHERE v.version = 1
  AND jsonb_typeof(q.elem) = 'object'
  AND cm.id::text = q.elem ->> 'messageId'
  AND cm.project_id = v.project_id
  AND cm.direction = 'outbound'
  AND cm.kind = 'question'
  AND cm.in_reply_to IS NOT NULL;
