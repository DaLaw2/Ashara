-- Migration 015: llm_calls, one row per provider call made by the server
-- (story s-cost-ledger-m1, architecture K10, Finance context per ADR-075).
--
-- Every token and cost column is nullable with no default: NULL means the
-- provider did not report the value, so it was not measured. Writing 0 for an
-- unknown value would read as "free", which is the identity-element defect.

CREATE TABLE llm_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID,
  call_site TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd NUMERIC(12, 6),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  error_kind TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((outcome = 'error') = (error_kind IS NOT NULL))
);

CREATE INDEX idx_llm_calls_project_created ON llm_calls(project_id, created_at);
