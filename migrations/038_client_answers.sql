-- Migration 038: the client's answers reach the vision and the plan (story
-- s-liaison-intake-m1, task t-vision-answers-reach-plan; evidence
-- docs/investigations/sprint0-run-2026-10-14.md D8).
--
-- The Liaison consumes each inbound 'answer' once. An answer that confirms or
-- changes the assumption its question named appends a vision version whose
-- assumption is Stated and carries the answer, so the answer has one home: the
-- vision's assumptions. vision_documents.user_answers, which no code wrote, is
-- dropped. It is dropped only when every row holds the empty default: a row with
-- answers in it stops the migration instead of losing them.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vision_documents WHERE user_answers <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'migration 038: vision_documents.user_answers holds answers in % row(s); move them into the vision''s assumptions before dropping the column',
      (SELECT count(*) FROM vision_documents WHERE user_answers <> '[]'::jsonb);
  END IF;
END $$;

ALTER TABLE vision_documents DROP COLUMN user_answers;

-- Reading an answer can fail like reading a tender (provider unreachable, invalid
-- model output): each failed attempt is counted on the answer's own row with its
-- error (migration 019's columns), so the loop stops retrying after its cap.
ALTER TABLE client_messages
  DROP CONSTRAINT client_messages_intake_tender_only,
  ADD CONSTRAINT client_messages_intake_tender_or_answer_only CHECK (
    kind IN ('tender', 'answer') OR (intake_attempts = 0 AND intake_last_error IS NULL)
  );

-- An answer that arrived after the first plan and contradicts an assumption the
-- plan was built on: the first such answer is recorded here, and no task of the
-- project is dispatched while it is set. Revising the plan is backlog story
-- c-change-handling; nothing clears this column yet.
ALTER TABLE projects
  ADD COLUMN replan_requested_by UUID REFERENCES client_messages(id);
