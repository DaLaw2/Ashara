-- A client's correction applied to a planned project (a change message's revision, a confirmed
-- proposal, or an answer that changed an assumption) holds only the work it touches: one row per
-- applied revision, naming the guarantee and assumption keys it affects. The tasks citing one of them
-- are held, and the project's other work goes on dispatching; the plan revision that replaces the held
-- work is recorded on the row, which releases it. The project-wide request it replaces is dropped.

CREATE TABLE public.correction_holds (
    project_id uuid NOT NULL,
    vision_version integer NOT NULL,
    requested_by uuid NOT NULL,
    affected text[] NOT NULL,
    plan_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT correction_holds_pkey PRIMARY KEY (project_id, vision_version),
    CONSTRAINT correction_holds_affected_listed CHECK ((cardinality(affected) > 0)),
    CONSTRAINT correction_holds_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT correction_holds_revision_fkey FOREIGN KEY (project_id, vision_version) REFERENCES public.vision_revisions(project_id, version) ON DELETE CASCADE,
    CONSTRAINT correction_holds_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.client_messages(id) ON DELETE CASCADE,
    CONSTRAINT correction_holds_plan_revision_id_fkey FOREIGN KEY (plan_revision_id) REFERENCES public.plan_revisions(id) ON DELETE CASCADE
);

CREATE INDEX correction_holds_pending ON public.correction_holds USING btree (project_id) WHERE (plan_revision_id IS NULL);

-- An answer still awaiting its revision is carried over as the hold of the revision record it wrote.
INSERT INTO public.correction_holds (project_id, vision_version, requested_by, affected, created_at)
SELECT carried.project_id, carried.version, carried.answer_id, carried.affected, carried.created_at
FROM (
    SELECT rr.project_id, vr.version, rr.answer_id, rr.created_at,
           ARRAY(SELECT op->>'key' FROM jsonb_array_elements(vr.ops) op
                 WHERE op->>'target' IN ('guarantee', 'assumption') AND op->>'key' IS NOT NULL) AS affected
    FROM public.replan_requests rr
    JOIN public.vision_revisions vr ON vr.project_id = rr.project_id AND vr.source_message_id = rr.answer_id AND vr.status = 'applied'
    WHERE rr.plan_revision_id IS NULL
) carried
WHERE cardinality(carried.affected) > 0;

-- One with no revision record names no key to hold: an active project awaiting it is not migrated
-- past, since releasing its dispatch would plan nothing for the client's change.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.replan_requests rr JOIN public.projects p ON p.id = rr.project_id
        WHERE rr.plan_revision_id IS NULL AND p.lifecycle = 'active'
          AND NOT EXISTS (SELECT 1 FROM public.correction_holds h WHERE h.project_id = rr.project_id AND h.requested_by = rr.answer_id)
    ) THEN
        RAISE EXCEPTION 'an active project awaits a plan revision for a client answer that wrote no vision_revisions row; revise or stop it before this migration';
    END IF;
END $$;

DROP TABLE public.replan_requests;
