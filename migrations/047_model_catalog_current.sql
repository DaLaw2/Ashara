-- Migration 047: the catalog holds only current models, graded as Ashara calls them,
-- at their base-tier prices, with prompt-length tiers stored separately
-- (story s-model-catalog-refresh, task t-model-catalog-2026-10-14).
--
-- Source: docs/investigations/model-catalog-2026-10-14.md (provider pages read
-- 2026-10-14), its §8 table, and the owner rulings of ADR-074 item 83:
--   (a) a model's level is its §4.4 grade "as called". DeepSeek thinking is turned on
--       for every routing site (config/models.toml [thinking]), so deepseek-flash
--       takes its thinking-on grade, Strong (B-AA TB4 max 26.8, borderline).
--   (b) deepseek-v4-pro is removed; the routes that named it go to the Claude model
--       of the same level (config/models.toml).
--   (c) mistral-large-4 is stored at its list price: the sale's end date is unpublished.
-- USD per million tokens. Every kept row's capability, prices, context and API id are
-- set below, not left to what 002, 021 and 026 wrote.
--
-- Not built here: scheduled price changes (gemini-4-argon 4.00 / 20.00 / 0.20 from
-- 2026-12-01; gemini-3.8-flash 1.50 / 7.50 / 0.15 from 2027-01-01). Each row holds
-- today's rate, so after its change date it under-counts until a later change.

-- ---------------------------------------------------------------------------
-- Prompt-length tiers. A tier's rates replace the base rates for the whole call when
-- the call's reported input tokens (cache reads and writes included) are at least
-- min_input_tokens. Where the provider's boundary is ambiguous, min_input_tokens is
-- its lowest reading, so a count inside the ambiguity is billed the higher tier.
-- ---------------------------------------------------------------------------

CREATE TABLE model_price_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL REFERENCES model_configs(model_id) ON DELETE CASCADE ON UPDATE CASCADE,
  min_input_tokens INTEGER NOT NULL CHECK (min_input_tokens > 0),
  input_cost_per_1m DOUBLE PRECISION NOT NULL CHECK (input_cost_per_1m > 0),
  output_cost_per_1m DOUBLE PRECISION NOT NULL CHECK (output_cost_per_1m > 0),
  cache_read_cost_per_1m DOUBLE PRECISION CHECK (cache_read_cost_per_1m IS NULL OR cache_read_cost_per_1m >= 0),
  cache_write_cost_per_1m DOUBLE PRECISION CHECK (cache_write_cost_per_1m IS NULL OR cache_write_cost_per_1m >= 0),
  UNIQUE (model_id, min_input_tokens)
);

-- ---------------------------------------------------------------------------
-- Removed (record §5). Their model_price_windows rows cascade.
-- ---------------------------------------------------------------------------

