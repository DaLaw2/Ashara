-- reviewer_outcomes (Quality): one row per piece of later evidence about one reviewer's verdict, so each
-- reviewer model's record can be measured: a pass that a witness later contradicted, a finding later
-- witnessed or refuted. The verdict is a suite review claim or judgement, or an intake reading
-- (verdict_kind, verdict_id); the reviewer is the first review or the second opinion of it (reviewer_role)
-- and the model that answered as it (reviewer_model, "provider/model"). evidence_ref names the row the
-- evidence is: a check dispute, an acceptance sweep, or a re-authored check revision ("<task id>#<revision>").
-- One row per verdict, reviewer and piece of evidence: a writer that runs again writes nothing new.
-- Append-only: a row is never changed, and leaves only with its project.

CREATE TABLE public.reviewer_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    verdict_kind text NOT NULL,
    verdict_id uuid NOT NULL,
    reviewer_model text NOT NULL,
    reviewer_role text NOT NULL,
    outcome text NOT NULL,
    evidence_kind text NOT NULL,
    evidence_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviewer_outcomes_verdict_kind_known CHECK ((verdict_kind = ANY (ARRAY['claim'::text, 'judgement'::text, 'intake-reading'::text]))),
    CONSTRAINT reviewer_outcomes_reviewer_role_known CHECK ((reviewer_role = ANY (ARRAY['first'::text, 'second'::text]))),
    CONSTRAINT reviewer_outcomes_outcome_known CHECK ((outcome = ANY (ARRAY['pass-contradicted'::text, 'finding-witnessed'::text, 'finding-refuted'::text]))),
    CONSTRAINT reviewer_outcomes_evidence_kind_known CHECK ((evidence_kind = ANY (ARRAY['dispute-upheld'::text, 'acceptance-failed'::text, 'check-reauthored'::text, 'replay'::text, 'operator-probe'::text]))),
    -- A failing check or an upheld dispute is a witness against a pass; it never refutes a finding.
    CONSTRAINT reviewer_outcomes_refuted_by_reading CHECK (((outcome <> 'finding-refuted'::text) OR (evidence_kind = ANY (ARRAY['check-reauthored'::text, 'replay'::text, 'operator-probe'::text])))),
    CONSTRAINT reviewer_outcomes_reviewer_model_check CHECK ((length(reviewer_model) > 0)),
    CONSTRAINT reviewer_outcomes_evidence_ref_check CHECK ((length(evidence_ref) > 0))
);

ALTER TABLE ONLY public.reviewer_outcomes
    ADD CONSTRAINT reviewer_outcomes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.reviewer_outcomes
    ADD CONSTRAINT reviewer_outcomes_one_per_evidence UNIQUE (verdict_kind, verdict_id, reviewer_role, evidence_kind, evidence_ref);

ALTER TABLE ONLY public.reviewer_outcomes
    ADD CONSTRAINT reviewer_outcomes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX reviewer_outcomes_project ON public.reviewer_outcomes USING btree (project_id, created_at);

-- A delete is refused while the row's project still exists: the cascade from its project's removal is
-- the only way a row leaves.
CREATE FUNCTION public.reviewer_outcomes_refuse_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'reviewer_outcomes is append-only: % refused (outcome % of % %, reviewer %)', TG_OP, OLD.id, OLD.verdict_kind, OLD.verdict_id, OLD.reviewer_role;
END;
$$;

CREATE TRIGGER reviewer_outcomes_append_only BEFORE UPDATE OR DELETE ON public.reviewer_outcomes FOR EACH ROW EXECUTE FUNCTION public.reviewer_outcomes_refuse_change();
