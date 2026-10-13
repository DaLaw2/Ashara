-- Migration 023: remove claude-sonnet-5 (story s-model-catalog-refresh, task t-cost-null-gaps).
--
-- 021 priced claude-sonnet-5 (legacy) and claude-sonnet-5-5 (current) at the
-- same 2 / 10 and the same capability, Strong. ConfigRepository.listModelConfigs
-- breaks equal-price ties by model_id, so capability routing picked the legacy
-- row. docs/investigations/llm-models-prices-2026-10-13.md section 2.1 / 2.3:
-- claude-sonnet-5 is "Active (legacy)", released 2026-06-30; claude-sonnet-5-5
-- is "Active (latest)", released 2026-09-28, at the same input / output price
-- and a lower cache read (0.10 against 0.20). No code, config/models.toml
-- profile or test names claude-sonnet-5, so the row is removed rather than
-- ordered behind its successor by a new column.
--
-- llm_calls.model is free text with no foreign key: rows already recorded
-- against claude-sonnet-5 keep their model name and cost.

DELETE FROM model_configs WHERE model_id = 'claude-sonnet-5';
