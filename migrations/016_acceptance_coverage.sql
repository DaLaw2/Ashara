-- A project whose acceptance sweep passed but leaves a guarantee Ashara can verify unjudged is not
-- accepted: it halts on its own kind, 'acceptance_uncovered', recorded on its block episode and as
-- its blocked category, never as Ashara's fault.

ALTER TABLE public.project_blocks
    DROP CONSTRAINT project_blocks_kind_check,
    ADD CONSTRAINT project_blocks_kind_check CHECK ((kind = ANY (ARRAY['budget_cap'::text, 'configuration'::text, 'fault'::text, 'planning_stopped'::text, 'check_dispute'::text, 'replan_bound'::text, 'suite_review'::text, 'plan_repair'::text, 'infrastructure'::text, 'replan_stopped'::text, 'replan_provider_failed'::text, 'model_failed'::text, 'provider_failed'::text, 'work_budget'::text, 'acceptance_uncovered'::text])));

ALTER TABLE public.projects
    DROP CONSTRAINT projects_blocked_category_known,
    ADD CONSTRAINT projects_blocked_category_known CHECK (((blocked_category IS NULL) OR (blocked_category = ANY (ARRAY['budget_cap'::text, 'configuration'::text, 'fault'::text, 'check_dispute'::text, 'replan_bound'::text, 'suite_review'::text, 'plan_repair'::text, 'infrastructure'::text, 'replan_stopped'::text, 'replan_provider_failed'::text, 'model_failed'::text, 'provider_failed'::text, 'work_budget'::text, 'acceptance_uncovered'::text]))));

-- A guarantee the contract marks not verifiable by Ashara (told to the client when it was proposed)
-- is never judged: its verdict is unjudged, naming that, and it lies outside what acceptance requires.

ALTER TABLE public.guarantee_verdicts
    DROP CONSTRAINT guarantee_verdicts_reason_known,
    ADD CONSTRAINT guarantee_verdicts_reason_known CHECK (((reason IS NULL) OR (reason = ANY (ARRAY[
        'not-verifiable-by-ashara'::text, 'no-executed-evidence'::text, 'review-only'::text, 'stored-data-unjudged'::text,
        'not-checkable-as-written'::text, 'lowered-by-review'::text, 'out-of-scope-of-run'::text, 'no-sweep-on-commit'::text]))));
