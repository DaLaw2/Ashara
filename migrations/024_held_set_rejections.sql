-- A check set that holds whole on its plan's foundation and is rejected because the records do not
-- show what it decides held before is recorded with the reason's kind and the items it is about, so
-- identical rejections of a task, and of the tasks an earlier plan wrote for the same items, are
-- counted from records and give the task up at the held-set rule's bound, across restarts and
-- across the plan revisions that plan the same items again.

CREATE TABLE public.held_set_rejections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    checked_task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    attempt integer NOT NULL,
    reason text NOT NULL,
    items text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT held_set_rejections_pkey PRIMARY KEY (id),
    CONSTRAINT held_set_rejections_one_per_attempt UNIQUE (check_task_id, attempt),
    CONSTRAINT held_set_rejections_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT held_set_rejections_checked_task_id_fkey FOREIGN KEY (checked_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE,
    CONSTRAINT held_set_rejections_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE,
    CONSTRAINT held_set_rejections_reason_check CHECK (reason IN ('uncited', 'uncorrected', 'partly-corrected', 'undelivered', 'assumption-undecided')),
    CONSTRAINT held_set_rejections_items_check CHECK ((cardinality(items) > 0) = (reason <> 'uncited'))
);

CREATE INDEX held_set_rejections_identical ON public.held_set_rejections USING btree (project_id, reason, items);
