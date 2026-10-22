-- The projects row holds the tender's identity, its workspace and Engagement's lifecycle. Delivery's
-- planning record moves to its own per-project table, Quality's count of acceptance sweeps that could
-- not run to its own, and the halt's cause lives only on its episode.

CREATE TABLE public.project_plans (
    project_id uuid NOT NULL,
    plan_attempts integer DEFAULT 0 NOT NULL,
    plan_last_error text,
    first_planned_at timestamp with time zone,
    plan_stopped_at timestamp with time zone,
    plan_dropped_dependencies jsonb,
    replan_attempts integer DEFAULT 0 NOT NULL,
    replan_last_error text,
    replan_last_failure text,
    CONSTRAINT project_plans_pkey PRIMARY KEY (project_id),
    CONSTRAINT project_plans_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT project_plans_plan_attempts_check CHECK ((plan_attempts >= 0)),
    CONSTRAINT project_plans_plan_error_recorded CHECK (((plan_attempts = 0) OR (plan_last_error IS NOT NULL))),
    CONSTRAINT project_plans_plan_outcome_single CHECK (((first_planned_at IS NULL) OR (plan_stopped_at IS NULL))),
    CONSTRAINT project_plans_dropped_dependencies_planned CHECK (((plan_dropped_dependencies IS NULL) OR ((first_planned_at IS NOT NULL) AND (jsonb_typeof(plan_dropped_dependencies) = 'array'::text)))),
    CONSTRAINT project_plans_replan_attempts_check CHECK ((replan_attempts >= 0)),
    CONSTRAINT project_plans_replan_failure_recorded CHECK (((replan_attempts = 0) OR (replan_last_error IS NOT NULL))),
    CONSTRAINT project_plans_replan_last_failure_known CHECK (((replan_last_failure IS NULL) OR ((replan_last_failure = ANY (ARRAY['model'::text, 'provider'::text])) AND (replan_attempts > 0))))
);

INSERT INTO public.project_plans (project_id, plan_attempts, plan_last_error, first_planned_at, plan_stopped_at,
    plan_dropped_dependencies, replan_attempts, replan_last_error, replan_last_failure)
SELECT id, plan_attempts, plan_last_error, first_planned_at, plan_stopped_at,
    plan_dropped_dependencies, replan_attempts, replan_last_error, replan_last_failure
FROM public.projects;

-- The halt's cause moves onto its open episode: an episode that does not carry its error class and
-- reason takes them from the projects row before those columns go. A halt the copy leaves without a
-- cause the rewritten trigger would refuse is refused here, by project, before anything is dropped.
UPDATE public.project_blocks b
SET error_class = COALESCE(b.error_class, p.blocked_error_class),
    reason = COALESCE(b.reason, p.blocked_reason)
FROM public.projects p
WHERE p.id = b.project_id
  AND b.ended_at IS NULL
  AND b.kind <> 'planning_stopped'
  AND (b.error_class IS NULL OR b.reason IS NULL);

DO $$
DECLARE
  uncaused TEXT;
BEGIN
  SELECT string_agg(b.project_id::text || ' (' || b.kind || ')', ', ' ORDER BY b.project_id) INTO uncaused
  FROM public.project_blocks b
  WHERE b.ended_at IS NULL
    AND ((b.kind <> 'planning_stopped' AND (b.error_class IS NULL OR b.reason IS NULL))
      OR (b.kind = 'planning_stopped' AND NOT EXISTS (
        SELECT 1 FROM public.project_plans pp WHERE pp.project_id = b.project_id AND pp.plan_stopped_at IS NOT NULL)));
  IF uncaused IS NOT NULL THEN
    RAISE EXCEPTION 'halted projects whose cause is on neither their open episode nor their projects row: %', uncaused;
  END IF;
END;
$$;

