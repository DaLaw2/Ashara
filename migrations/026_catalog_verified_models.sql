-- Migration 026: the catalog holds what the price investigation verified, and only that
-- (story s-model-catalog-refresh, task t-catalog-verification-gaps; ADR-077).
--
-- Every number below comes from docs/investigations/llm-models-prices-2026-10-13.md
-- (provider pages read 2026-10-13); the section is cited on each row. USD per
-- million tokens. ADR-077: a model without a verified price is not in the catalog.
--
-- 1. Tiered prices: the higher tier is recorded. model_configs has one rate per
--    token class and the gateway prices a call without knowing which prompt-length
--    tier the provider billed it in, so the row holds the highest rate the model
--    can bill. Calls below the threshold are over-counted, never under-counted:
--    - gemini-2-5-pro and gemini-3.1-pro-preview: the > 200K-token prompt rate (section 4.2);
--    - grok-*: the >= 200K rate, which "applies to all tokens in that request" (section 4.3);
--    - gpt-6-*: "Prompts with more than 272K input tokens are priced at 2x input and
--      cache rates and 1.5x output for the full request" (section 4.1);
--    - claude-haiku-5-5: the prompt > 100K rate (section 2.3).
--    Dated price changes are recorded the same way: gemini-3.8-flash and
--    gemini-3.6-flash hold the rate after 2026-12-31 (1.50 / 7.50, read 0.15),
--    and mistral-large-4 holds its list price, not the sale price whose end date
--    is unverified (section 4.4).
-- 2. Cache write NULL means the provider lists no cache-write charge for the model
--    (Google, xAI, Mistral: sections 4.2-4.4). A reported write count on such a
--    model leaves the call's cost unmeasured, never priced as 0.
-- 3. Capability. Where section 11 positions a model, its tier is used. Section 11
--    states its tiers are the provider's positioning, not a measured capability.
--    Where it does not, the row takes one tier BELOW the model it succeeds or is
--    priced alongside: the lower choice where the investigation is silent; each
--    row says which. Fitness of every tier is unverified (no Ashara run).
--    Routing over today's provider sets is unchanged for every sited request
--    (config/models.toml gains an "anthropic" profile pinning today's
--    resolutions). The one change is a Light request that reaches capability
--    logic over Anthropic: claude-haiku-5-5 instead of claude-sonnet-5-5. Two
--    paths reach it: a site-less request, and an anthropic+deepseek deployment
--    whose provider-error fallback or per-provider budget degrade excludes
--    DeepSeek. Observed: scripts run over ProviderRegistry.resolve /
--    resolveFallback for every site and capability, before and after this
--    migration, for provider sets {anthropic}, {deepseek}, {anthropic,deepseek}.
-- 4. Not added, with the reason:
--    - claude-mythos-5-1 / -5: limited availability (verification program), section 2.3.
--    - claude-opus-5, -4-7, -4-6, -4-5, claude-sonnet-4-5: legacy or deprecated, section 2.3.
--    - gpt-5.6-sol: "promotional pricing ... through November 21, 2026"; the price
--      after it is not on the page (section 4.1).
--    - gpt-5.6-terra, gpt-5.6-luna: their long-context rates are unverified
--      (section 12); the higher tier cannot be recorded, so the price is incomplete.
--    - gpt-5.3-codex: deprecated (section 4.1).
--    - grok-build-0.1: "early access" (section 4.3).
--    - mistral-large-2512, mistral-small-2603, codestral-2508: already present
--      as their -latest alias rows (021).
--    - sections 5-8 (Chinese providers): no provider_configs row and no provider
--      wiring in the gateway exists for them.

-- ---------------------------------------------------------------------------
-- Removed.
-- ---------------------------------------------------------------------------

-- section 4.3 / 10 / 12: "not on the models page, not on the retirement list";
-- price and status unverified. Its 0.30 / 0.50 was 002's seed value.
DELETE FROM model_configs WHERE model_id = 'grok-3-mini';

-- ---------------------------------------------------------------------------
-- Existing rows.
-- ---------------------------------------------------------------------------

-- section 4.2 / 10: the > 200K tier (2.50 / 15.00, read 0.25) replaces the <= 200K rate 021 kept.
UPDATE model_configs SET input_cost_per_1m = 2.50, output_cost_per_1m = 15.00, cache_read_cost_per_1m = 0.25,
    updated_at = NOW()
  WHERE model_id = 'gemini-2-5-pro';

-- sections 4.1 / 4.2: the API ids are dotted. A NULL api_model_id sends model_id
-- itself, which names no OpenAI or Google model ("gpt-4-1", "gemini-2-5-pro").
UPDATE model_configs SET api_model_id = 'gpt-4.1', updated_at = NOW() WHERE model_id = 'gpt-4-1';
UPDATE model_configs SET api_model_id = 'gpt-4.1-mini', updated_at = NOW() WHERE model_id = 'gpt-4-1-mini';
UPDATE model_configs SET api_model_id = 'gemini-2.5-pro', updated_at = NOW() WHERE model_id = 'gemini-2-5-pro';
UPDATE model_configs SET api_model_id = 'gemini-2.5-flash', updated_at = NOW() WHERE model_id = 'gemini-2-5-flash';