DELETE FROM model_configs WHERE model_id IN (
  -- R1: legacy (A-models).
  'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6',
  -- ADR-074 d83 (b): dominated by deepseek-flash on score and price.
  'deepseek-v4-pro',
  -- R1: access-restricted, shutdown dated, or previous generation (G-models, G-depr).
  'gemini-2-5-flash', 'gemini-2-5-pro', 'gemini-3.1-flash-lite', 'gemini-3.6-flash',
  -- R3: superseded in its family by gemini-4-argon (the record's reading, not a Google statement).
  'gemini-3.1-pro-preview',
  -- R2: provider_configs.local has no base_url and no local endpoint was listening.
  'gemma-4-e4b', 'nemotron3-nano-4b', 'qwen3.5-4b', 'qwen3.6-27b',
  -- R3: Large 3, superseded by mistral-large-4.
  'mistral-large-latest',
  -- R1: deprecated 2026-10-14, shutdown 2027-01-14; o3 shuts down 2026-12-11 (O-depr).
  'gpt-4-1', 'gpt-4-1-mini', 'o3',
  -- R4: the one cheaper xAI sibling is grok-4.3.
  'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning'
);

-- ---------------------------------------------------------------------------
-- Renamed (R6): a moving alias becomes the pinned id the provider publishes.
-- ---------------------------------------------------------------------------

UPDATE model_configs SET model_id = 'codestral-2508', updated_at = NOW() WHERE model_id = 'codestral-latest';
UPDATE model_configs SET model_id = 'mistral-small-2603', updated_at = NOW() WHERE model_id = 'mistral-small-latest';

-- ---------------------------------------------------------------------------
-- Added: Google's flagship, GA 2026-10-13 (G-models, G-log). Implicit caching only,
-- so no cache-write rate. Context is 1,048,576 tokens of input and output together.
-- ---------------------------------------------------------------------------

INSERT INTO model_configs (model_id, provider_name, api_model_id, capability, input_cost_per_1m, output_cost_per_1m,
    cache_read_cost_per_1m, cache_write_cost_per_1m, max_context_tokens)
VALUES ('gemini-4-argon', 'google', 'gemini-4-argon', 'Frontier', 2.00, 10.00, 0.10, NULL, 1048576);

-- ---------------------------------------------------------------------------
-- Every kept row, exactly as the record's §8 table (base tier; level as called).
-- ---------------------------------------------------------------------------

UPDATE model_configs AS m SET
    api_model_id = v.api_model_id,
    capability = v.capability,
    input_cost_per_1m = v.input_cost,
    output_cost_per_1m = v.output_cost,
    cache_read_cost_per_1m = v.cache_read_cost,
    cache_write_cost_per_1m = v.cache_write_cost,
    max_context_tokens = v.max_context_tokens,
    updated_at = NOW()
FROM (VALUES
  -- A-price, A-models. Cache write is the 5-minute rate.
  ('claude-fable-5-1', 'claude-fable-5-1', 'Frontier', 10.00, 50.00, 0.25, 12.50::double precision, 1000000),
  ('claude-opus-5-5', 'claude-opus-5-5', 'Frontier', 4.00, 20.00, 0.20, 5.00, 1000000),
  ('claude-sonnet-5-5', 'claude-sonnet-5-5', 'Strong', 2.00, 10.00, 0.10, 2.50, 1000000),
  ('claude-haiku-5-5', 'claude-haiku-5-5', 'Medium', 0.10, 0.50, 0.01, 0.125, 1000000),
  -- D-price: the peak rate; the off-peak windows 021 stored stay.
  ('deepseek-flash', 'deepseek-flash', 'Strong', 0.30, 1.20, 0.006, NULL, 1000000),
  -- O-price, O-page. gpt-6-astra's level is provisional: its default effort is unverified.
  ('gpt-6-astra', 'gpt-6-astra', 'Frontier', 10.00, 50.00, 1.00, 12.50, 1050000),
  ('gpt-6.1-sol', 'gpt-6.1-sol', 'Strong', 2.00, 10.00, 0.10, 2.50, 1050000),
  ('gpt-6-luna', 'gpt-6-luna', 'Light', 0.10, 0.50, 0.01, 0.125, 1050000),
  -- G-price, G-page. gemini-4-argon's level is provisional: only its High effort is scored.
  ('gemini-4-argon', 'gemini-4-argon', 'Frontier', 2.00, 10.00, 0.10, NULL, 1048576),
  ('gemini-3.8-flash', 'gemini-3.8-flash', 'Medium', 0.75, 3.75, 0.075, NULL, 1048576),
  ('gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'Light', 0.30, 2.50, 0.03, NULL, 1048576),
  -- X-models, X-page.
  ('grok-4.7', 'grok-4.7', 'Medium', 2.00, 6.00, 0.50, NULL, 500000),
  ('grok-4.3', 'grok-4.3', 'Light', 1.25, 2.50, 0.20, NULL, 1000000),
  -- M-card, M-price. mistral-large-4 at list price (d83 c). "256k" is written as
  -- 256000, the smaller reading; 262,144 is unverified. codestral-2508 is Light provisionally:
  -- no board scores it.
  ('mistral-large-4', 'mistral-large-4', 'Strong', 1.36, 4.18, 0.14, NULL, 1000000),
  ('mistral-medium-3-5', 'mistral-medium-3-5', 'Light', 1.50, 7.50, 0.15, NULL, 256000),
  ('mistral-small-2603', 'mistral-small-2603', 'Light', 0.15, 0.60, 0.015, NULL, 256000),
  ('ministral-3b-2512', 'ministral-3b-2512', 'Light', 0.10, 0.10, 0.01, NULL, 256000),
  ('codestral-2508', 'codestral-2508', 'Light', 0.30, 0.90, 0.03, NULL, 128000)
) AS v(model_id, api_model_id, capability, input_cost, output_cost, cache_read_cost, cache_write_cost,
       max_context_tokens)
WHERE m.model_id = v.model_id;

-- ---------------------------------------------------------------------------
-- The higher tiers (record §3, §6.2).
--   claude-haiku-5-5: a prompt "over 100,000 tokens", cache reads and writes included (A-price).
--   gpt-6-*: "more than 272K input tokens"; 272,000 vs 278,528 is unverified, so the tier
--     starts above 272,000 (O-price, O-page).
--   grok-*: a prompt that "reaches" 200k; 200,000 vs 204,800 is unverified, so the tier
--     starts at 200,000 (X-models).
-- ---------------------------------------------------------------------------

INSERT INTO model_price_tiers (model_id, min_input_tokens, input_cost_per_1m, output_cost_per_1m,
    cache_read_cost_per_1m, cache_write_cost_per_1m)
VALUES
  ('claude-haiku-5-5', 100001, 0.50, 2.50, 0.05, 0.625),
  ('gpt-6-astra', 272001, 20.00, 75.00, 2.00, 25.00),
  ('gpt-6.1-sol', 272001, 4.00, 15.00, 0.20, 5.00),
  ('gpt-6-luna', 272001, 0.20, 0.75, 0.02, 0.25),
  ('grok-4.7', 200000, 4.00, 12.00, 1.00, NULL),
  ('grok-4.3', 200000, 2.50, 5.00, 0.40, NULL);

-- ---------------------------------------------------------------------------
-- Fail closed: the catalog is exactly the record's eighteen models. A row this
-- migration did not expect (or one it expected and did not find) stops it here.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  expected TEXT[] := ARRAY[
    'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'codestral-2508',
    'deepseek-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6-astra',
    'gpt-6-luna', 'gpt-6.1-sol', 'grok-4.3', 'grok-4.7', 'ministral-3b-2512', 'mistral-large-4',
    'mistral-medium-3-5', 'mistral-small-2603'
  ];
  missing TEXT[];
  unexpected TEXT[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO missing
    FROM unnest(expected) AS id WHERE id NOT IN (SELECT model_id FROM model_configs);
  SELECT array_agg(model_id ORDER BY model_id) INTO unexpected
    FROM model_configs WHERE model_id <> ALL (expected);
  IF missing IS NOT NULL OR unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'migration 047: model_configs is not the record''s catalog (missing: %, unexpected: %)',
      missing, unexpected;
  END IF;
END $$;
