-- Migration 002: Seed model catalog into DB
-- Models previously lived in config/models.toml; this migration moves them to
-- the model_configs table so the catalog is DB-authoritative. Idempotent:
-- ON CONFLICT DO NOTHING on every INSERT.
--
-- Providers must exist first (model_configs.provider_name FK).

-- =============================================================================
-- Seed providers (name + type only; API keys are env-specific, seeded at runtime)
-- =============================================================================

INSERT INTO provider_configs (id, name, provider_type, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'anthropic',  'anthropic',        NOW(), NOW()),
  (gen_random_uuid(), 'openai',     'openai',           NOW(), NOW()),
  (gen_random_uuid(), 'deepseek',   'openai-compatible', NOW(), NOW()),
  (gen_random_uuid(), 'mistral',    'openai-compatible', NOW(), NOW()),
  (gen_random_uuid(), 'xai',        'openai-compatible', NOW(), NOW()),
  (gen_random_uuid(), 'google',     'openai-compatible', NOW(), NOW()),
  (gen_random_uuid(), 'local',      'openai-compatible', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- Seed model catalog
-- =============================================================================

-- Anthropic (Claude)
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'claude-fable-5',    'anthropic', NULL, 'Frontier', 'native-fc', false, 10.0,  50.0,  1000000, true,  NOW(), NOW()),
  (gen_random_uuid(), 'claude-opus-4-8',   'anthropic', NULL, 'Frontier', 'native-fc', false, 5.0,   25.0,  1000000, true,  NOW(), NOW()),
  (gen_random_uuid(), 'claude-sonnet-5',   'anthropic', NULL, 'Strong',   'native-fc', false, 3.0,   15.0,  1000000, true,  NOW(), NOW()),
  (gen_random_uuid(), 'claude-sonnet-4-6', 'anthropic', NULL, 'Strong',   'native-fc', false, 3.0,   15.0,  1000000, true,  NOW(), NOW()),
  (gen_random_uuid(), 'claude-haiku-4-5',  'anthropic', NULL, 'Medium',   'native-fc', false, 1.0,   5.0,   200000,  true,  NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- OpenAI
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'gpt-4-1',      'openai', NULL, 'Strong',   'native-fc', false, 2.0,  8.0,  1000000, false, NOW(), NOW()),
  (gen_random_uuid(), 'gpt-4-1-mini', 'openai', NULL, 'Medium',   'native-fc', false, 0.4,  1.6,  1000000, false, NOW(), NOW()),
  (gen_random_uuid(), 'gpt-4-1-nano', 'openai', NULL, 'Light',    'native-fc', false, 0.1,  0.4,  1000000, false, NOW(), NOW()),
  (gen_random_uuid(), 'o3',           'openai', NULL, 'Frontier',  'native-fc', false, 2.0,  8.0,  200000,  false, NOW(), NOW()),
  (gen_random_uuid(), 'o4-mini',      'openai', NULL, 'Strong',   'native-fc', false, 1.1,  4.4,  200000,  false, NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- DeepSeek
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'deepseek-v4-flash', 'deepseek', 'deepseek-v4-flash', 'Strong',   'native-fc', true,  0.14,  0.28, 1000000, true,  NOW(), NOW()),
  (gen_random_uuid(), 'deepseek-v4-pro',   'deepseek', 'deepseek-v4-pro',   'Frontier', 'native-fc', true,  0.435, 0.87, 1000000, true,  NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- Google Gemini
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'gemini-2-5-pro',   'google', NULL, 'Frontier', 'code-fence', false, 1.25, 10.0, 1000000, false, NOW(), NOW()),
  (gen_random_uuid(), 'gemini-2-5-flash', 'google', NULL, 'Strong',   'code-fence', false, 0.3,  2.5,  1000000, false, NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- Mistral
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'mistral-large-latest', 'mistral', NULL, 'Strong', 'native-fc',  false, 2.0, 6.0, 128000, false, NOW(), NOW()),
  (gen_random_uuid(), 'mistral-small-latest', 'mistral', NULL, 'Light',  'code-fence', false, 0.1, 0.3, 128000, false, NOW(), NOW()),
  (gen_random_uuid(), 'codestral-latest',     'mistral', NULL, 'Medium', 'native-fc',  false, 0.3, 0.9, 32000,  false, NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- xAI (Grok)
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'grok-3',      'xai', NULL, 'Strong', 'native-fc', false, 2.0, 10.0, 131000, false, NOW(), NOW()),
  (gen_random_uuid(), 'grok-3-mini', 'xai', NULL, 'Medium', 'native-fc', false, 0.3, 0.5,  131000, false, NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;

-- Local models
INSERT INTO model_configs (id, model_id, provider_name, api_model_id, capability, format_group, strict_mode, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'qwen3.6-27b',       'local', NULL, 'Strong', 'native-fc',  false, 0, 0, 32768, false, NOW(), NOW()),
  (gen_random_uuid(), 'qwen3.5-4b',        'local', NULL, 'Medium', 'code-fence', false, 0, 0, 8192,  false, NOW(), NOW()),
  (gen_random_uuid(), 'nemotron3-nano-4b',  'local', NULL, 'Medium', 'code-fence', false, 0, 0, 8192,  false, NOW(), NOW()),
  (gen_random_uuid(), 'gemma-4-e4b',        'local', NULL, 'Light',  'code-fence', false, 0, 0, 8192,  false, NOW(), NOW())
ON CONFLICT (model_id) DO NOTHING;
