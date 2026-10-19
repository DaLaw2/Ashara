-- Every revision of a project's contract after vision v1 is recorded: who wrote it (author: the client,
-- from the change or answer message it names, or Ashara, from none), who approved it (approver: the
-- client, or nobody yet), which way it moved what Ashara promises (direction), why (cause), its typed
-- operations (ops) and, when the Liaison held it for the client's confirmation, the pushback it gave.
-- An applied revision names the version it wrote; a proposed one wrote none and waits, never refused.
-- A client's change message is read by a model like an answer, so its failed reading attempts are
-- counted on it as an answer's are.

CREATE TABLE public.vision_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    based_on_version integer NOT NULL,
    version integer,
    author text NOT NULL,
    approver text,
    direction text NOT NULL,
    cause text NOT NULL,
    source_message_id uuid,
    confirmed_by_message_id uuid,
    ops jsonb NOT NULL,
    pushback jsonb,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vision_revisions_pkey PRIMARY KEY (id),
    CONSTRAINT vision_revisions_project_version_unique UNIQUE (project_id, version),
    CONSTRAINT vision_revisions_author_known CHECK ((author = ANY (ARRAY['client'::text, 'ashara'::text]))),
    CONSTRAINT vision_revisions_approver_known CHECK (((approver IS NULL) OR (approver = 'client'::text))),
    CONSTRAINT vision_revisions_direction_known CHECK ((direction = ANY (ARRAY['widens'::text, 'narrows'::text, 'neutral'::text]))),
    CONSTRAINT vision_revisions_cause_known CHECK ((cause = ANY (ARRAY['client-change'::text, 'misread'::text, 'ashara-decision'::text]))),
    CONSTRAINT vision_revisions_status_known CHECK ((status = ANY (ARRAY['applied'::text, 'proposed'::text]))),
    CONSTRAINT vision_revisions_ops_listed CHECK (((jsonb_typeof(ops) = 'array'::text) AND (jsonb_array_length(ops) > 0))),
    CONSTRAINT vision_revisions_pushback_object CHECK (((pushback IS NULL) OR (jsonb_typeof(pushback) = 'object'::text))),
    -- A client's revision names the message it was read from; Ashara's names none.
    CONSTRAINT vision_revisions_client_source CHECK (((author = 'client'::text) = (source_message_id IS NOT NULL))),
    CONSTRAINT vision_revisions_ashara_decides CHECK (((author = 'ashara'::text) = (cause = 'ashara-decision'::text))),
    CONSTRAINT vision_revisions_applied_version CHECK (((status = 'applied'::text) = (version IS NOT NULL))),
    CONSTRAINT vision_revisions_version_after_base CHECK (((version IS NULL) OR (version > based_on_version))),
    -- Only the client approves: by writing the change, or by confirming a proposal.
    CONSTRAINT vision_revisions_client_approves CHECK ((
        (approver IS NOT DISTINCT FROM 'client'::text)
        = ((status = 'applied'::text) AND ((author = 'client'::text) OR (confirmed_by_message_id IS NOT NULL)))
    )),
    CONSTRAINT vision_revisions_confirmed_applied CHECK (((confirmed_by_message_id IS NULL) OR (status = 'applied'::text))),
    -- A client's change is held only with the pushback that held it.
    CONSTRAINT vision_revisions_client_held_with_pushback CHECK (((status = 'applied'::text) OR (author = 'ashara'::text) OR (pushback IS NOT NULL))),
    CONSTRAINT vision_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT vision_revisions_based_on_fkey FOREIGN KEY (project_id, based_on_version) REFERENCES public.vision_documents(project_id, version) ON DELETE CASCADE,
    CONSTRAINT vision_revisions_version_fkey FOREIGN KEY (project_id, version) REFERENCES public.vision_documents(project_id, version) ON DELETE CASCADE,
    CONSTRAINT vision_revisions_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES public.client_messages(id) ON DELETE CASCADE,
    CONSTRAINT vision_revisions_confirmed_by_message_id_fkey FOREIGN KEY (confirmed_by_message_id) REFERENCES public.client_messages(id) ON DELETE CASCADE
);

CREATE INDEX vision_revisions_proposed ON public.vision_revisions USING btree (project_id, created_at) WHERE (status = 'proposed'::text);

ALTER TABLE public.client_messages
    DROP CONSTRAINT client_messages_intake_last_failure_known,
    DROP CONSTRAINT client_messages_intake_tender_or_answer_only,
    ADD CONSTRAINT client_messages_intake_last_failure_known CHECK (((intake_last_failure IS NULL) OR ((intake_last_failure = ANY (ARRAY['model'::text, 'provider'::text])) AND ((kind)::text = ANY (ARRAY['answer'::text, 'change'::text])) AND (intake_attempts > 0)))),
    ADD CONSTRAINT client_messages_intake_read_kinds_only CHECK ((((kind)::text = ANY (ARRAY['tender'::text, 'answer'::text, 'change'::text])) OR ((intake_attempts = 0) AND (intake_last_error IS NULL))));
