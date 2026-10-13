-- Migration 021: model catalog refresh (story s-model-catalog-refresh; ADR-077; ADR-074 D15).
--
-- Every number below comes from docs/investigations/llm-models-prices-2026-10-13.md
-- (provider pages read 2026-10-13); the section is cited on each row. USD per
-- million tokens. A price that section 12 lists as unverified is not written.
--
-- 1. Explicit cache prices replace the blanket Anthropic multipliers that
--    supports_caching gated in calculateCost (D15). NULL means the model bills
--    no such class: its tokens, if any are reported, cannot be priced, and the
--    ledger records a NULL cost. supports_caching is dropped: nothing reads it
--    once the rates are explicit.
-- 2. model_price_windows holds time-of-day rates. The base row holds the PEAK
--    (higher) rate and the windows hold the OFF-PEAK (discounted) rate, so every
--    gap fails closed: an instant no window covers, a model whose windows are
--    missing, and a condition the table cannot express (DeepSeek's "excluding
--    Chinese public holidays", section 3) are all charged the higher rate. The
--    ledger over-counts on those, never under-counts.
-- 3. Retired models and models closing before 2026-11-01 are removed; the
--    retired name deepseek-v4-flash becomes deepseek-flash.

ALTER TABLE model_configs
  ADD COLUMN cache_read_cost_per_1m DOUBLE PRECISION
    CHECK (cache_read_cost_per_1m IS NULL OR cache_read_cost_per_1m >= 0),
  ADD COLUMN cache_write_cost_per_1m DOUBLE PRECISION
    CHECK (cache_write_cost_per_1m IS NULL OR cache_write_cost_per_1m >= 0),
  DROP COLUMN supports_caching;

-- A window [utc_start_minute, utc_end_minute) on one UTC ISO weekday (1 = Monday).
-- Its rates replace the base row's for a call made inside it. Overlapping
-- windows of one model are refused when the catalog loads (InvalidGatewayCatalog).
CREATE TABLE model_price_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL REFERENCES model_configs(model_id) ON DELETE CASCADE ON UPDATE CASCADE,
  iso_weekday SMALLINT NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  utc_start_minute SMALLINT NOT NULL CHECK (utc_start_minute >= 0),
  utc_end_minute SMALLINT NOT NULL CHECK (utc_end_minute <= 1440),
  input_cost_per_1m DOUBLE PRECISION NOT NULL CHECK (input_cost_per_1m > 0),
  output_cost_per_1m DOUBLE PRECISION NOT NULL CHECK (output_cost_per_1m > 0),
  cache_read_cost_per_1m DOUBLE PRECISION CHECK (cache_read_cost_per_1m IS NULL OR cache_read_cost_per_1m >= 0),
  cache_write_cost_per_1m DOUBLE PRECISION CHECK (cache_write_cost_per_1m IS NULL OR cache_write_cost_per_1m >= 0),
  CHECK (utc_start_minute < utc_end_minute),
  UNIQUE (model_id, iso_weekday, utc_start_minute)
);

-- 015's NUMERIC(12, 6) rounds to a micro-dollar. At deepseek-flash's off-peak
-- cache read (0.003 / MTok) a 300-token call costs 0.0000009 and was stored as
-- 0.000001; a smaller one as 0, which reads as free. Twelve decimals hold a
-- single token at the cheapest rate below.
ALTER TABLE llm_calls ALTER COLUMN cost_usd TYPE NUMERIC(20, 12);

-- ---------------------------------------------------------------------------
-- Removed. config/models.toml routes none of them (its escalation entry moves
-- to claude-sonnet-5-5 in this change), and no code names them.
-- ---------------------------------------------------------------------------

-- section 4.3 / 10: retired 2026-05-15, the slug redirects to grok-4.3.
DELETE FROM model_configs WHERE model_id = 'grok-3';
-- section 4.1 / 10: shutdown 2026-10-23.
DELETE FROM model_configs WHERE model_id IN ('gpt-4-1-nano', 'o4-mini');
-- section 2.3 / 10: retires "not sooner than October 15, 2026".
DELETE FROM model_configs WHERE model_id = 'claude-haiku-4-5';

-- section 3: "Use deepseek-flash as the model name"; deepseek-v4-flash is a
-- retired model whose requests are served and billed as deepseek-flash.
UPDATE model_configs SET model_id = 'deepseek-flash', api_model_id = 'deepseek-flash', updated_at = NOW()
  WHERE model_id = 'deepseek-v4-flash';

-- ---------------------------------------------------------------------------
-- Prices. Anthropic's cache write is the 5-minute TTL rate: no Ashara request
-- sets a cache TTL, and 5 minutes is the default.
-- ---------------------------------------------------------------------------

-- section 2.3 / 10 (current, legacy).
UPDATE model_configs SET cache_read_cost_per_1m = 1.00, cache_write_cost_per_1m = 12.50, updated_at = NOW()
  WHERE model_id = 'claude-fable-5';
-- section 2.3 / 10 (current, legacy).
UPDATE model_configs SET cache_read_cost_per_1m = 0.50, cache_write_cost_per_1m = 6.25, updated_at = NOW()
  WHERE model_id = 'claude-opus-4-8';
