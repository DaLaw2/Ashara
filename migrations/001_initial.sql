CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- Work Items (planning aggregate root)
-- =============================================================================

CREATE TABLE IF NOT EXISTS work_items (
    id UUID PRIMARY KEY,
    level VARCHAR(10) NOT NULL CHECK (level IN ('Epic', 'Story', 'Feature', 'Task')),
    status VARCHAR(15) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'InProgress', 'Completed', 'Blocked', 'Failed', 'Abandoned')),
    parent_id UUID REFERENCES work_items(id),
    title TEXT NOT NULL,
    description TEXT,
    task_spec JSONB,
    north_star TEXT,
    success_criteria JSONB,
    blocked_reason JSONB,
    dispatch_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Dependencies
-- =============================================================================

CREATE TABLE IF NOT EXISTS dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_id, to_id),
    CHECK (from_id != to_id)
);

-- =============================================================================
-- Domain Events + NOTIFY trigger
-- =============================================================================

CREATE TABLE IF NOT EXISTS domain_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    source_context VARCHAR(50) NOT NULL,
    correlation_id UUID,
    payload JSONB NOT NULL DEFAULT '{}',
    priority VARCHAR(10) NOT NULL DEFAULT 'Internal' CHECK (priority IN ('External', 'Internal')),
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON domain_events(priority, timestamp) WHERE NOT processed;

CREATE OR REPLACE FUNCTION notify_ashara_events()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('ashara_events', NEW.event_id::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER domain_events_notify
    AFTER INSERT ON domain_events
    FOR EACH ROW
    EXECUTE FUNCTION notify_ashara_events();

-- =============================================================================
-- Dev Sessions
-- =============================================================================

CREATE TABLE IF NOT EXISTS dev_sessions (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES work_items(id),
    phase VARCHAR(20) NOT NULL DEFAULT 'Preparing' CHECK (phase IN ('Preparing', 'Completed', 'Failed')),
    worker_id UUID,
    brief JSONB,
    output JSONB,
    verification_result JSONB,
    findings JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Knowledge Entries
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('decision', 'finding', 'insight')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    epic_id UUID,
    tags TEXT[] NOT NULL DEFAULT '{}',
    event_time TIMESTAMPTZ NOT NULL,
    ingestion_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decision_data JSONB,
    finding_data JSONB,
    embedding vector(1024),
    freshness VARCHAR(10) NOT NULL DEFAULT 'fresh' CHECK (freshness IN ('fresh', 'stale', 'archived')),
    source_task_id UUID REFERENCES work_items(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_entries(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_epic ON knowledge_entries(epic_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge_entries USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_knowledge_content_search ON knowledge_entries USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge_entries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_knowledge_freshness ON knowledge_entries(freshness);

-- =============================================================================
-- Brainstorm Log
-- =============================================================================

CREATE TABLE IF NOT EXISTS brainstorm_log (
    id UUID PRIMARY KEY,
    trigger_reason TEXT NOT NULL,
    trigger_level TEXT NOT NULL,
    items_created INTEGER NOT NULL DEFAULT 0,
    items_proposed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_log_created_at ON brainstorm_log (created_at DESC);

-- =============================================================================
-- Vision Documents
-- =============================================================================

CREATE TABLE IF NOT EXISTS vision_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL DEFAULT 1,
    vision_text TEXT NOT NULL,
    summary TEXT NOT NULL,
    inferences JSONB NOT NULL DEFAULT '{}',
    scope_boundaries JSONB NOT NULL DEFAULT '[]',
    confirmed_directions JSONB NOT NULL DEFAULT '[]',
    user_answers JSONB NOT NULL DEFAULT '[]',
    open_questions JSONB NOT NULL DEFAULT '[]',
    change_reason TEXT,
    project_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vision_docs_version ON vision_documents(version DESC);

-- =============================================================================
-- Failed Approaches
-- =============================================================================

CREATE TABLE IF NOT EXISTS failed_approaches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
    epic_id UUID REFERENCES work_items(id),
    title TEXT NOT NULL,
    approach_description TEXT NOT NULL,
    failure_reason TEXT NOT NULL,
    learned TEXT NOT NULL DEFAULT '',
    affected_area TEXT NOT NULL DEFAULT '',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_approaches_epic ON failed_approaches(epic_id);
CREATE INDEX IF NOT EXISTS idx_failed_approaches_area ON failed_approaches(affected_area);

-- =============================================================================
-- File Changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS file_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_path TEXT NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('created', 'modified', 'deleted')),
    task_id UUID REFERENCES work_items(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_changes_recent ON file_changes(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_changes_task ON file_changes(task_id);

-- =============================================================================
-- Provider & Model Configs
-- =============================================================================

CREATE TABLE IF NOT EXISTS provider_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL,
    api_key TEXT,
    base_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id TEXT NOT NULL UNIQUE,
    provider_name TEXT NOT NULL REFERENCES provider_configs(name),
    api_model_id TEXT,
    capability TEXT NOT NULL CHECK (capability IN ('Frontier', 'Strong', 'Medium', 'Light')),
    format_group TEXT NOT NULL DEFAULT 'native-fc',
    strict_mode BOOLEAN NOT NULL DEFAULT false,
    input_cost_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_cost_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_context_tokens INTEGER NOT NULL DEFAULT 128000,
    supports_caching BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Task Cost History
-- =============================================================================

CREATE TABLE IF NOT EXISTS task_cost_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL,
    capability TEXT NOT NULL,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    actual_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    model_id TEXT,
    success BOOLEAN NOT NULL DEFAULT false,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_cost_capability ON task_cost_history(capability);
CREATE INDEX IF NOT EXISTS idx_task_cost_capability_success ON task_cost_history(capability, success);

-- =============================================================================
-- Project Contracts
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    version INTEGER NOT NULL,
    contract JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_contracts_project_version_unique UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS project_contracts_project_version_idx ON project_contracts (project_id, version);
