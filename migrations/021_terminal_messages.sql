-- Every terminal message the client is sent carries the guarantee table and is told once of its
-- subject. A contract in which Ashara can verify no guarantee is declined by one such message, an
-- outbound report on its own subject, 'declined', so the unique index on (project_id, reports_on)
-- admits one per project.

ALTER TABLE public.client_messages DROP CONSTRAINT client_messages_reports_on_known;
ALTER TABLE public.client_messages
    ADD CONSTRAINT client_messages_reports_on_known CHECK (
        reports_on IS NULL
        OR (
            direction = 'outbound'
            AND kind = 'report'
            AND reports_on IN ('first-plan', 'planning-stopped', 'client-stop', 'stack-choice', 'contract-draft', 'declined')
        )
    );

-- The inbound stop that moved its project to 'stopped' records whether the project was accepted then,
-- which its stop report states, as it records whether the project was halted; null on every other row,
-- and on a stop recorded before the column existed, whose report says it is not on record.

ALTER TABLE public.client_messages
    ADD COLUMN stop_found_accepted boolean,
    ADD CONSTRAINT client_messages_stop_found_accepted_on_stop CHECK (((stop_found_accepted IS NULL) OR (((direction)::text = 'inbound'::text) AND ((kind)::text = 'stop'::text))));

-- A verdict on no sweep judges nothing: it is unjudged for want of a sweep on a commit, or, for a
-- guarantee the contract marks not verifiable by Ashara, unjudged as not verifiable, as the client
-- was told when it was proposed.

ALTER TABLE public.guarantee_verdicts DROP CONSTRAINT guarantee_verdicts_no_sweep_unjudged;
ALTER TABLE public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_no_sweep_unjudged CHECK (((sweep_id IS NOT NULL) OR ((verdict = 'unjudged'::text) AND (reason = ANY (ARRAY['no-sweep-on-commit'::text, 'not-verifiable-by-ashara'::text])))));
