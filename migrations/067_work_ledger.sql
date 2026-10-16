-- Migration 067: one work ledger bounds the model requests of every task and every project
-- (ADR-084 decision 1).
--
-- The unit is one model request: one llm_calls row, written when Finance admits the request and
-- before it is sent. The requests a task or a project has drawn are counted from those rows, every
-- state included (pending, recorded, unmeasured_after_crash), so no refund of a dispatch, no
-- operator unblock and no restart returns a request; nothing decrements a counter, since none exists.
--
-- work_grants: the owner's explicit grant of more model requests to one project, the only way a
-- project's work budget grows past its policy default. Append-only; a project's budget is the
-- default plus the sum of its grants.
--
-- idx_llm_calls_task: a task's drawn requests are counted on every request it sends.
--
-- project_blocks.work: on a work_budget halt, the ledger as Finance read it when it refused the
-- request: {"scope", "budgetRequests", "grantedRequests", "spentRequests", "inFlightRequests",
-- "bySite": [{"callSite", "requests"}]}, so the client's and the operator's report name the budget,
-- what was drawn against it and which call sites drew it. NULL on every other kind.
--
-- work_budget: a project halted because its model requests are spent. Its exit is the owner's
-- grant (scripts/project.ts grant) followed by the operator's unblock.

CREATE TABLE work_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requests INTEGER NOT NULL CHECK (requests > 0),
  granted_by TEXT NOT NULL CHECK (length(trim(granted_by)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_work_grants_project ON work_grants (project_id);

CREATE INDEX idx_llm_calls_task ON llm_calls (task_id) WHERE task_id IS NOT NULL;

ALTER TABLE project_blocks ADD COLUMN work jsonb;
ALTER TABLE project_blocks ADD CONSTRAINT project_blocks_work_only_work_budget CHECK (work IS NULL OR kind = 'work_budget');

ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed', 'model_failed', 'provider_failed', 'work_budget')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped', 'replan_provider_failed', 'model_failed', 'provider_failed', 'work_budget')
  );
