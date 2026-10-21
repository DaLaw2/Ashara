-- Each report the Liaison tells the client is recorded on Engagement's side, keyed by the subject it
-- tells of, behind the primary key: a halt episode ('project-blocked'), its resumption
-- ('project-resumed'), a passed acceptance sweep ('delivered') or a plan revision ('plan-revision').
-- The record is written in the transaction that posts the report, so a retried or concurrent post
-- tells the client once. A message may tell several subjects: a first-plan report tells every
-- revision written before it.

CREATE TABLE public.told_reports (
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    project_id uuid NOT NULL,
    report_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT told_reports_pkey PRIMARY KEY (subject_kind, subject_id),
    CONSTRAINT told_reports_subject_kind_known CHECK ((subject_kind = ANY (ARRAY['project-blocked'::text, 'project-resumed'::text, 'delivered'::text, 'plan-revision'::text]))),
    CONSTRAINT told_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT told_reports_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id) ON DELETE CASCADE
);

CREATE INDEX told_reports_report ON public.told_reports USING btree (report_id);

-- The failed attempts at a passed sweep's delivered report: how many, the failed reads of the public
-- interface file and the records that did not read as a report each counted apart, the last error,
-- and when it is tried again. Engagement's record of its own retries.

CREATE TABLE public.delivered_report_attempts (
    sweep_id uuid NOT NULL,
    project_id uuid NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    interface_read_failures integer DEFAULT 0 NOT NULL,
    record_failures integer DEFAULT 0 NOT NULL,
    last_error text,
    retry_at timestamp with time zone,
    CONSTRAINT delivered_report_attempts_pkey PRIMARY KEY (sweep_id),
    CONSTRAINT delivered_report_attempts_failures_check CHECK ((failures >= 0)),
    CONSTRAINT delivered_report_attempts_interface_read_failures_check CHECK ((interface_read_failures >= 0)),
    CONSTRAINT delivered_report_attempts_record_failures_check CHECK ((record_failures >= 0)),
    CONSTRAINT delivered_report_attempts_sweep_id_fkey FOREIGN KEY (sweep_id) REFERENCES public.acceptance_sweeps(id) ON DELETE CASCADE,
    CONSTRAINT delivered_report_attempts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);

-- Every subject already told keeps its report, so none is told again.

INSERT INTO public.told_reports (subject_kind, subject_id, project_id, report_id, created_at)
SELECT 'project-blocked', b.id, b.project_id, b.report_id, m.created_at
  FROM public.project_blocks b JOIN public.client_messages m ON m.id = b.report_id;

INSERT INTO public.told_reports (subject_kind, subject_id, project_id, report_id, created_at)
SELECT 'project-resumed', b.id, b.project_id, b.resumed_report_id, m.created_at
  FROM public.project_blocks b JOIN public.client_messages m ON m.id = b.resumed_report_id;

INSERT INTO public.told_reports (subject_kind, subject_id, project_id, report_id, created_at)
SELECT 'delivered', s.id, s.project_id, s.report_id, m.created_at
  FROM public.acceptance_sweeps s JOIN public.client_messages m ON m.id = s.report_id;

INSERT INTO public.told_reports (subject_kind, subject_id, project_id, report_id, created_at)
SELECT 'plan-revision', r.id, r.project_id, r.report_id, m.created_at
  FROM public.plan_revisions r JOIN public.client_messages m ON m.id = r.report_id;

INSERT INTO public.delivered_report_attempts (sweep_id, project_id, failures, interface_read_failures, record_failures, last_error, retry_at)
SELECT s.id, s.project_id, s.report_failures, s.report_interface_read_failures, s.report_record_failures, s.report_last_error, s.report_retry_at
  FROM public.acceptance_sweeps s
 WHERE s.report_failures > 0 OR s.report_interface_read_failures > 0 OR s.report_record_failures > 0
    OR s.report_last_error IS NOT NULL OR s.report_retry_at IS NOT NULL;

-- The columns other contexts kept the told record in. acceptance_sweeps_terminal_of names report_id,
-- so it is dropped with it and stated again without it.

ALTER TABLE public.acceptance_sweeps DROP CONSTRAINT acceptance_sweeps_terminal_of;

ALTER TABLE public.acceptance_sweeps
    DROP COLUMN report_id,
    DROP COLUMN report_failures,
    DROP COLUMN report_interface_read_failures,
    DROP COLUMN report_last_error,
    DROP COLUMN report_retry_at,
    DROP COLUMN report_record_failures;

ALTER TABLE public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_terminal_of CHECK (
        CASE purpose
            WHEN 'terminal' THEN ((stop_id IS NULL) <> (block_id IS NULL))
                AND NOT passed
                AND defect_item_id IS NULL
            ELSE stop_id IS NULL AND block_id IS NULL
        END
    );

ALTER TABLE public.project_blocks
    DROP COLUMN report_id,
    DROP COLUMN resumed_report_id;

ALTER TABLE public.plan_revisions DROP COLUMN report_id;

-- The client's stop ends a halt it finds through Delivery's own write, called in the stop's
-- transaction; project_halt_consistent, deferred to the commit, refuses a stop that leaves it open.

DROP TRIGGER projects_stop_ends_halt ON public.projects;
DROP FUNCTION public.project_stop_ends_halt();
