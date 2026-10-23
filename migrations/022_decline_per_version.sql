-- A contract Ashara declines is declined once per vision version, not once per project: a client who
-- restates it into one Ashara can verify, and is later made unverifiable again, is told the second
-- decline too. The decline records the vision version it declines (reports_on_version), which no
-- other report carries; every other subject stays one report per project.

ALTER TABLE public.client_messages
    ADD COLUMN reports_on_version integer;

-- A decline written before the column existed declines the version in force when it was posted.
UPDATE public.client_messages m
    SET reports_on_version = (
        SELECT max(v.version) FROM public.vision_documents v
        WHERE v.project_id = m.project_id AND v.created_at <= m.created_at
    )
    WHERE m.reports_on = 'declined';

-- A decline always names its version, and nothing else names one; a decline with no version on record
-- before it fails this migration rather than read as the project's one decline.
ALTER TABLE public.client_messages
    ADD CONSTRAINT client_messages_reports_on_version_declined CHECK (
        (reports_on_version IS NOT NULL) = COALESCE(reports_on = 'declined', false)
    );

DROP INDEX public.client_messages_one_report_per_outcome;
CREATE UNIQUE INDEX client_messages_one_report_per_outcome ON public.client_messages USING btree (project_id, reports_on)
    WHERE (reports_on IS NOT NULL AND reports_on_version IS NULL);
CREATE UNIQUE INDEX client_messages_one_report_per_version ON public.client_messages USING btree (project_id, reports_on, reports_on_version)
    WHERE (reports_on_version IS NOT NULL);
