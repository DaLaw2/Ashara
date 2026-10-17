-- The schema every Ashara database starts from, and the reference data the runtime reads: the
-- provider and model catalog with its time-of-day price windows and prompt-length price tiers.
-- A later schema change is a new numbered file beside this one; an applied file never changes.


CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE FUNCTION public.check_disputes_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'check_disputes is append-only (dispute % of check task %)', OLD.id, OLD.check_task_id;
END;
$$;

CREATE FUNCTION public.check_set_freezes_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'check_set_freezes is append-only (review task %)', OLD.review_task_id;
END;
$$;

CREATE FUNCTION public.dependency_same_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  from_project UUID;
  to_project UUID;
BEGIN
  SELECT project_id INTO from_project FROM work_items WHERE id = NEW.from_id;
  SELECT project_id INTO to_project FROM work_items WHERE id = NEW.to_id;
  IF from_project IS DISTINCT FROM to_project THEN
    RAISE EXCEPTION 'dependency % -> % crosses projects (% -> %)', NEW.from_id, NEW.to_id, from_project, to_project;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_ashara_events() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('ashara_events', NEW.event_id::text);
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_client_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify(
    'ashara_events',
    json_build_object('type', 'client_message', 'project_id', NEW.project_id, 'message_id', NEW.id)::text
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.plan_repair_on_abandon() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'Abandoned' AND OLD.status <> 'Abandoned' AND NEW.level = 'Task'
     AND NEW.project_id IS NOT NULL AND NEW.blocked_reason->>'source' IS DISTINCT FROM 'superseded' THEN
    INSERT INTO plan_repairs (work_item_id, project_id) VALUES (NEW.id, NEW.project_id)
      ON CONFLICT (work_item_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.project_acceptance_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.lifecycle = 'accepted' AND OLD.lifecycle IS DISTINCT FROM 'accepted'
     AND NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.project_id = NEW.id AND s.passed) THEN
    RAISE EXCEPTION 'project % cannot become accepted: no passed acceptance sweep is recorded for it', NEW.id;
  END IF;
  IF OLD.lifecycle = 'accepted' AND NEW.lifecycle NOT IN ('accepted', 'stopped') THEN
    RAISE EXCEPTION 'project % cannot leave accepted for %: only the client''s stop ends it', NEW.id, NEW.lifecycle;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.project_halt_consistent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target UUID;
  project RECORD;
  halted BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    target := NEW.id;
  ELSE
    target := NEW.project_id;
  END IF;
  SELECT p.lifecycle, p.plan_stopped_at, p.blocked_error_class INTO project FROM projects p WHERE p.id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  halted := EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = target AND b.ended_at IS NULL);
  IF halted AND project.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'project % is halted while its lifecycle is %: only an active project is halted', target, project.lifecycle;
  END IF;
  IF halted AND project.plan_stopped_at IS NULL AND project.blocked_error_class IS NULL THEN
    RAISE EXCEPTION 'project % is halted with no cause recorded: neither planning stopped nor a blocked cause', target;
  END IF;
  IF NOT halted AND project.lifecycle = 'active' AND (project.plan_stopped_at IS NOT NULL OR project.blocked_error_class IS NOT NULL) THEN
    RAISE EXCEPTION 'project % records a halt''s cause but has no open block episode', target;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.project_stop_ends_halt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.lifecycle = 'stopped' AND OLD.lifecycle IS DISTINCT FROM 'stopped' THEN
    UPDATE project_blocks SET ended_at = now(), end_kind = 'client_stop'
      WHERE project_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.roster_roles_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'roster_roles is append-only: a changed roster is a new revision (project %, revision %, role %)',
    OLD.project_id, OLD.revision, OLD.role_id;
END;
$$;

CREATE FUNCTION public.suite_review_claims_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_claims is append-only (claim % of review task %)', OLD.id, OLD.review_task_id;
END;
$$;

CREATE FUNCTION public.suite_review_findings_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_findings is append-only (finding % of check task %)', OLD.id, OLD.check_task_id;
END;
$$;

CREATE FUNCTION public.suite_review_judgements_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_judgements is append-only (judgement % of review task %)', OLD.id, OLD.review_task_id;
END;
$$;

CREATE FUNCTION public.task_checks_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'task_checks is append-only: changed checks are a new revision (task %, revision %, check %)',
    OLD.task_id, OLD.revision, OLD.name;
END;
$$;

CREATE FUNCTION public.undecided_item_claims_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'undecided_item_claims is append-only (item % of check task %, claim %)', OLD.item_id, OLD.check_task_id, OLD.claim_id;
END;
$$;

CREATE FUNCTION public.undecided_items_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'undecided_items is append-only (item % of check task %)', OLD.item_id, OLD.check_task_id;
END;
$$;

CREATE TABLE public.acceptance_sweeps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    main_commit text,
    environment_version text,
    checked_tasks jsonb NOT NULL,
    unchecked_tasks jsonb NOT NULL,
    passed boolean NOT NULL,
    details text NOT NULL,
    defect_item_id uuid,
    report_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    report_failures integer DEFAULT 0 NOT NULL,
    report_interface_read_failures integer DEFAULT 0 NOT NULL,
    report_last_error text,
    report_retry_at timestamp with time zone,
    report_record_failures integer DEFAULT 0 NOT NULL,
    executed_checks jsonb,
    CONSTRAINT acceptance_sweeps_checked_tasks_check CHECK ((jsonb_typeof(checked_tasks) = 'array'::text)),
    CONSTRAINT acceptance_sweeps_defect_on_failure CHECK ((passed = (defect_item_id IS NULL))),
    CONSTRAINT acceptance_sweeps_details_check CHECK ((details <> ''::text)),
    CONSTRAINT acceptance_sweeps_environment_version_check CHECK ((environment_version <> ''::text)),
    CONSTRAINT acceptance_sweeps_executed_checks_check CHECK (((executed_checks IS NULL) OR (jsonb_typeof(executed_checks) = 'array'::text))),
    CONSTRAINT acceptance_sweeps_main_commit_check CHECK ((main_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text)),
    CONSTRAINT acceptance_sweeps_pass_has_environment CHECK (((NOT passed) OR (environment_version IS NOT NULL))),
    CONSTRAINT acceptance_sweeps_pass_has_main CHECK (((NOT passed) OR (main_commit IS NOT NULL))),
    CONSTRAINT acceptance_sweeps_report_failures_check CHECK ((report_failures >= 0)),
    CONSTRAINT acceptance_sweeps_report_interface_read_failures_check CHECK ((report_interface_read_failures >= 0)),
    CONSTRAINT acceptance_sweeps_report_on_pass CHECK (((report_id IS NULL) OR passed)),
    CONSTRAINT acceptance_sweeps_report_record_failures_check CHECK ((report_record_failures >= 0)),
    CONSTRAINT acceptance_sweeps_unchecked_tasks_check CHECK ((jsonb_typeof(unchecked_tasks) = 'array'::text))
);

CREATE TABLE public.check_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    revision integer NOT NULL,
    check_name text NOT NULL,
    reason text NOT NULL,
    evidence text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_disputes_check_name_check CHECK ((btrim(check_name) <> ''::text)),
    CONSTRAINT check_disputes_not_self CHECK ((task_id <> check_task_id)),
    CONSTRAINT check_disputes_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT check_disputes_revision_check CHECK ((revision >= 1))
);

CREATE TABLE public.check_set_freezes (
    review_task_id uuid NOT NULL,
    project_id uuid NOT NULL,
    frozen_by uuid NOT NULL,
    check_set jsonb NOT NULL,
    frozen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_set_freezes_check_set_check CHECK ((jsonb_typeof(check_set) = 'array'::text))
);

CREATE TABLE public.client_login_failures (
    client_name text NOT NULL,
    failed_at timestamp with time zone DEFAULT now() NOT NULL,
    source_address text NOT NULL,
    CONSTRAINT client_login_failures_source_address_check CHECK ((length(source_address) > 0))
);

