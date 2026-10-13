-- Migration 006: Drop columns nothing reads.
--
-- domain_events.processed and domain_events.priority: their only readers were the
-- event drain (pollUnprocessed / markProcessed), which was removed. Nothing ever
-- set processed = true afterwards, so idx_events_unprocessed (a partial index
-- WHERE NOT processed) would have indexed every event forever.
--
-- model_configs.strict_mode: the gateway no longer reads it, so the column was
-- write-only.

DROP INDEX IF EXISTS idx_events_unprocessed;
ALTER TABLE domain_events DROP COLUMN IF EXISTS processed;
ALTER TABLE domain_events DROP COLUMN IF EXISTS priority;
ALTER TABLE model_configs DROP COLUMN IF EXISTS strict_mode;
