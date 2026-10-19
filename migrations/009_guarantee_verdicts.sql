-- Every terminal message (the delivered report, a halt's report, the client's stop report) carries
-- the guarantee table judged from one sweep's evidence, and persists one verdict row per guarantee
-- of the vision version that evidence was recorded against: what run-report and the trust record
-- read, never the prose. A verdict is pass, fail or unjudged; an unjudged one names why, and only
-- an unjudged one does. A pass rests on executed evidence only, so a review's reading of the checks
-- never stands behind one. Append-only: a row leaves only with its report.

CREATE TABLE public.guarantee_verdicts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    report_id uuid NOT NULL,
    sweep_id uuid NOT NULL,
    vision_version integer NOT NULL,
    guarantee_id text NOT NULL,
    verdict text NOT NULL,
    reason text,
    basis text NOT NULL,
    evidence_class text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guarantee_verdicts_vision_version_check CHECK ((vision_version >= 1)),
    CONSTRAINT guarantee_verdicts_guarantee_id_check CHECK ((guarantee_id <> ''::text)),
    CONSTRAINT guarantee_verdicts_verdict_known CHECK ((verdict = ANY (ARRAY['pass'::text, 'fail'::text, 'unjudged'::text]))),
    CONSTRAINT guarantee_verdicts_reason_known CHECK (((reason IS NULL) OR (reason = ANY (ARRAY[
        'no-executed-evidence'::text, 'review-only'::text, 'stored-data-unjudged'::text, 'not-checkable-as-written'::text,
        'lowered-by-review'::text, 'out-of-scope-of-run'::text, 'no-sweep-on-commit'::text])))),
    CONSTRAINT guarantee_verdicts_reason_when_unjudged CHECK (((verdict = 'unjudged'::text) = (reason IS NOT NULL))),
    CONSTRAINT guarantee_verdicts_basis_known CHECK ((basis = ANY (ARRAY['client-stated'::text, 'assumed-unconfirmed'::text, 'derived'::text]))),
    CONSTRAINT guarantee_verdicts_evidence_class_known CHECK ((evidence_class = ANY (ARRAY['witness'::text, 'implementer-visible'::text, 'review-only'::text, 'none'::text]))),
    CONSTRAINT guarantee_verdicts_pass_executed CHECK (((verdict <> 'pass'::text) OR (evidence_class = ANY (ARRAY['witness'::text, 'implementer-visible'::text]))))
);

ALTER TABLE ONLY public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_one_per_report UNIQUE (report_id, guarantee_id);

ALTER TABLE ONLY public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.guarantee_verdicts
    ADD CONSTRAINT guarantee_verdicts_sweep_id_fkey FOREIGN KEY (sweep_id) REFERENCES public.acceptance_sweeps(id) ON DELETE CASCADE;

CREATE FUNCTION public.guarantee_verdicts_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'guarantee_verdicts is append-only: UPDATE refused (row %, report %, guarantee %)', OLD.id, OLD.report_id, OLD.guarantee_id;
END;
$$;

CREATE TRIGGER guarantee_verdicts_append_only BEFORE UPDATE ON public.guarantee_verdicts FOR EACH ROW EXECUTE FUNCTION public.guarantee_verdicts_refuse_update();

-- The client's stop report is written once the stop's terminal sweep is recorded, so it carries
-- that sweep's table. The stop that moved its project to 'stopped' records whether Delivery had the
-- project halted then (stop_found_halted), which the report states; null on every other row. A stop
-- recorded before this column existed was answered at once and is marked by its report instead.

ALTER TABLE public.client_messages
    ADD COLUMN stop_found_halted boolean,
    ADD CONSTRAINT client_messages_stop_found_halted_on_stop CHECK (((stop_found_halted IS NULL) OR (((direction)::text = 'inbound'::text) AND ((kind)::text = 'stop'::text))));
