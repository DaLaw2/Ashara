-- Every status change of a work item, with the blocked reason it wrote, recorded by a trigger in the
-- statement that changes it: whatever writes the status, the record commits with the change or not at
-- all. A verdict about starts and reopens reads it; domain_events is published after the commit and
-- may lose a row.

CREATE TABLE public.work_item_transitions (
    id bigint GENERATED ALWAYS AS IDENTITY,
    work_item_id uuid NOT NULL,
    from_status text NOT NULL,
    to_status text NOT NULL,
    blocked_reason jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_item_transitions_pkey PRIMARY KEY (id),
    CONSTRAINT work_item_transitions_changes_status CHECK ((from_status <> to_status)),
    CONSTRAINT work_item_transitions_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE CASCADE
);

CREATE INDEX work_item_transitions_work_item ON public.work_item_transitions USING btree (work_item_id, created_at);

CREATE FUNCTION public.work_item_transition_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO public.work_item_transitions (work_item_id, from_status, to_status, blocked_reason)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.blocked_reason);
    RETURN NULL;
END;
$$;

CREATE TRIGGER work_item_transition_recorded AFTER UPDATE OF status ON public.work_items
    FOR EACH ROW WHEN ((OLD.status IS DISTINCT FROM NEW.status)) EXECUTE FUNCTION public.work_item_transition_record();
