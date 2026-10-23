-- A terminal sweep that could not run is retried in later cycles, and its faults are counted per
-- terminal (the client's consumed stop, or a halt episode), durably, so the bound on its retries
-- outlives a restart. Only the fault past the bound is recorded as the terminal's sweep, with no check
-- run and why; until then the stop's or the halt's report waits for it.

CREATE TABLE public.terminal_sweep_faults (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    stop_id uuid,
    block_id uuid,
    faults integer NOT NULL,
    CONSTRAINT terminal_sweep_faults_pkey PRIMARY KEY (id),
    CONSTRAINT terminal_sweep_faults_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT terminal_sweep_faults_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.client_messages(id) ON DELETE CASCADE,
    CONSTRAINT terminal_sweep_faults_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.project_blocks(id) ON DELETE CASCADE,
    CONSTRAINT terminal_sweep_faults_one_terminal CHECK (((stop_id IS NULL) <> (block_id IS NULL))),
    CONSTRAINT terminal_sweep_faults_counted CHECK ((faults > 0)),
    CONSTRAINT terminal_sweep_faults_one_per_stop UNIQUE (stop_id),
    CONSTRAINT terminal_sweep_faults_one_per_block UNIQUE (block_id)
);