-- ---------------------------------------------------------------------------
-- Added. model_id is the API id as the investigation records it; api_model_id is
-- NULL, so the gateway sends model_id.
-- ---------------------------------------------------------------------------

INSERT INTO model_configs (model_id, provider_name, api_model_id, capability, input_cost_per_1m, output_cost_per_1m,
    cache_read_cost_per_1m, cache_write_cost_per_1m, max_context_tokens)
VALUES
  -- section 2.3: Active (latest). Cache write is the 5-minute TTL rate, as in 021.
  -- Unpositioned: Strong, one below claude-fable-5 (Frontier).
  ('claude-fable-5-1', 'anthropic', NULL, 'Strong', 10.00, 50.00, 0.25, 12.50, 1000000),
  -- section 2.3: Active (latest); Fast mode is a separate opt-in rate Ashara never requests.
  -- Unpositioned: Strong, one below claude-opus-4-8 (Frontier).
  ('claude-opus-5-5', 'anthropic', NULL, 'Strong', 4.00, 20.00, 0.20, 5.00, 1000000),
  -- section 2.3: Active (latest); prompt > 100K tier. section 11: Light.
  ('claude-haiku-5-5', 'anthropic', NULL, 'Light', 0.50, 2.50, 0.05, 0.625, 1000000),

  -- section 4.1: "current flagship"; section 11 maps provider flagship positioning to Frontier.
  ('gpt-6-astra', 'openai', NULL, 'Frontier', 20.00, 75.00, 2.00, 25.00, 1050000),
  -- section 4.1: current; canonical id gpt-6.1-sol vs gpt-6-sol unverified (section 12),
  -- the pricing page's id is used. section 11: Frontier.
  ('gpt-6.1-sol', 'openai', NULL, 'Frontier', 4.00, 15.00, 0.20, 5.00, 1050000),
  -- section 4.1: current. section 11: Light.
  ('gpt-6-luna', 'openai', NULL, 'Light', 0.20, 0.75, 0.02, 0.25, 1050000),

  -- section 4.2: Preview. Unpositioned: Strong, one below gemini-2-5-pro (Frontier).
  ('gemini-3.1-pro-preview', 'google', NULL, 'Strong', 4.00, 18.00, 0.40, NULL, 1048576),
  -- section 4.2: Stable. Unpositioned: Medium, one below gemini-2-5-flash (Strong).
  ('gemini-3.8-flash', 'google', NULL, 'Medium', 1.50, 7.50, 0.15, NULL, 1048576),
  ('gemini-3.6-flash', 'google', NULL, 'Medium', 1.50, 7.50, 0.15, NULL, 1048576),
  -- section 4.2: Stable. section 11: Strong.
  ('gemini-3.5-flash-lite', 'google', NULL, 'Strong', 0.30, 2.50, 0.03, NULL, 1048576),
  -- section 4.2: shutdown 2027-05-07. Unpositioned: Medium, one below gemini-3.5-flash-lite (Strong).
  ('gemini-3.1-flash-lite', 'google', NULL, 'Medium', 0.25, 1.50, 0.025, NULL, 1048576),

  -- section 4.3: current flagship. section 11: Frontier.
  ('grok-4.7', 'xai', NULL, 'Frontier', 4.00, 12.00, 1.00, NULL, 500000),
  -- section 4.3: current. section 11: Strong.
  ('grok-4.3', 'xai', NULL, 'Strong', 2.50, 5.00, 0.40, NULL, 1000000),
  -- section 4.3: on the models page, priced as grok-4.3. Unpositioned: Medium, one below grok-4.3.
  ('grok-4.20-0309-reasoning', 'xai', NULL, 'Medium', 2.50, 5.00, 0.40, NULL, 1000000),
  ('grok-4.20-0309-non-reasoning', 'xai', NULL, 'Medium', 2.50, 5.00, 0.40, NULL, 1000000),

  -- section 4.4: Public Preview, list price. section 11: Frontier.
  ('mistral-large-4', 'mistral', NULL, 'Frontier', 1.36, 4.18, 0.14, NULL, 1000000),
  -- section 4.4: GA. Unpositioned: Medium, one below mistral-large-latest (Strong).
  -- "256K" is written as 256000, the smaller reading (as in 021).
  ('mistral-medium-3-5', 'mistral', NULL, 'Medium', 1.50, 7.50, 0.15, NULL, 256000),
  -- section 4.4: GA. section 11: Light.
  ('ministral-3b-2512', 'mistral', NULL, 'Light', 0.10, 0.10, 0.01, NULL, 256000);
