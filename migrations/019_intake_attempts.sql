-- Migration 019: tender intake attempts (story s-liaison-intake-m1, Engagement per
-- ADR-075).
--
-- The Liaison's intake of a tender can fail (provider unreachable, invalid model
-- output, a ledger refusal). Each failed attempt is counted on the tender's own
-- row with the error that ended it, so the count survives a restart and the loop
-- stops retrying after its cap instead of spinning on the same tender.
--
-- Touches only client_messages (migration 016); it does not depend on 018.

ALTER TABLE client_messages
  ADD COLUMN intake_attempts INTEGER NOT NULL DEFAULT 0 CHECK (intake_attempts >= 0),
  ADD COLUMN intake_last_error TEXT;

-- Only a tender is taken in, and a counted attempt always carries its error.
ALTER TABLE client_messages
  ADD CONSTRAINT client_messages_intake_tender_only CHECK (
    kind = 'tender' OR (intake_attempts = 0 AND intake_last_error IS NULL)
  ),
  ADD CONSTRAINT client_messages_intake_error_recorded CHECK (
    intake_attempts = 0 OR intake_last_error IS NOT NULL
  );
