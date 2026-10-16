-- Migration 068: the work ledger's verification reserve and its early warning (ADR-084 addendum 1
-- decisions 6 and 7).
--
-- project_blocks.work gains reserveRequests, the requests of the project's budget only verification
-- and acceptance may draw, and reserveProtected, true when the refused request was upstream work and
-- only the reserve was left. A work ledger recorded before this migration was read with no reserve,
-- so it is stated as one of 0 that protected nothing.
--
-- work_burn_warnings (Engagement): one row per zone of the work ledger's fever chart a project
-- entered in one plan revision, with the figures it was decided on: the requests the project had
-- drawn (every llm_calls row of it), its budget (the policy default plus the owner's grants), the
-- reserve in it and what its upstream work may draw (the rest), and the revision's implementation
-- tasks planned and completed. report_id is the Liaison's one report of it to the client;
-- operator_report the text the operator is told, on the red zone only. The primary key makes each
-- zone once per project and plan revision, whatever restarts between cycles.

UPDATE project_blocks
SET work = work || '{"reserveRequests": 0, "reserveProtected": false}'::jsonb
WHERE work IS NOT NULL AND NOT (work ? 'reserveRequests');

CREATE TABLE work_burn_warnings (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  zone TEXT NOT NULL CHECK (zone IN ('yellow', 'red')),
  drawn_requests INTEGER NOT NULL CHECK (drawn_requests >= 0),
  budget_requests INTEGER NOT NULL CHECK (budget_requests > 0),
  reserve_requests INTEGER NOT NULL CHECK (reserve_requests >= 0 AND reserve_requests < budget_requests),
  upstream_requests INTEGER NOT NULL CHECK (upstream_requests = budget_requests - reserve_requests),
  planned_tasks INTEGER NOT NULL CHECK (planned_tasks >= 0),
  completed_tasks INTEGER NOT NULL CHECK (completed_tasks >= 0 AND completed_tasks <= planned_tasks),
  report_id UUID NOT NULL REFERENCES client_messages(id),
  operator_report TEXT CHECK ((zone = 'red') = (operator_report IS NOT NULL AND length(trim(operator_report)) > 0)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, plan_revision, zone)
);
