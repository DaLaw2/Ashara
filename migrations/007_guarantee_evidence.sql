-- Every sweep of main records the outcome of each stored check it ran, passed, failed or not run
-- (check_outcomes, each {taskCheckId, taskId, name, command, outcome}: the command as it ran), and one guarantee_evidence row per guarantee of the
-- vision version in force when it was recorded, a guarantee no check decides included with an empty
-- checks list, so absence is recorded as absence and never as a missing row. check_outcomes replaces
-- executed_checks, which held only the checks a passed sweep saw pass. A row written before
-- check_outcomes existed holds none.
--
-- A sweep is an acceptance sweep, or a terminal one: the same commands-only sweep run once when a
-- project reaches a terminal short of acceptance, the client's stop (stop_id, the consumed stop) or a
-- halt (block_id, its project_blocks episode). A terminal sweep judges no acceptance: it is never
-- passed, opens no defect and is reported on by no delivered report. One terminal sweep per stop and
-- per halt episode.

ALTER TABLE public.acceptance_sweeps
    ADD COLUMN purpose text DEFAULT 'acceptance'::text NOT NULL,
    ADD COLUMN stop_id uuid,
    ADD COLUMN block_id uuid,
    ADD COLUMN check_outcomes jsonb;

ALTER TABLE public.acceptance_sweeps
    DROP CONSTRAINT acceptance_sweeps_defect_on_failure,
    ADD CONSTRAINT acceptance_sweeps_defect_on_failure CHECK ((purpose = 'terminal'::text) OR (passed = (defect_item_id IS NULL))),
    ADD CONSTRAINT acceptance_sweeps_purpose_known CHECK ((purpose = ANY (ARRAY['acceptance'::text, 'terminal'::text]))),
    ADD CONSTRAINT acceptance_sweeps_terminal_of CHECK (
        CASE purpose
            WHEN 'terminal' THEN ((stop_id IS NULL) <> (block_id IS NULL))
                AND NOT passed
                AND defect_item_id IS NULL
                AND report_id IS NULL
            ELSE stop_id IS NULL AND block_id IS NULL
        END
    ),
    ADD CONSTRAINT acceptance_sweeps_check_outcomes_check CHECK (((check_outcomes IS NULL) OR (jsonb_typeof(check_outcomes) = 'array'::text))),
    ADD CONSTRAINT acceptance_sweeps_one_per_stop UNIQUE (stop_id),
    ADD CONSTRAINT acceptance_sweeps_one_per_block UNIQUE (block_id),
    ADD CONSTRAINT acceptance_sweeps_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.client_messages(id) ON DELETE CASCADE,
    ADD CONSTRAINT acceptance_sweeps_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.project_blocks(id) ON DELETE CASCADE;

ALTER TABLE public.acceptance_sweeps DROP COLUMN executed_checks;

-- One guarantee's evidence on one sweep: each stored check deciding it, with its outcome on the sweep
-- and its evidence class, and whether a review left the guarantee undecided (review_lowers).
-- main_commit is the sweep's, null when the sweep ran on no commit, which then holds no check.
-- Append-only: a row leaves only with its sweep.

CREATE TABLE public.guarantee_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    sweep_id uuid NOT NULL,
    vision_version integer NOT NULL,
    guarantee_id text NOT NULL,
    main_commit text,
    checks jsonb NOT NULL,
    review_lowers boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guarantee_evidence_vision_version_check CHECK ((vision_version >= 1)),
    CONSTRAINT guarantee_evidence_guarantee_id_check CHECK ((guarantee_id <> ''::text)),
    CONSTRAINT guarantee_evidence_main_commit_check CHECK ((main_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text)),
    CONSTRAINT guarantee_evidence_checks_check CHECK ((jsonb_typeof(checks) = 'array'::text)),
    CONSTRAINT guarantee_evidence_no_commit_no_check CHECK (((main_commit IS NOT NULL) OR (checks = '[]'::jsonb)))
);

ALTER TABLE ONLY public.guarantee_evidence
    ADD CONSTRAINT guarantee_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.guarantee_evidence
    ADD CONSTRAINT guarantee_evidence_one_per_sweep UNIQUE (sweep_id, guarantee_id);

ALTER TABLE ONLY public.guarantee_evidence
    ADD CONSTRAINT guarantee_evidence_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.guarantee_evidence
    ADD CONSTRAINT guarantee_evidence_sweep_id_fkey FOREIGN KEY (sweep_id) REFERENCES public.acceptance_sweeps(id) ON DELETE CASCADE;

CREATE FUNCTION public.guarantee_evidence_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'guarantee_evidence is append-only: UPDATE refused (row %, sweep %, guarantee %)', OLD.id, OLD.sweep_id, OLD.guarantee_id;
END;
$$;

CREATE TRIGGER guarantee_evidence_append_only BEFORE UPDATE ON public.guarantee_evidence FOR EACH ROW EXECUTE FUNCTION public.guarantee_evidence_refuse_update();
