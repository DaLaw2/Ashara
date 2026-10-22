-- A project whose only work left waits on the client's answer to a task's question halts on its own
-- kind, 'client_wait', and the client's answer ends it ('answered'), with what was answered recorded
-- as the resume evidence; no other halt ends so.

ALTER TABLE public.project_blocks
    DROP CONSTRAINT project_blocks_kind_check,
    ADD CONSTRAINT project_blocks_kind_check CHECK ((kind = ANY (ARRAY['budget_cap'::text, 'configuration'::text, 'fault'::text, 'planning_stopped'::text, 'check_dispute'::text, 'replan_bound'::text, 'suite_review'::text, 'plan_repair'::text, 'infrastructure'::text, 'replan_stopped'::text, 'replan_provider_failed'::text, 'model_failed'::text, 'provider_failed'::text, 'work_budget'::text, 'acceptance_uncovered'::text, 'client_wait'::text]))),
    DROP CONSTRAINT project_blocks_end_kind_check,
    ADD CONSTRAINT project_blocks_end_kind_check CHECK ((end_kind = ANY (ARRAY['unblocked'::text, 'client_stop'::text, 'probe_passed'::text, 'answered'::text]))),
    DROP CONSTRAINT project_blocks_probe_recorded,
    ADD CONSTRAINT project_blocks_probe_recorded CHECK (((end_kind = ANY (ARRAY['probe_passed'::text, 'answered'::text])) = (resume_evidence IS NOT NULL))),
    ADD CONSTRAINT project_blocks_answer_ends_client_wait CHECK (((end_kind IS DISTINCT FROM 'answered'::text) OR (kind = 'client_wait'::text)));
