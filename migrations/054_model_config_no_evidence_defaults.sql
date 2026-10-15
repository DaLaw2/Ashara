-- Migration 054: a model's prices and context window have no column default (ADR-080 d3, group F9;
-- story s-legacy-review-ddd-shape, task t-ddd-fix-config-evidence-defaults).
--
-- 001_initial.sql gave input_cost_per_1m and output_cost_per_1m DEFAULT 0 and max_context_tokens
-- DEFAULT 128000. An insert that forgot a price then wrote a free model, which the spend cap never
-- counts, and one that forgot the window wrote a size nobody measured. Both are evidence defaults:
-- absence answered a question about the model. Every existing writer (migrations 002, 021, 026, 047)
-- names all three columns, so dropping the defaults changes no row; from here on an insert that omits
-- one fails on NOT NULL.

ALTER TABLE model_configs ALTER COLUMN input_cost_per_1m DROP DEFAULT;
ALTER TABLE model_configs ALTER COLUMN output_cost_per_1m DROP DEFAULT;
ALTER TABLE model_configs ALTER COLUMN max_context_tokens DROP DEFAULT;