CREATE TABLE public.acceptance_sweep_faults (
    project_id uuid NOT NULL,
    faults integer NOT NULL,
    CONSTRAINT acceptance_sweep_faults_pkey PRIMARY KEY (project_id),
    CONSTRAINT acceptance_sweep_faults_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    CONSTRAINT acceptance_sweep_faults_counted CHECK ((faults > 0))
);

INSERT INTO public.acceptance_sweep_faults (project_id, faults)
SELECT id, acceptance_faults FROM public.projects WHERE acceptance_faults > 0;

-- A halt is its open episode. An active project is halted only with its cause on that episode: a
-- first planning that gave up (planning_stopped, with plan_stopped_at on the planning record), or any
-- other kind with its error class and reason. Planning stopped on an active project is always halted,
-- and planning stops only on a project that is active or that the client stopped.
CREATE OR REPLACE FUNCTION public.project_halt_consistent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target UUID;
  project_lifecycle TEXT;
  planning_stopped BOOLEAN;
  episode RECORD;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    target := NEW.id;
  ELSE
    target := NEW.project_id;
  END IF;
  SELECT p.lifecycle INTO project_lifecycle FROM projects p WHERE p.id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  planning_stopped := EXISTS (SELECT 1 FROM project_plans pp WHERE pp.project_id = target AND pp.plan_stopped_at IS NOT NULL);
  IF planning_stopped AND project_lifecycle NOT IN ('active', 'stopped') THEN
    RAISE EXCEPTION 'project % records its first planning stopped while its lifecycle is %: planning stops only while active or stopped', target, project_lifecycle;
  END IF;
  SELECT b.kind, b.error_class, b.reason INTO episode FROM project_blocks b WHERE b.project_id = target AND b.ended_at IS NULL;
  IF FOUND THEN
    IF project_lifecycle <> 'active' THEN
      RAISE EXCEPTION 'project % is halted while its lifecycle is %: only an active project is halted', target, project_lifecycle;
    END IF;
    IF episode.kind = 'planning_stopped' AND NOT planning_stopped THEN
      RAISE EXCEPTION 'project % is halted on planning_stopped while its planning record has no plan_stopped_at', target;
    END IF;
    IF episode.kind <> 'planning_stopped' AND (episode.error_class IS NULL OR episode.reason IS NULL) THEN
      RAISE EXCEPTION 'project % is halted on % with no cause recorded on its episode', target, episode.kind;
    END IF;
  ELSIF project_lifecycle = 'active' AND planning_stopped THEN
    RAISE EXCEPTION 'project % records its first planning stopped but has no open block episode', target;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER project_plans_halt_consistent AFTER INSERT OR UPDATE ON public.project_plans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.project_halt_consistent();

ALTER TABLE public.projects
    DROP CONSTRAINT projects_acceptance_faults_check,
    DROP CONSTRAINT projects_blocked_category_known,
    DROP CONSTRAINT projects_blocked_category_with_cause,
    DROP CONSTRAINT projects_blocked_cause_lifecycle,
    DROP CONSTRAINT projects_blocked_cause_whole,
    DROP CONSTRAINT projects_plan_attempts_check,
    DROP CONSTRAINT projects_plan_dropped_dependencies_planned,
    DROP CONSTRAINT projects_plan_error_recorded,
    DROP CONSTRAINT projects_plan_outcome_single,
    DROP CONSTRAINT projects_plan_stopped_lifecycle,
    DROP CONSTRAINT projects_replan_failure_recorded,
    DROP CONSTRAINT projects_replan_last_failure_known,
    DROP COLUMN plan_attempts,
    DROP COLUMN plan_last_error,
    DROP COLUMN first_planned_at,
    DROP COLUMN plan_stopped_at,
    DROP COLUMN plan_dropped_dependencies,
    DROP COLUMN blocked_error_class,
    DROP COLUMN blocked_reason,
    DROP COLUMN blocked_category,
    DROP COLUMN replan_attempts,
    DROP COLUMN replan_last_error,
    DROP COLUMN replan_last_failure,
    DROP COLUMN acceptance_faults;

DROP TABLE public.system_settings;