CREATE TABLE public.client_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    direction character varying(10) NOT NULL,
    kind character varying(10) NOT NULL,
    body text NOT NULL,
    in_reply_to uuid,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    intake_attempts integer DEFAULT 0 NOT NULL,
    intake_last_error text,
    reports_on character varying(20),
    "position" integer,
    intake_last_failure text,
    CONSTRAINT client_messages_answer_replies CHECK ((((kind)::text <> 'answer'::text) OR (in_reply_to IS NOT NULL))),
    CONSTRAINT client_messages_body_check CHECK ((length(body) > 0)),
    CONSTRAINT client_messages_direction_check CHECK ((direction IN ('inbound', 'outbound'))),
    CONSTRAINT client_messages_direction_kind CHECK (((((direction)::text = 'inbound'::text) AND (kind IN ('tender', 'answer', 'change', 'stop'))) OR (((direction)::text = 'outbound'::text) AND (kind IN ('question', 'report'))))),
    CONSTRAINT client_messages_intake_attempts_check CHECK ((intake_attempts >= 0)),
    CONSTRAINT client_messages_intake_error_recorded CHECK (((intake_attempts = 0) OR (intake_last_error IS NOT NULL))),
    CONSTRAINT client_messages_intake_last_failure_known CHECK (((intake_last_failure IS NULL) OR ((intake_last_failure = ANY (ARRAY['model'::text, 'provider'::text])) AND ((kind)::text = 'answer'::text) AND (intake_attempts > 0)))),
    CONSTRAINT client_messages_intake_tender_or_answer_only CHECK (((kind IN ('tender', 'answer')) OR ((intake_attempts = 0) AND (intake_last_error IS NULL)))),
    CONSTRAINT client_messages_kind_check CHECK ((kind IN ('tender', 'answer', 'change', 'stop', 'question', 'report'))),
    CONSTRAINT client_messages_position_question_only CHECK ((("position" IS NULL) OR (((direction)::text = 'outbound'::text) AND ((kind)::text = 'question'::text) AND ("position" >= 1)))),
    CONSTRAINT client_messages_reports_on_known CHECK (((reports_on IS NULL) OR (((direction)::text = 'outbound'::text) AND ((kind)::text = 'report'::text) AND (reports_on IN ('first-plan', 'planning-stopped', 'client-stop', 'stack-choice')))))
);

CREATE TABLE public.client_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    client_id uuid NOT NULL,
    CONSTRAINT client_sessions_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT client_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clients_name_check CHECK ((length(name) > 0))
);

CREATE TABLE public.dependencies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dependencies_check CHECK ((from_id <> to_id))
);