-- section 2.1 / 10: stale 3 / 15; footnote 3 makes 2 / 10 the standard price.
UPDATE model_configs SET input_cost_per_1m = 2.00, output_cost_per_1m = 10.00,
    cache_read_cost_per_1m = 0.20, cache_write_cost_per_1m = 2.50, updated_at = NOW()
  WHERE model_id = 'claude-sonnet-5';
-- section 2.3 / 10 (current, legacy).
UPDATE model_configs SET cache_read_cost_per_1m = 0.30, cache_write_cost_per_1m = 3.75, updated_at = NOW()
  WHERE model_id = 'claude-sonnet-4-6';

-- section 2.3: Active (latest), 1M context. Strong, as every other Sonnet row
-- (002); section 11 lists it among Frontier-tier candidates, which this row
-- does not adopt. Decided: owner 2026-10-13 (ADR-077) to switch to it.
INSERT INTO model_configs (model_id, provider_name, api_model_id, capability, input_cost_per_1m, output_cost_per_1m,
    cache_read_cost_per_1m, cache_write_cost_per_1m, max_context_tokens)
  VALUES ('claude-sonnet-5-5', 'anthropic', NULL, 'Strong', 2.00, 10.00, 0.10, 2.50, 1000000);

-- section 3: base = peak. No cache-write class is billed ("no write charge
-- listed"): writes are cache misses, priced as input.
UPDATE model_configs SET input_cost_per_1m = 0.30, output_cost_per_1m = 1.20,
    cache_read_cost_per_1m = 0.006, cache_write_cost_per_1m = NULL, updated_at = NOW()
  WHERE model_id = 'deepseek-flash';
UPDATE model_configs SET input_cost_per_1m = 1.32, output_cost_per_1m = 3.96,
    cache_read_cost_per_1m = 0.044, cache_write_cost_per_1m = NULL, updated_at = NOW()
  WHERE model_id = 'deepseek-v4-pro';

-- section 3: off-peak is every hour outside 01:00-04:00 and 06:00-10:00 UTC,
-- Monday through Friday, and all of Saturday and Sunday.
INSERT INTO model_price_windows (model_id, iso_weekday, utc_start_minute, utc_end_minute,
    input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m, cache_write_cost_per_1m)
SELECT m.model_id, w.iso_weekday, w.start_minute, w.end_minute, m.input, m.output, m.cache_read, NULL
FROM (VALUES ('deepseek-flash', 0.15, 0.60, 0.003),
             ('deepseek-v4-pro', 0.66, 1.98, 0.022)) AS m(model_id, input, output, cache_read)
CROSS JOIN (
  SELECT d, gap.s, gap.e FROM generate_series(1, 5) AS d
    CROSS JOIN (VALUES (0, 60), (240, 360), (600, 1440)) AS gap(s, e)
  UNION ALL
  SELECT d, 0, 1440 FROM generate_series(6, 7) AS d
) AS w(iso_weekday, start_minute, end_minute);

-- section 4.1 / 10: price current; cache read only, no write class listed.
UPDATE model_configs SET cache_read_cost_per_1m = 0.50, updated_at = NOW() WHERE model_id = 'gpt-4-1';
UPDATE model_configs SET cache_read_cost_per_1m = 0.10, updated_at = NOW() WHERE model_id = 'gpt-4-1-mini';
UPDATE model_configs SET cache_read_cost_per_1m = 0.50, updated_at = NOW() WHERE model_id = 'o3';

-- section 4.2 / 10: price current; no cache-write fee (storage is hourly, not
-- per token). gemini-2-5-pro's > 200K prompt tier (2.50 / 15.00) is not
-- expressible here; the row holds the <= 200K rate.
UPDATE model_configs SET cache_read_cost_per_1m = 0.125, updated_at = NOW() WHERE model_id = 'gemini-2-5-pro';
UPDATE model_configs SET cache_read_cost_per_1m = 0.03, updated_at = NOW() WHERE model_id = 'gemini-2-5-flash';

-- section 4.4 / 10: the aliases now name Large 3, Small 4 and codestral-2508.
-- "256K" / "128K" are written as 256000 / 128000, the smaller reading.
UPDATE model_configs SET input_cost_per_1m = 0.50, output_cost_per_1m = 1.50, cache_read_cost_per_1m = 0.05,
    max_context_tokens = 256000, updated_at = NOW()
  WHERE model_id = 'mistral-large-latest';
UPDATE model_configs SET input_cost_per_1m = 0.15, output_cost_per_1m = 0.60, cache_read_cost_per_1m = 0.015,
    max_context_tokens = 256000, updated_at = NOW()
  WHERE model_id = 'mistral-small-latest';
UPDATE model_configs SET cache_read_cost_per_1m = 0.03, max_context_tokens = 128000, updated_at = NOW()
  WHERE model_id = 'codestral-latest';

-- ---------------------------------------------------------------------------
-- Capability. 002 seeds these Strong, but the dev DB held Medium with no
-- migration that wrote it (who changed it: unverified). Set explicitly so every
-- database agrees. deepseek-flash: section 11 places it in the Strong tier.
-- The rest are not positioned by the investigation (section 11 lists only
-- current, qualifying models): the value is 002's, their tier unverified.
-- ---------------------------------------------------------------------------
UPDATE model_configs SET capability = 'Strong', updated_at = NOW()
  WHERE model_id IN ('deepseek-flash', 'gemini-2-5-flash', 'gpt-4-1', 'mistral-large-latest', 'qwen3.6-27b');
