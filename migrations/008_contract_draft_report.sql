-- Intake posts one contract draft per project with vision v1: the interface, the guarantees with
-- their basis, the assumptions each rests on and the exclusions. It is an outbound report on its own
-- subject, 'contract-draft', so the unique index on (project_id, reports_on) admits one per project.

ALTER TABLE public.client_messages DROP CONSTRAINT client_messages_reports_on_known;
ALTER TABLE public.client_messages
    ADD CONSTRAINT client_messages_reports_on_known CHECK (
        reports_on IS NULL
        OR (
            direction = 'outbound'
            AND kind = 'report'
            AND reports_on IN ('first-plan', 'planning-stopped', 'client-stop', 'stack-choice', 'contract-draft')
        )
    );