CREATE TABLE public.dev_sessions (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    phase character varying(20) DEFAULT 'Preparing'::character varying NOT NULL,
    brief jsonb,
    verification_result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    environment_version text,
    attempt_prompt_digest text,
    attempt_terminal text,
    attempt_turns integer,
    attempt_provider text,
    attempt_model text,
    attempt_cell text,
    trace_id text,
    CONSTRAINT dev_sessions_attempt_cell_check CHECK ((attempt_cell = ANY (ARRAY['base-cell'::text, 'environment'::text]))),
    CONSTRAINT dev_sessions_attempt_cell_version CHECK (((attempt_cell IS NULL) OR ((attempt_cell = 'environment'::text) = (environment_version IS NOT NULL)))),
    CONSTRAINT dev_sessions_attempt_model_check CHECK ((attempt_model <> ''::text)),
    CONSTRAINT dev_sessions_attempt_prompt_digest_check CHECK ((attempt_prompt_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT dev_sessions_attempt_provider_check CHECK ((attempt_provider <> ''::text)),
    CONSTRAINT dev_sessions_attempt_terminal_check CHECK ((attempt_terminal = ANY (ARRAY['finished:done'::text, 'finished:blocked'::text, 'disputed'::text, 'model_stopped_without_finish'::text, 'output_truncated'::text, 'context_budget_exceeded'::text, 'turn_cap'::text, 'wall_clock'::text, 'transport_exhausted'::text, 'refused'::text, 'environment_failure'::text, 'cancelled'::text]))),
    CONSTRAINT dev_sessions_attempt_turns_check CHECK ((attempt_turns >= 0)),
    CONSTRAINT dev_sessions_attempt_whole CHECK ((num_nulls(attempt_prompt_digest, attempt_terminal, attempt_turns, attempt_provider, attempt_model, attempt_cell) = ANY (ARRAY[0, 6]))),
    CONSTRAINT dev_sessions_environment_version_digest CHECK (((environment_version IS NULL) OR (environment_version ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT dev_sessions_phase_check CHECK ((phase IN ('Preparing', 'Completed', 'Failed'))),
    CONSTRAINT dev_sessions_trace_id_nonempty CHECK (((trace_id IS NULL) OR (trace_id <> ''::text)))
);

CREATE TABLE public.domain_events (
    event_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    source_context character varying(50) NOT NULL,
    correlation_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.environment_builds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    version text NOT NULL,
    commit text NOT NULL,
    image_ref text NOT NULL,
    image_id text,
    status text NOT NULL,
    network text NOT NULL,
    log_digest text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT environment_builds_commit_check CHECK ((commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text)),
    CONSTRAINT environment_builds_image_id_check CHECK ((image_id ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT environment_builds_image_ref_check CHECK ((image_ref <> ''::text)),
    CONSTRAINT environment_builds_log_digest_check CHECK ((log_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT environment_builds_network_check CHECK ((network <> ''::text)),
    CONSTRAINT environment_builds_outcome_columns CHECK ((((status = 'succeeded'::text) AND (image_id IS NOT NULL) AND (error IS NULL)) OR ((status = 'failed'::text) AND (image_id IS NULL) AND (error IS NOT NULL) AND (error <> ''::text)))),
    CONSTRAINT environment_builds_status_check CHECK ((status = ANY (ARRAY['succeeded'::text, 'failed'::text]))),
    CONSTRAINT environment_builds_version_check CHECK ((version ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE public.failed_approaches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid,
    epic_id uuid,
    title text NOT NULL,
    failure_reason text NOT NULL,
    learned text DEFAULT ''::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid NOT NULL
);

CREATE TABLE public.intake_readings (
    project_id uuid NOT NULL,
    tender_id uuid NOT NULL,
    first_provider text NOT NULL,
    first_model text NOT NULL,
    first_questions integer NOT NULL,
    confirmation text NOT NULL,
    second_strength text,
    second_provider text,
    second_model text,
    second_questions integer,
    passed_over jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intake_readings_claim CHECK (((confirmation = 'not-needed'::text) = (first_questions > 0))),
    CONSTRAINT intake_readings_confirmation_known CHECK ((confirmation = ANY (ARRAY['not-needed'::text, 'confirmed'::text, 'questions-raised'::text, 'unconfirmed'::text]))),
    CONSTRAINT intake_readings_first_questions CHECK ((first_questions >= 0)),
    CONSTRAINT intake_readings_passed_over_list CHECK ((jsonb_typeof(passed_over) = 'array'::text)),
    CONSTRAINT intake_readings_second_answered CHECK ((((confirmation = ANY (ARRAY['confirmed'::text, 'questions-raised'::text])) = (second_strength IS NOT NULL)) AND ((second_strength IS NULL) = (second_provider IS NULL)) AND ((second_strength IS NULL) = (second_model IS NULL)) AND ((second_strength IS NULL) = (second_questions IS NULL)))),
    CONSTRAINT intake_readings_second_questions CHECK (((second_questions IS NULL) OR ((confirmation = 'questions-raised'::text) = (second_questions > 0)))),
    CONSTRAINT intake_readings_strength_fits CHECK (((second_strength IS NULL) OR (second_strength =
CASE
    WHEN (second_provider <> first_provider) THEN 'other-family'::text
    WHEN (second_model = first_model) THEN 'same-model'::text
    ELSE 'same-family-other-model'::text
END))),
    CONSTRAINT intake_readings_strength_known CHECK (((second_strength IS NULL) OR (second_strength = ANY (ARRAY['other-family'::text, 'same-family-other-model'::text, 'same-model'::text])))),
    CONSTRAINT intake_readings_unconfirmed_asked_every_strength CHECK (((confirmation <> 'unconfirmed'::text) OR (jsonb_array_length(passed_over) = 3)))
);

CREATE TABLE public.knowledge_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind character varying(20) NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source text NOT NULL,
    epic_id uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    event_time timestamp with time zone NOT NULL,
    freshness character varying(10) DEFAULT 'fresh'::character varying NOT NULL,
    source_task_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid NOT NULL,
    CONSTRAINT knowledge_entries_freshness_check CHECK ((freshness IN ('fresh', 'stale', 'archived'))),
    CONSTRAINT knowledge_entries_kind_check CHECK ((kind IN ('decision', 'finding', 'insight')))
);

CREATE TABLE public.llm_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    task_id uuid,
    call_site text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    cache_write_tokens integer,
    cost_usd numeric(20,12),
    outcome text,
    error_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finish_reason text,
    reasoning_tokens integer,
    estimated_cost_usd numeric(20,12),
    state text NOT NULL,
    context_window_tokens integer,
    trace_id text,
    CONSTRAINT llm_calls_check CHECK (((outcome = 'error'::text) = (error_kind IS NOT NULL))),
    CONSTRAINT llm_calls_context_window_positive CHECK (((context_window_tokens IS NULL) OR (context_window_tokens > 0))),
    CONSTRAINT llm_calls_estimated_cost_usd_check CHECK ((estimated_cost_usd > (0)::numeric)),
    CONSTRAINT llm_calls_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'error'::text]))),
    CONSTRAINT llm_calls_outcome_when_recorded CHECK (((state = 'recorded'::text) = (outcome IS NOT NULL))),
    CONSTRAINT llm_calls_reasoning_tokens_check CHECK ((reasoning_tokens >= 0)),
    CONSTRAINT llm_calls_spend_known CHECK (((cost_usd IS NOT NULL) OR (estimated_cost_usd IS NOT NULL))),
    CONSTRAINT llm_calls_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'recorded'::text, 'unmeasured_after_crash'::text]))),
    CONSTRAINT llm_calls_trace_id_nonempty CHECK (((trace_id IS NULL) OR (trace_id <> ''::text))),
    CONSTRAINT llm_calls_unrecorded_measures_nothing CHECK (((state = 'recorded'::text) OR ((cost_usd IS NULL) AND (error_kind IS NULL) AND (finish_reason IS NULL) AND (input_tokens IS NULL) AND (output_tokens IS NULL) AND (cache_read_tokens IS NULL) AND (cache_write_tokens IS NULL) AND (reasoning_tokens IS NULL))))
);

CREATE TABLE public.model_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id text NOT NULL,
    provider_name text NOT NULL,
    api_model_id text,
    capability text NOT NULL,
    input_cost_per_1m double precision NOT NULL,
    output_cost_per_1m double precision NOT NULL,
    max_context_tokens integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cache_read_cost_per_1m double precision,
    cache_write_cost_per_1m double precision,
    CONSTRAINT model_configs_cache_read_cost_per_1m_check CHECK (((cache_read_cost_per_1m IS NULL) OR (cache_read_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_configs_cache_write_cost_per_1m_check CHECK (((cache_write_cost_per_1m IS NULL) OR (cache_write_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_configs_capability_check CHECK ((capability = ANY (ARRAY['Frontier'::text, 'Strong'::text, 'Medium'::text, 'Light'::text])))
);

CREATE TABLE public.model_price_tiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id text NOT NULL,
    min_input_tokens integer NOT NULL,
    input_cost_per_1m double precision NOT NULL,
    output_cost_per_1m double precision NOT NULL,
    cache_read_cost_per_1m double precision,
    cache_write_cost_per_1m double precision,
    CONSTRAINT model_price_tiers_cache_read_cost_per_1m_check CHECK (((cache_read_cost_per_1m IS NULL) OR (cache_read_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_price_tiers_cache_write_cost_per_1m_check CHECK (((cache_write_cost_per_1m IS NULL) OR (cache_write_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_price_tiers_input_cost_per_1m_check CHECK ((input_cost_per_1m > (0)::double precision)),
    CONSTRAINT model_price_tiers_min_input_tokens_check CHECK ((min_input_tokens > 0)),
    CONSTRAINT model_price_tiers_output_cost_per_1m_check CHECK ((output_cost_per_1m > (0)::double precision))
);

CREATE TABLE public.model_price_windows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id text NOT NULL,
    iso_weekday smallint NOT NULL,
    utc_start_minute smallint NOT NULL,
    utc_end_minute smallint NOT NULL,
    input_cost_per_1m double precision NOT NULL,
    output_cost_per_1m double precision NOT NULL,
    cache_read_cost_per_1m double precision,
    cache_write_cost_per_1m double precision,
    CONSTRAINT model_price_windows_cache_read_cost_per_1m_check CHECK (((cache_read_cost_per_1m IS NULL) OR (cache_read_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_price_windows_cache_write_cost_per_1m_check CHECK (((cache_write_cost_per_1m IS NULL) OR (cache_write_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_price_windows_check CHECK ((utc_start_minute < utc_end_minute)),
    CONSTRAINT model_price_windows_input_cost_per_1m_check CHECK ((input_cost_per_1m > (0)::double precision)),
    CONSTRAINT model_price_windows_iso_weekday_check CHECK (((iso_weekday >= 1) AND (iso_weekday <= 7))),
    CONSTRAINT model_price_windows_output_cost_per_1m_check CHECK ((output_cost_per_1m > (0)::double precision)),
    CONSTRAINT model_price_windows_utc_end_minute_check CHECK ((utc_end_minute <= 1440)),
    CONSTRAINT model_price_windows_utc_start_minute_check CHECK ((utc_start_minute >= 0))
);

CREATE TABLE public.plan_repairs (
    work_item_id uuid NOT NULL,
    project_id uuid NOT NULL,
    plan_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.plan_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    revision integer NOT NULL,
    vision_version integer NOT NULL,
    requested_by uuid,
    summary jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    report_id uuid,
    kind text DEFAULT 'client_change'::text NOT NULL,
    CONSTRAINT plan_revisions_cause_recorded CHECK (((kind = 'client_change'::text) = (requested_by IS NOT NULL))),
    CONSTRAINT plan_revisions_kind_check CHECK ((kind = ANY (ARRAY['client_change'::text, 'repair'::text]))),
    CONSTRAINT plan_revisions_revision_check CHECK ((revision >= 2))
);

CREATE TABLE public.project_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL,
    error_class text,
    reason text,
    blocked_at timestamp with time zone DEFAULT now() NOT NULL,
    report_id uuid,
    ended_at timestamp with time zone,
    end_kind text,
    unblocked_by text,
    unblock_reason text,
    resumed_report_id uuid,
    resume_evidence text,
    spend jsonb,
    work jsonb,
    CONSTRAINT project_blocks_end_kind_check CHECK ((end_kind = ANY (ARRAY['unblocked'::text, 'client_stop'::text, 'probe_passed'::text]))),
    CONSTRAINT project_blocks_end_whole CHECK (((ended_at IS NULL) = (end_kind IS NULL))),
    CONSTRAINT project_blocks_kind_check CHECK ((kind = ANY (ARRAY['budget_cap'::text, 'configuration'::text, 'fault'::text, 'planning_stopped'::text, 'check_dispute'::text, 'replan_bound'::text, 'suite_review'::text, 'plan_repair'::text, 'infrastructure'::text, 'replan_stopped'::text, 'replan_provider_failed'::text, 'model_failed'::text, 'provider_failed'::text, 'work_budget'::text]))),
    CONSTRAINT project_blocks_probe_ends_infrastructure CHECK (((end_kind IS DISTINCT FROM 'probe_passed'::text) OR (kind = 'infrastructure'::text))),
    CONSTRAINT project_blocks_probe_recorded CHECK (((end_kind = 'probe_passed'::text) = (resume_evidence IS NOT NULL))),
    CONSTRAINT project_blocks_resumed_after_unblock CHECK (((resumed_report_id IS NULL) OR (end_kind = ANY (ARRAY['unblocked'::text, 'probe_passed'::text])))),
    CONSTRAINT project_blocks_spend_only_budget_cap CHECK (((spend IS NULL) OR (kind = 'budget_cap'::text))),
    CONSTRAINT project_blocks_unblock_recorded CHECK ((((end_kind = 'unblocked'::text) = ((unblocked_by IS NOT NULL) AND (unblock_reason IS NOT NULL))) OR ((end_kind IS NULL) AND (unblocked_by IS NULL) AND (unblock_reason IS NULL)))),
    CONSTRAINT project_blocks_work_only_work_budget CHECK (((work IS NULL) OR (kind = 'work_budget'::text)))
);

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    lifecycle character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_id uuid NOT NULL,
    plan_attempts integer DEFAULT 0 NOT NULL,
    plan_last_error text,
    first_planned_at timestamp with time zone,
    plan_stopped_at timestamp with time zone,
    workspace_path text,
    blocked_error_class text,
    blocked_reason text,
    plan_dropped_dependencies jsonb,
    blocked_category text,
    replan_attempts integer DEFAULT 0 NOT NULL,
    replan_last_error text,
    acceptance_faults integer DEFAULT 0 NOT NULL,
    replan_last_failure text,
    CONSTRAINT projects_acceptance_faults_check CHECK ((acceptance_faults >= 0)),
    CONSTRAINT projects_blocked_category_known CHECK (((blocked_category IS NULL) OR (blocked_category = ANY (ARRAY['budget_cap'::text, 'configuration'::text, 'fault'::text, 'check_dispute'::text, 'replan_bound'::text, 'suite_review'::text, 'plan_repair'::text, 'infrastructure'::text, 'replan_stopped'::text, 'replan_provider_failed'::text, 'model_failed'::text, 'provider_failed'::text, 'work_budget'::text])))),
    CONSTRAINT projects_blocked_category_with_cause CHECK (((blocked_category IS NULL) = (blocked_error_class IS NULL))),
    CONSTRAINT projects_blocked_cause_lifecycle CHECK (((blocked_reason IS NULL) OR (lifecycle IN ('active', 'stopped')))),
    CONSTRAINT projects_blocked_cause_whole CHECK (((blocked_error_class IS NULL) = (blocked_reason IS NULL))),
    CONSTRAINT projects_lifecycle_known CHECK ((lifecycle IN ('active', 'stopped', 'accepted'))),
    CONSTRAINT projects_plan_attempts_check CHECK ((plan_attempts >= 0)),
    CONSTRAINT projects_plan_dropped_dependencies_planned CHECK (((plan_dropped_dependencies IS NULL) OR ((first_planned_at IS NOT NULL) AND (jsonb_typeof(plan_dropped_dependencies) = 'array'::text)))),
    CONSTRAINT projects_plan_error_recorded CHECK (((plan_attempts = 0) OR (plan_last_error IS NOT NULL))),
    CONSTRAINT projects_plan_outcome_single CHECK (((first_planned_at IS NULL) OR (plan_stopped_at IS NULL))),
    CONSTRAINT projects_plan_stopped_lifecycle CHECK (((plan_stopped_at IS NULL) OR (lifecycle IN ('active', 'stopped')))),
    CONSTRAINT projects_replan_failure_recorded CHECK (((replan_attempts = 0) OR (replan_last_error IS NOT NULL))),
    CONSTRAINT projects_replan_last_failure_known CHECK (((replan_last_failure IS NULL) OR ((replan_last_failure = ANY (ARRAY['model'::text, 'provider'::text])) AND (replan_attempts > 0))))
);

CREATE TABLE public.provider_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    provider_type text NOT NULL,
    base_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.replan_requests (
    answer_id uuid NOT NULL,
    project_id uuid NOT NULL,
    plan_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.roster_roles (
    project_id uuid NOT NULL,
    revision integer NOT NULL,
    role_id uuid NOT NULL,
    name text NOT NULL,
    responsibility text NOT NULL,
    capabilities text[] NOT NULL,
    vision_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roster_roles_capabilities_check CHECK (((cardinality(capabilities) >= 1) AND (capabilities <@ ARRAY['client-comms'::text, 'write-source'::text, 'author-checks'::text, 'write-environment'::text]))),
    CONSTRAINT roster_roles_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT roster_roles_responsibility_check CHECK ((btrim(responsibility) <> ''::text)),
    CONSTRAINT roster_roles_revision_check CHECK ((revision >= 1))
);

CREATE TABLE public.secrets (
    name text NOT NULL,
    key_id text NOT NULL,
    iv bytea NOT NULL,
    ciphertext bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.step_faults (
    step text NOT NULL,
    subject_id text NOT NULL,
    project_id uuid NOT NULL,
    faults integer NOT NULL,
    last_error text NOT NULL,
    retry_at timestamp with time zone NOT NULL,
    parked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT step_faults_faults_check CHECK ((faults > 0)),
    CONSTRAINT step_faults_step_check CHECK ((length(step) > 0)),
    CONSTRAINT step_faults_subject_id_check CHECK ((length(subject_id) > 0))
);

CREATE TABLE public.suite_review_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    review_task_id uuid NOT NULL,
    basis text NOT NULL,
    covered jsonb NOT NULL,
    first_model text NOT NULL,
    second_model text,
    second_findings jsonb NOT NULL,
    second_failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    second_strength text,
    passed_over jsonb NOT NULL,
    CONSTRAINT suite_review_claims_basis_known CHECK ((basis = ANY (ARRAY['second-opinion-clean'::text, 'second-opinion-found'::text, 'no-other-family'::text, 'second-review-failed'::text]))),
    CONSTRAINT suite_review_claims_covered_check CHECK (((jsonb_typeof(covered) = 'array'::text) AND (jsonb_array_length(covered) >= 1))),
    CONSTRAINT suite_review_claims_failure_of_failed CHECK (((basis = 'second-review-failed'::text) = (second_failure IS NOT NULL))),
    CONSTRAINT suite_review_claims_first_model_check CHECK ((length(first_model) > 0)),
    CONSTRAINT suite_review_claims_found_has_findings CHECK (((basis <> 'second-opinion-found'::text) OR (jsonb_array_length(second_findings) >= 1))),
    CONSTRAINT suite_review_claims_no_other_family_same_provider CHECK (((basis <> 'no-other-family'::text) OR (second_strength <> 'other-family'::text))),
    CONSTRAINT suite_review_claims_passed_over_list CHECK ((jsonb_typeof(passed_over) = 'array'::text)),
    CONSTRAINT suite_review_claims_second_asked CHECK ((((second_model IS NULL) = (second_strength IS NULL)) AND ((second_model IS NULL) = (basis = 'second-review-failed'::text)) AND ((second_model IS NOT NULL) OR (jsonb_array_length(second_findings) = 0)))),
    CONSTRAINT suite_review_claims_second_failure_check CHECK (((second_failure IS NULL) OR (length(second_failure) > 0))),
    CONSTRAINT suite_review_claims_second_findings_check CHECK ((jsonb_typeof(second_findings) = 'array'::text)),
    CONSTRAINT suite_review_claims_second_model_check CHECK (((second_model IS NULL) OR (length(second_model) > 0))),
    CONSTRAINT suite_review_claims_strength_fits_models CHECK (((second_strength IS NULL) OR (((second_strength = 'same-model'::text) = (first_model = second_model)) AND ((second_strength = 'other-family'::text) = (split_part(first_model, '/'::text, 1) <> split_part(second_model, '/'::text, 1)))))),
    CONSTRAINT suite_review_claims_strength_known CHECK (((second_strength IS NULL) OR (second_strength = ANY (ARRAY['other-family'::text, 'same-family-other-model'::text, 'same-model'::text]))))
);

CREATE TABLE public.suite_review_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    review_task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    problems jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suite_review_findings_not_self CHECK ((review_task_id <> check_task_id)),
    CONSTRAINT suite_review_findings_problems_check CHECK (((jsonb_typeof(problems) = 'array'::text) AND (jsonb_array_length(problems) >= 1)))
);

CREATE TABLE public.suite_review_judgements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    review_task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    check_name text,
    outcome text NOT NULL,
    first_finding jsonb NOT NULL,
    second_findings jsonb NOT NULL,
    first_model text NOT NULL,
    second_model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    basis text NOT NULL,
    second_failure text,
    second_strength text,
    passed_over jsonb NOT NULL,
    CONSTRAINT suite_review_judgements_basis_fits_kind CHECK (((basis = 'two-reviews'::text) = (((first_finding ->> 'kind'::text) = 'outside-vision'::text) AND (outcome <> 'advisory'::text)))),
    CONSTRAINT suite_review_judgements_basis_known CHECK ((basis = ANY (ARRAY['two-reviews'::text, 'second-opinion-agreed'::text, 'second-opinion-disagreed'::text, 'no-other-family'::text, 'second-review-failed'::text, 'frozen'::text, 'reopened-once'::text]))),
    CONSTRAINT suite_review_judgements_check_name_check CHECK ((length(check_name) > 0)),
    CONSTRAINT suite_review_judgements_check_of_rejection CHECK ((((first_finding ->> 'kind'::text) = 'outside-vision'::text) = (check_name IS NOT NULL))),
    CONSTRAINT suite_review_judgements_failure_of_failed CHECK (((basis = 'second-review-failed'::text) = (second_failure IS NOT NULL))),
    CONSTRAINT suite_review_judgements_first_finding_check CHECK ((jsonb_typeof(first_finding) = 'object'::text)),
    CONSTRAINT suite_review_judgements_first_model_check CHECK ((length(first_model) > 0)),
    CONSTRAINT suite_review_judgements_kind_known CHECK (((first_finding ->> 'kind'::text) = ANY (ARRAY['contradiction'::text, 'outside-vision'::text, 'undecided-item'::text]))),
    CONSTRAINT suite_review_judgements_no_other_family_same_provider CHECK (((basis <> 'no-other-family'::text) OR (second_strength <> 'other-family'::text))),
    CONSTRAINT suite_review_judgements_outcome_fits_basis CHECK ((((outcome = 'routed'::text) = ((basis = 'second-opinion-agreed'::text) OR ((basis = 'two-reviews'::text) AND (outcome = 'routed'::text)))) AND ((outcome <> 'released'::text) OR (basis = 'two-reviews'::text)))),
    CONSTRAINT suite_review_judgements_outcome_known CHECK ((outcome = ANY (ARRAY['routed'::text, 'released'::text, 'advisory'::text]))),
    CONSTRAINT suite_review_judgements_passed_over_list CHECK ((jsonb_typeof(passed_over) = 'array'::text)),
    CONSTRAINT suite_review_judgements_routed_has_second CHECK (((outcome <> 'routed'::text) OR (jsonb_array_length(second_findings) >= 1))),
    CONSTRAINT suite_review_judgements_second_asked CHECK ((((second_model IS NULL) = (second_strength IS NULL)) AND ((basis = ANY (ARRAY['frozen'::text, 'reopened-once'::text, 'second-review-failed'::text])) OR (second_model IS NOT NULL)) AND ((basis <> 'second-review-failed'::text) OR (second_model IS NULL)) AND ((second_model IS NOT NULL) OR (jsonb_array_length(second_findings) = 0)))),
    CONSTRAINT suite_review_judgements_second_failure_check CHECK (((second_failure IS NULL) OR (length(second_failure) > 0))),
    CONSTRAINT suite_review_judgements_second_findings_check CHECK ((jsonb_typeof(second_findings) = 'array'::text)),
    CONSTRAINT suite_review_judgements_second_model_check CHECK ((length(second_model) > 0)),
    CONSTRAINT suite_review_judgements_strength_fits_models CHECK (((second_strength IS NULL) OR (((second_strength = 'same-model'::text) = (first_model = second_model)) AND ((second_strength = 'other-family'::text) = (split_part(first_model, '/'::text, 1) <> split_part(second_model, '/'::text, 1)))))),
    CONSTRAINT suite_review_judgements_strength_known CHECK (((second_strength IS NULL) OR (second_strength = ANY (ARRAY['other-family'::text, 'same-family-other-model'::text, 'same-model'::text]))))
);

CREATE TABLE public.system_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.task_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    revision integer NOT NULL,
    name text NOT NULL,
    command text NOT NULL,
    files jsonb NOT NULL,
    environment_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    baseline_commit text,
    decides jsonb,
    CONSTRAINT task_checks_baseline_commit_shape CHECK (((baseline_commit IS NULL) OR (baseline_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text))),
    CONSTRAINT task_checks_command_check CHECK ((btrim(command) <> ''::text)),
    CONSTRAINT task_checks_decides_check CHECK (((decides IS NULL) OR ((jsonb_typeof(decides) = 'array'::text) AND (jsonb_array_length(decides) >= 1)))),
    CONSTRAINT task_checks_environment_version_check CHECK ((environment_version ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT task_checks_files_check CHECK ((jsonb_typeof(files) = 'array'::text)),
    CONSTRAINT task_checks_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT task_checks_not_self CHECK ((task_id <> check_task_id)),
    CONSTRAINT task_checks_revision_check CHECK ((revision >= 1))
);

CREATE TABLE public.undecided_item_claims (
    claim_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    item_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT undecided_item_claims_item_id_check CHECK ((length(item_id) > 0))
);

CREATE TABLE public.undecided_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    review_task_id uuid NOT NULL,
    check_task_id uuid NOT NULL,
    item_id text NOT NULL,
    item_text text NOT NULL,
    judgement_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_id uuid,
    CONSTRAINT undecided_items_item_id_check CHECK ((length(item_id) > 0)),
    CONSTRAINT undecided_items_item_text_check CHECK ((length(item_text) > 0)),
    CONSTRAINT undecided_items_one_source CHECK (((judgement_id IS NULL) <> (claim_id IS NULL)))
);

CREATE TABLE public.vision_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version integer NOT NULL,
    vision_text text NOT NULL,
    summary text NOT NULL,
    inferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_boundaries jsonb DEFAULT '[]'::jsonb NOT NULL,
    confirmed_directions jsonb DEFAULT '[]'::jsonb NOT NULL,
    open_questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    change_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid NOT NULL
);

CREATE TABLE public.work_burn_warnings (
    project_id uuid NOT NULL,
    plan_revision integer NOT NULL,
    zone text NOT NULL,
    drawn_requests integer NOT NULL,
    budget_requests integer NOT NULL,
    reserve_requests integer NOT NULL,
    upstream_requests integer NOT NULL,
    planned_tasks integer NOT NULL,
    completed_tasks integer NOT NULL,
    report_id uuid NOT NULL,
    operator_report text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_burn_warnings_budget_requests_check CHECK ((budget_requests > 0)),
    CONSTRAINT work_burn_warnings_check CHECK (((reserve_requests >= 0) AND (reserve_requests < budget_requests))),
    CONSTRAINT work_burn_warnings_check1 CHECK ((upstream_requests = (budget_requests - reserve_requests))),
    CONSTRAINT work_burn_warnings_check2 CHECK (((completed_tasks >= 0) AND (completed_tasks <= planned_tasks))),
    CONSTRAINT work_burn_warnings_check3 CHECK (((zone = 'red'::text) = ((operator_report IS NOT NULL) AND (length(TRIM(BOTH FROM operator_report)) > 0)))),
    CONSTRAINT work_burn_warnings_drawn_requests_check CHECK ((drawn_requests >= 0)),
    CONSTRAINT work_burn_warnings_plan_revision_check CHECK ((plan_revision >= 1)),
    CONSTRAINT work_burn_warnings_planned_tasks_check CHECK ((planned_tasks >= 0)),
    CONSTRAINT work_burn_warnings_zone_check CHECK ((zone = ANY (ARRAY['yellow'::text, 'red'::text])))
);

CREATE TABLE public.work_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    requests integer NOT NULL,
    granted_by text NOT NULL,
    reason text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_grants_granted_by_check CHECK ((length(TRIM(BOTH FROM granted_by)) > 0)),
    CONSTRAINT work_grants_reason_check CHECK ((length(TRIM(BOTH FROM reason)) > 0)),
    CONSTRAINT work_grants_requests_check CHECK ((requests > 0))
);

CREATE TABLE public.work_items (
    id uuid NOT NULL,
    level character varying(10) NOT NULL,
    status character varying(15) DEFAULT 'Pending'::character varying NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    description text,
    task_spec jsonb,
    north_star text,
    success_criteria jsonb,
    blocked_reason jsonb,
    dispatch_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid NOT NULL,
    work_kind text,
    owner_role_id uuid,
    environment_statement text,
    environment_statement_version text,
    merge_commit text,
    infrastructure_faults integer DEFAULT 0 NOT NULL,
    merge_kind text,
    failure_verdict jsonb,
    crash_orphans integer DEFAULT 0 NOT NULL,
    overflowed_window_tokens integer,
    repairs_task_id uuid,
    CONSTRAINT work_items_crash_orphans_check CHECK ((crash_orphans >= 0)),
    CONSTRAINT work_items_environment_statement_on_environment_work CHECK (((environment_statement IS NULL) OR ((work_kind = ANY (ARRAY['environment'::text, 'implementation'::text])) AND (btrim(environment_statement) <> ''::text)))),
    CONSTRAINT work_items_environment_statement_version_shape CHECK (((environment_statement_version IS NULL) OR ((environment_statement IS NOT NULL) AND (environment_statement_version ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT work_items_infrastructure_faults_check CHECK ((infrastructure_faults >= 0)),
    CONSTRAINT work_items_level_check CHECK ((level IN ('Epic', 'Task'))),
    CONSTRAINT work_items_merge_commit_shape CHECK (((merge_commit IS NULL) OR (merge_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text))),
    CONSTRAINT work_items_merge_kind_known CHECK (((merge_kind IS NULL) OR (merge_kind = ANY (ARRAY['merged'::text, 'already_delivered'::text])))),
    CONSTRAINT work_items_merge_kind_with_commit CHECK (((merge_kind IS NULL) OR (merge_commit IS NOT NULL))),
    CONSTRAINT work_items_overflowed_window_tokens_check CHECK ((overflowed_window_tokens > 0)),
    CONSTRAINT work_items_owner_on_task CHECK (((work_kind IS NULL) OR ((level)::text = 'Task'::text))),
    CONSTRAINT work_items_owner_whole CHECK (((work_kind IS NULL) = (owner_role_id IS NULL))),
    CONSTRAINT work_items_repairs_task_only_environment_change CHECK (((repairs_task_id IS NULL) OR (((task_spec ->> 'origin'::text) = 'environment-change'::text) AND (repairs_task_id <> id)))),
    CONSTRAINT work_items_status_check CHECK ((status IN ('Pending', 'InProgress', 'Completed', 'Blocked', 'Failed', 'Abandoned'))),
    CONSTRAINT work_items_work_kind_known CHECK ((work_kind = ANY (ARRAY['environment'::text, 'implementation'::text, 'check'::text])))
);

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_defect_item_id_key UNIQUE (defect_item_id);

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_report_id_key UNIQUE (report_id);

ALTER TABLE ONLY public.check_disputes
    ADD CONSTRAINT check_disputes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.check_set_freezes
    ADD CONSTRAINT check_set_freezes_pkey PRIMARY KEY (review_task_id);

ALTER TABLE ONLY public.client_messages
    ADD CONSTRAINT client_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client_sessions
    ADD CONSTRAINT client_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client_sessions
    ADD CONSTRAINT client_sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_name_key UNIQUE (name);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.dependencies
    ADD CONSTRAINT dependencies_from_id_to_id_key UNIQUE (from_id, to_id);

ALTER TABLE ONLY public.dependencies
    ADD CONSTRAINT dependencies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.dev_sessions
    ADD CONSTRAINT dev_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.environment_builds
    ADD CONSTRAINT environment_builds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.failed_approaches
    ADD CONSTRAINT failed_approaches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intake_readings
    ADD CONSTRAINT intake_readings_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY public.knowledge_entries
    ADD CONSTRAINT knowledge_entries_pkey PRIMARY KEY (id);

ALTER TABLE public.llm_calls
    ADD CONSTRAINT llm_calls_estimate_recorded CHECK ((estimated_cost_usd IS NOT NULL)) NOT VALID;

ALTER TABLE public.llm_calls
    ADD CONSTRAINT llm_calls_finish_reason_recorded CHECK (((state <> 'recorded'::text) OR (finish_reason IS NOT NULL))) NOT VALID;

ALTER TABLE ONLY public.llm_calls
    ADD CONSTRAINT llm_calls_pkey PRIMARY KEY (id);

ALTER TABLE public.llm_calls
    ADD CONSTRAINT llm_calls_truncated_stopped_at_length CHECK (((error_kind IS DISTINCT FROM 'truncated'::text) OR (finish_reason = 'length'::text))) NOT VALID;

ALTER TABLE ONLY public.model_configs
    ADD CONSTRAINT model_configs_model_id_key UNIQUE (model_id);

ALTER TABLE ONLY public.model_configs
    ADD CONSTRAINT model_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.model_price_tiers
    ADD CONSTRAINT model_price_tiers_model_id_min_input_tokens_key UNIQUE (model_id, min_input_tokens);

ALTER TABLE ONLY public.model_price_tiers
    ADD CONSTRAINT model_price_tiers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.model_price_windows
    ADD CONSTRAINT model_price_windows_model_id_iso_weekday_utc_start_minute_key UNIQUE (model_id, iso_weekday, utc_start_minute);

ALTER TABLE ONLY public.model_price_windows
    ADD CONSTRAINT model_price_windows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plan_repairs
    ADD CONSTRAINT plan_repairs_pkey PRIMARY KEY (work_item_id);

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_one_per_number UNIQUE (project_id, revision);

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_report_id_key UNIQUE (report_id);

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_report_id_key UNIQUE (report_id);

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_resumed_report_id_key UNIQUE (resumed_report_id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_configs
    ADD CONSTRAINT provider_configs_name_key UNIQUE (name);

ALTER TABLE ONLY public.provider_configs
    ADD CONSTRAINT provider_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.replan_requests
    ADD CONSTRAINT replan_requests_pkey PRIMARY KEY (answer_id);

ALTER TABLE ONLY public.roster_roles
    ADD CONSTRAINT roster_roles_unique_role UNIQUE (project_id, revision, role_id);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.step_faults
    ADD CONSTRAINT step_faults_pkey PRIMARY KEY (step, subject_id);

ALTER TABLE ONLY public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suite_review_findings
    ADD CONSTRAINT suite_review_findings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.task_checks
    ADD CONSTRAINT task_checks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_checks
    ADD CONSTRAINT task_checks_unique_name UNIQUE (task_id, revision, name);

ALTER TABLE ONLY public.undecided_item_claims
    ADD CONSTRAINT undecided_item_claims_pkey PRIMARY KEY (claim_id, check_task_id, item_id);

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_one_per_check_task UNIQUE (check_task_id, item_id);

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vision_documents
    ADD CONSTRAINT vision_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vision_documents
    ADD CONSTRAINT vision_documents_project_version_unique UNIQUE (project_id, version);

ALTER TABLE ONLY public.work_burn_warnings
    ADD CONSTRAINT work_burn_warnings_pkey PRIMARY KEY (project_id, plan_revision, zone);

ALTER TABLE ONLY public.work_grants
    ADD CONSTRAINT work_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX acceptance_sweeps_one_pass ON public.acceptance_sweeps USING btree (project_id) WHERE passed;

CREATE INDEX check_disputes_check_task ON public.check_disputes USING btree (check_task_id);

CREATE UNIQUE INDEX client_messages_one_report_per_outcome ON public.client_messages USING btree (project_id, reports_on) WHERE (reports_on IS NOT NULL);

CREATE UNIQUE INDEX client_messages_question_position_unique ON public.client_messages USING btree (in_reply_to, "position") WHERE ("position" IS NOT NULL);

CREATE UNIQUE INDEX environment_builds_one_succeeded ON public.environment_builds USING btree (project_id, version) WHERE (status = 'succeeded'::text);

CREATE INDEX idx_client_login_failures_name_source_time ON public.client_login_failures USING btree (client_name, source_address, failed_at);

CREATE INDEX idx_client_login_failures_name_time ON public.client_login_failures USING btree (client_name, failed_at);

CREATE INDEX idx_client_login_failures_source_time ON public.client_login_failures USING btree (source_address, failed_at);

CREATE INDEX idx_client_login_failures_time ON public.client_login_failures USING btree (failed_at);

CREATE INDEX idx_client_messages_project_created ON public.client_messages USING btree (project_id, created_at);

CREATE INDEX idx_failed_approaches_epic ON public.failed_approaches USING btree (epic_id);

CREATE INDEX idx_failed_approaches_project ON public.failed_approaches USING btree (project_id);

CREATE INDEX idx_knowledge_content_search ON public.knowledge_entries USING gin (to_tsvector('english'::regconfig, content));

CREATE INDEX idx_knowledge_epic ON public.knowledge_entries USING btree (epic_id);

CREATE INDEX idx_knowledge_freshness ON public.knowledge_entries USING btree (freshness);

CREATE INDEX idx_knowledge_kind ON public.knowledge_entries USING btree (kind);

CREATE INDEX idx_knowledge_project ON public.knowledge_entries USING btree (project_id);

CREATE INDEX idx_knowledge_tags ON public.knowledge_entries USING gin (tags);

CREATE INDEX idx_llm_calls_pending ON public.llm_calls USING btree (id) WHERE (state = 'pending'::text);

CREATE INDEX idx_llm_calls_project_created ON public.llm_calls USING btree (project_id, created_at);

CREATE INDEX idx_llm_calls_task ON public.llm_calls USING btree (task_id) WHERE (task_id IS NOT NULL);

CREATE INDEX idx_projects_client_created ON public.projects USING btree (client_id, created_at DESC);

CREATE INDEX idx_work_grants_project ON public.work_grants USING btree (project_id);

CREATE INDEX idx_work_items_project_id ON public.work_items USING btree (project_id);

CREATE INDEX plan_repairs_pending ON public.plan_repairs USING btree (project_id) WHERE (plan_revision_id IS NULL);

CREATE UNIQUE INDEX project_blocks_one_open ON public.project_blocks USING btree (project_id) WHERE (ended_at IS NULL);

CREATE INDEX replan_requests_pending ON public.replan_requests USING btree (project_id) WHERE (plan_revision_id IS NULL);

CREATE UNIQUE INDEX roster_roles_unique_name ON public.roster_roles USING btree (project_id, revision, lower(name));

CREATE INDEX suite_review_claims_review_task ON public.suite_review_claims USING btree (review_task_id, created_at);

CREATE INDEX suite_review_findings_check_task ON public.suite_review_findings USING btree (check_task_id);

CREATE INDEX suite_review_findings_project ON public.suite_review_findings USING btree (project_id, created_at);

CREATE INDEX suite_review_judgements_review_task ON public.suite_review_judgements USING btree (review_task_id, created_at);

CREATE INDEX task_checks_task_revision ON public.task_checks USING btree (task_id, revision);

CREATE INDEX undecided_item_claims_item ON public.undecided_item_claims USING btree (check_task_id, item_id);

CREATE INDEX undecided_items_project ON public.undecided_items USING btree (project_id, created_at);

CREATE UNIQUE INDEX uq_client_messages_one_answer_per_question ON public.client_messages USING btree (in_reply_to) WHERE ((kind)::text = 'answer'::text);

CREATE TRIGGER check_disputes_append_only BEFORE UPDATE ON public.check_disputes FOR EACH ROW EXECUTE FUNCTION public.check_disputes_refuse_update();

CREATE TRIGGER check_set_freezes_append_only BEFORE UPDATE ON public.check_set_freezes FOR EACH ROW EXECUTE FUNCTION public.check_set_freezes_refuse_update();

CREATE TRIGGER client_messages_inbound_notify AFTER INSERT ON public.client_messages FOR EACH ROW WHEN (((new.direction)::text = 'inbound'::text)) EXECUTE FUNCTION public.notify_client_message();

CREATE TRIGGER dependencies_same_project BEFORE INSERT OR UPDATE OF from_id, to_id ON public.dependencies FOR EACH ROW EXECUTE FUNCTION public.dependency_same_project();

CREATE TRIGGER domain_events_notify AFTER INSERT ON public.domain_events FOR EACH ROW EXECUTE FUNCTION public.notify_ashara_events();

CREATE CONSTRAINT TRIGGER project_blocks_halt_consistent AFTER INSERT OR UPDATE ON public.project_blocks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.project_halt_consistent();

CREATE TRIGGER projects_acceptance_guard BEFORE UPDATE OF lifecycle ON public.projects FOR EACH ROW EXECUTE FUNCTION public.project_acceptance_guard();

CREATE CONSTRAINT TRIGGER projects_halt_consistent AFTER INSERT OR UPDATE ON public.projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.project_halt_consistent();

CREATE TRIGGER projects_stop_ends_halt AFTER UPDATE OF lifecycle ON public.projects FOR EACH ROW EXECUTE FUNCTION public.project_stop_ends_halt();

CREATE TRIGGER roster_roles_append_only BEFORE UPDATE ON public.roster_roles FOR EACH ROW EXECUTE FUNCTION public.roster_roles_refuse_update();

CREATE TRIGGER suite_review_claims_append_only BEFORE UPDATE ON public.suite_review_claims FOR EACH ROW EXECUTE FUNCTION public.suite_review_claims_refuse_update();

CREATE TRIGGER suite_review_findings_append_only BEFORE UPDATE ON public.suite_review_findings FOR EACH ROW EXECUTE FUNCTION public.suite_review_findings_refuse_update();

CREATE TRIGGER suite_review_judgements_append_only BEFORE UPDATE ON public.suite_review_judgements FOR EACH ROW EXECUTE FUNCTION public.suite_review_judgements_refuse_update();

CREATE TRIGGER task_checks_append_only BEFORE UPDATE ON public.task_checks FOR EACH ROW EXECUTE FUNCTION public.task_checks_refuse_update();

CREATE TRIGGER undecided_item_claims_append_only BEFORE UPDATE ON public.undecided_item_claims FOR EACH ROW EXECUTE FUNCTION public.undecided_item_claims_refuse_update();

CREATE TRIGGER undecided_items_append_only BEFORE UPDATE ON public.undecided_items FOR EACH ROW EXECUTE FUNCTION public.undecided_items_refuse_update();

CREATE TRIGGER work_items_plan_repair AFTER UPDATE OF status ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.plan_repair_on_abandon();

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_defect_item_id_fkey FOREIGN KEY (defect_item_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.acceptance_sweeps
    ADD CONSTRAINT acceptance_sweeps_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.check_disputes
    ADD CONSTRAINT check_disputes_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.check_disputes
    ADD CONSTRAINT check_disputes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.check_disputes
    ADD CONSTRAINT check_disputes_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.check_set_freezes
    ADD CONSTRAINT check_set_freezes_frozen_by_fkey FOREIGN KEY (frozen_by) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.check_set_freezes
    ADD CONSTRAINT check_set_freezes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.check_set_freezes
    ADD CONSTRAINT check_set_freezes_review_task_id_fkey FOREIGN KEY (review_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.client_messages
    ADD CONSTRAINT client_messages_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES public.client_messages(id);

ALTER TABLE ONLY public.client_messages
    ADD CONSTRAINT client_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.client_sessions
    ADD CONSTRAINT client_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);

ALTER TABLE ONLY public.dependencies
    ADD CONSTRAINT dependencies_from_id_fkey FOREIGN KEY (from_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dependencies
    ADD CONSTRAINT dependencies_to_id_fkey FOREIGN KEY (to_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dev_sessions
    ADD CONSTRAINT dev_sessions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.environment_builds
    ADD CONSTRAINT environment_builds_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.failed_approaches
    ADD CONSTRAINT failed_approaches_epic_id_fkey FOREIGN KEY (epic_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.failed_approaches
    ADD CONSTRAINT failed_approaches_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.failed_approaches
    ADD CONSTRAINT failed_approaches_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.work_items(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intake_readings
    ADD CONSTRAINT intake_readings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intake_readings
    ADD CONSTRAINT intake_readings_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.client_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.knowledge_entries
    ADD CONSTRAINT knowledge_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.knowledge_entries
    ADD CONSTRAINT knowledge_entries_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.llm_calls
    ADD CONSTRAINT llm_calls_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.model_configs
    ADD CONSTRAINT model_configs_provider_name_fkey FOREIGN KEY (provider_name) REFERENCES public.provider_configs(name);

ALTER TABLE ONLY public.model_price_tiers
    ADD CONSTRAINT model_price_tiers_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.model_configs(model_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.model_price_windows
    ADD CONSTRAINT model_price_windows_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.model_configs(model_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_repairs
    ADD CONSTRAINT plan_repairs_plan_revision_id_fkey FOREIGN KEY (plan_revision_id) REFERENCES public.plan_revisions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.plan_repairs
    ADD CONSTRAINT plan_repairs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_repairs
    ADD CONSTRAINT plan_repairs_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.plan_revisions
    ADD CONSTRAINT plan_revisions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.client_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.project_blocks
    ADD CONSTRAINT project_blocks_resumed_report_id_fkey FOREIGN KEY (resumed_report_id) REFERENCES public.client_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);

ALTER TABLE ONLY public.replan_requests
    ADD CONSTRAINT replan_requests_answer_id_fkey FOREIGN KEY (answer_id) REFERENCES public.client_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.replan_requests
    ADD CONSTRAINT replan_requests_plan_revision_id_fkey FOREIGN KEY (plan_revision_id) REFERENCES public.plan_revisions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.replan_requests
    ADD CONSTRAINT replan_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.roster_roles
    ADD CONSTRAINT roster_roles_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.roster_roles
    ADD CONSTRAINT roster_roles_vision_exists FOREIGN KEY (project_id, vision_version) REFERENCES public.vision_documents(project_id, version);

ALTER TABLE ONLY public.step_faults
    ADD CONSTRAINT step_faults_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_review_task_id_fkey FOREIGN KEY (review_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.suite_review_findings
    ADD CONSTRAINT suite_review_findings_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.suite_review_findings
    ADD CONSTRAINT suite_review_findings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.suite_review_findings
    ADD CONSTRAINT suite_review_findings_review_task_id_fkey FOREIGN KEY (review_task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_review_task_id_fkey FOREIGN KEY (review_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.task_checks
    ADD CONSTRAINT task_checks_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.task_checks
    ADD CONSTRAINT task_checks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.task_checks
    ADD CONSTRAINT task_checks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.undecided_item_claims
    ADD CONSTRAINT undecided_item_claims_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_item_claims
    ADD CONSTRAINT undecided_item_claims_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES public.suite_review_claims(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_check_task_id_fkey FOREIGN KEY (check_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES public.suite_review_claims(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_claim_linked FOREIGN KEY (claim_id, check_task_id, item_id) REFERENCES public.undecided_item_claims(claim_id, check_task_id, item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_judgement_id_fkey FOREIGN KEY (judgement_id) REFERENCES public.suite_review_judgements(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.undecided_items
    ADD CONSTRAINT undecided_items_review_task_id_fkey FOREIGN KEY (review_task_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vision_documents
    ADD CONSTRAINT vision_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.work_burn_warnings
    ADD CONSTRAINT work_burn_warnings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_burn_warnings
    ADD CONSTRAINT work_burn_warnings_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.client_messages(id);

ALTER TABLE ONLY public.work_grants
    ADD CONSTRAINT work_grants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.work_items(id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_repairs_task_id_fkey FOREIGN KEY (repairs_task_id) REFERENCES public.work_items(id) ON DELETE SET NULL;

-- Reference data: the provider and model catalog, its price windows and its price tiers.

INSERT INTO public.provider_configs (name, provider_type, base_url) VALUES
  ('anthropic', 'anthropic', NULL),
  ('deepseek', 'deepseek', 'https://api.deepseek.com/v1'),
  ('google', 'openai-compatible', NULL),
  ('local', 'local', NULL),
  ('mistral', 'openai-compatible', 'https://api.mistral.ai/v1'),
  ('openai', 'openai', NULL),
  ('xai', 'openai-compatible', 'https://api.x.ai/v1');

INSERT INTO public.model_configs (model_id, provider_name, api_model_id, capability, input_cost_per_1m, output_cost_per_1m, max_context_tokens, cache_read_cost_per_1m, cache_write_cost_per_1m) VALUES
  ('claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 'Frontier', 10, 50, 1000000, 0.25, 12.5),
  ('claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5', 'Medium', 0.1, 0.5, 1000000, 0.01, 0.125),
  ('claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Frontier', 4, 20, 1000000, 0.2, 5),
  ('claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Strong', 2, 10, 1000000, 0.1, 2.5),
  ('codestral-2508', 'mistral', 'codestral-2508', 'Light', 0.3, 0.9, 128000, 0.03, NULL),
  ('deepseek-flash', 'deepseek', 'deepseek-flash', 'Strong', 0.3, 1.2, 1000000, 0.006, NULL),
  ('gemini-3.5-flash-lite', 'google', 'gemini-3.5-flash-lite', 'Light', 0.3, 2.5, 1048576, 0.03, NULL),
  ('gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Medium', 0.75, 3.75, 1048576, 0.075, NULL),
  ('gemini-4-argon', 'google', 'gemini-4-argon', 'Frontier', 2, 10, 1048576, 0.1, NULL),
  ('gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'Strong', 2, 10, 1050000, 0.1, 2.5),
  ('gpt-6-astra', 'openai', 'gpt-6-astra', 'Frontier', 10, 50, 1050000, 1, 12.5),
  ('gpt-6-luna', 'openai', 'gpt-6-luna', 'Light', 0.1, 0.5, 1050000, 0.01, 0.125),
  ('grok-4.3', 'xai', 'grok-4.3', 'Light', 1.25, 2.5, 1000000, 0.2, NULL),
  ('grok-4.7', 'xai', 'grok-4.7', 'Medium', 2, 6, 500000, 0.5, NULL),
  ('ministral-3b-2512', 'mistral', 'ministral-3b-2512', 'Light', 0.1, 0.1, 256000, 0.01, NULL),
  ('mistral-large-4', 'mistral', 'mistral-large-4', 'Strong', 1.36, 4.18, 1000000, 0.14, NULL),
  ('mistral-medium-3-5', 'mistral', 'mistral-medium-3-5', 'Light', 1.5, 7.5, 256000, 0.15, NULL),
  ('mistral-small-2603', 'mistral', 'mistral-small-2603', 'Light', 0.15, 0.6, 256000, 0.015, NULL);

INSERT INTO public.model_price_windows (model_id, iso_weekday, utc_start_minute, utc_end_minute, input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m, cache_write_cost_per_1m) VALUES
  ('deepseek-flash', 1, 0, 60, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 1, 240, 360, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 1, 600, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 2, 0, 60, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 2, 240, 360, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 2, 600, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 3, 0, 60, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 3, 240, 360, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 3, 600, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 4, 0, 60, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 4, 240, 360, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 4, 600, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 5, 0, 60, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 5, 240, 360, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 5, 600, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 6, 0, 1440, 0.15, 0.6, 0.003, NULL),
  ('deepseek-flash', 7, 0, 1440, 0.15, 0.6, 0.003, NULL);

INSERT INTO public.model_price_tiers (model_id, min_input_tokens, input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m, cache_write_cost_per_1m) VALUES
  ('claude-haiku-5-5', 100001, 0.5, 2.5, 0.05, 0.625),
  ('gpt-6.1-sol', 272001, 4, 15, 0.2, 5),
  ('gpt-6-astra', 272001, 20, 75, 2, 25),
  ('gpt-6-luna', 272001, 0.2, 0.75, 0.02, 0.25),
  ('grok-4.3', 200000, 2.5, 5, 0.4, NULL),
  ('grok-4.7', 200000, 4, 12, 1, NULL);
