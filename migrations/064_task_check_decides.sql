-- Migration 064: each stored check names the vision items it decides (ADR-083).
--
-- task_checks.decides: the ids of the vision items the check task cites that this check's verdict
-- decides, as the check author named them in define_check, a non-empty JSON array of non-empty
-- strings. Z0 keeps a check set only when every item its check task cites is named by at least one
-- of its checks, so which items are checked is a stored fact, never read off an acceptance line
-- that cites them. A row written before this migration has none: NULL, which is no evidence that
-- the check decides any item, and is read so.

ALTER TABLE task_checks
  ADD COLUMN decides jsonb CHECK (
    decides IS NULL
    OR (jsonb_typeof(decides) = 'array' AND jsonb_array_length(decides) >= 1)
  );
