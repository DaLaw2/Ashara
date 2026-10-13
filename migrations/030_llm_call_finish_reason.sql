-- Migration 030: llm_calls records why each provider request stopped and how
-- many of its output tokens were reasoning (story s-model-catalog-refresh, task
-- t-deepseek-empty-output).
--
-- Transcript 3 (2026-10-13) saw 19 of 23 deepseek-flash requests spend exactly
-- maxTokens and return no text, and no row could say why: the table held no
-- finish reason and no reasoning count.
--
-- finish_reason is the AI SDK's finish reason ('stop', 'length', ...), or
-- 'no-response' for a request that threw before any response arrived. It is
-- required on every row written from now on, by a CHECK added NOT VALID: the
-- rows written before this migration keep NULL, because their finish reason was
-- never observed and any backfilled value would be invented. Postgres enforces a
-- NOT VALID CHECK on every INSERT and UPDATE, and skips only the existing rows;
-- llm_calls is append-only, so those rows are never rewritten.
--
-- reasoning_tokens is nullable with no default, like every token column (015):
-- NULL means the provider reported no reasoning count (Anthropic reports none).

ALTER TABLE llm_calls ADD COLUMN finish_reason TEXT;
ALTER TABLE llm_calls ADD COLUMN reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0);

ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_finish_reason_recorded CHECK (finish_reason IS NOT NULL) NOT VALID;

-- A truncated structured call is one that stopped at maxTokens.
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_truncated_stopped_at_length
  CHECK (error_kind IS DISTINCT FROM 'truncated' OR finish_reason = 'length') NOT VALID;
