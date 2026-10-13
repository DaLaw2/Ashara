import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  smallint,
  bigint,
  doublePrecision,
  numeric,
  unique,
  index,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

function timestamptz(name?: string) {
  return name
    ? timestamp(name, { withTimezone: true })
    : timestamp({ withTimezone: true });
}

// ---------------------------------------------------------------------------
// clients (migration 018): who a project belongs to and a session acts for
// ---------------------------------------------------------------------------

export const clients = pgTable("clients", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull().unique(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// projects (migration 014, K3 Project Record; client_id since migration 018)
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull(),
  status: varchar({ length: 20 }).notNull().default("active"),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  // Migration 020: Delivery's first plan of the project. Failed attempts with the
  // last one's error; the plan transaction stamps first_planned_at, giving up
  // stamps plan_stopped_at together with status 'blocked'.
  planAttempts: integer("plan_attempts").notNull().default(0),
  planLastError: text("plan_last_error"),
  firstPlannedAt: timestamptz("first_planned_at"),
  planStoppedAt: timestamptz("plan_stopped_at"),
  // Migration 024: the target workspace Delivery works in. Minted once on first
  // dispatch, then never rewritten.
  workspacePath: text("workspace_path"),
  // Migration 025: why one bad record blocked the project, so the loop skips it
  // instead of failing every project's cycle. Recorded together, on blocked rows only.
  blockedErrorClass: text("blocked_error_class"),
  blockedReason: text("blocked_reason"),
});

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

export const workItems = pgTable("work_items", {
  id: uuid().primaryKey(),
  level: varchar({ length: 10 }).notNull(),
  status: varchar({ length: 15 }).notNull().default("Pending"),
  parentId: uuid("parent_id"),
  title: text().notNull(),
  description: text(),
  taskSpec: jsonb("task_spec"),
  northStar: text("north_star"),
  successCriteria: jsonb("success_criteria"),
  blockedReason: jsonb("blocked_reason"),
  // Run-scope association (migration 003). The column admits a runId (UUID from
  // openRun), "pre-scoping" for rows that existed before this column, or
  // RUN_SCOPE_AD_HOC. Today the only writer is the server's first-plan store,
  // which writes RUN_SCOPE_AD_HOC; no code path writes a runId.
  // No default: every insert site must supply the value explicitly.
  runScope: varchar("run_scope", { length: 50 }).notNull(),
  // No default: every insert names its project (migration 014).
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  // Dispatch-guaranteed attempt counter (migration 018, r9f-t1). Incremented at the
  // dispatch seam so the retry bound survives a crashed agent or discarded output —
  // decoupled from task_cost_history billing. See CoreLoop.processTask.
  dispatchCount: integer("dispatch_count").notNull().default(0),
  // Who owns the item (migration 031): its kind of work and the roster role
  // holding the capability that kind needs. Both or neither; only on a Task.
  workKind: text("work_kind"),
  ownerRoleId: uuid("owner_role_id"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

export const dependencies = pgTable("dependencies", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  fromId: uuid("from_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  toId: uuid("to_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// domain_events
// ---------------------------------------------------------------------------

export const domainEvents = pgTable("domain_events", {
  eventId: uuid("event_id").primaryKey(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  timestamp: timestamptz().notNull(),
  sourceContext: varchar("source_context", { length: 50 }).notNull(),
  correlationId: uuid("correlation_id"),
  payload: jsonb().notNull().default({}),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// dev_sessions
// ---------------------------------------------------------------------------

export const devSessions = pgTable("dev_sessions", {
  id: uuid().primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => workItems.id),
  phase: varchar({ length: 20 }).notNull().default("Preparing"),
  workerId: uuid("worker_id"),
  brief: jsonb(),
  output: jsonb(),
  verificationResult: jsonb("verification_result"),
  findings: jsonb(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// knowledge_entries
// ---------------------------------------------------------------------------

export const knowledgeEntries = pgTable("knowledge_entries", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  kind: varchar({ length: 20 }).notNull(),
  title: text().notNull(),
  content: text().notNull(),
  source: text().notNull(),
  epicId: uuid("epic_id"),
  tags: text().array().notNull().default(sql`'{}'`),
  eventTime: timestamptz("event_time").notNull(),
  ingestionTime: timestamptz("ingestion_time").notNull().defaultNow(),
  decisionData: jsonb("decision_data"),
  findingData: jsonb("finding_data"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  freshness: varchar({ length: 10 }).notNull().default("fresh"),
  sourceTaskId: uuid("source_task_id").references(() => workItems.id),
});

// ---------------------------------------------------------------------------
// vision_documents
// ---------------------------------------------------------------------------

// `version` counts per project; UNIQUE (project_id, version) fails a racing
// writer closed instead of letting two rows share a version (migration 014).
export const visionDocuments = pgTable(
  "vision_documents",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    version: integer().notNull(),
    visionText: text("vision_text").notNull(),
    summary: text().notNull(),
    inferences: jsonb().notNull().default({}),
    scopeBoundaries: jsonb("scope_boundaries").notNull().default(sql`'[]'`),
    confirmedDirections: jsonb("confirmed_directions").notNull().default(sql`'[]'`),
    userAnswers: jsonb("user_answers").notNull().default(sql`'[]'`),
    openQuestions: jsonb("open_questions").notNull().default(sql`'[]'`),
    changeReason: text("change_reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUnique: unique("vision_documents_project_version_unique").on(t.projectId, t.version),
  }),
);

// ---------------------------------------------------------------------------
// roster_roles (migration 031): a project's roster, one row per role, append-only
// ---------------------------------------------------------------------------

export const rosterRoles = pgTable(
  "roster_roles",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    revision: integer().notNull(),
    roleId: uuid("role_id").notNull(),
    name: text().notNull(),
    responsibility: text().notNull(),
    capabilities: text().array().notNull(),
    visionVersion: integer("vision_version").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueRole: unique("roster_roles_unique_role").on(t.projectId, t.revision, t.roleId),
  }),
);

// ---------------------------------------------------------------------------
// failed_approaches
// ---------------------------------------------------------------------------

export const failedApproaches = pgTable("failed_approaches", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  // Nullable + ON DELETE SET NULL (migration 021, finding d): a lesson outlives
  // the task that produced it, mirroring knowledge_entries.source_task_id.
  taskId: uuid("task_id").references(() => workItems.id, {
    onDelete: "set null",
  }),
  epicId: uuid("epic_id").references(() => workItems.id),
  title: text().notNull(),
  approachDescription: text("approach_description").notNull(),
  failureReason: text("failure_reason").notNull(),
  learned: text().notNull().default(""),
  affectedArea: text("affected_area").notNull().default(""),
  recordedAt: timestamptz("recorded_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// provider_configs
// ---------------------------------------------------------------------------

// Provider API keys live in the secret store as provider/<name>/api_key, never
// here (ADR-075 C2); migration 013 drops the plaintext api_key column.
export const providerConfigs = pgTable("provider_configs", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull().unique(),
  providerType: text("provider_type").notNull(),
  baseUrl: text("base_url"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// model_configs
// ---------------------------------------------------------------------------

export const modelConfigs = pgTable("model_configs", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id").notNull().unique(),
  providerName: text("provider_name")
    .notNull()
    .references(() => providerConfigs.name),
  apiModelId: text("api_model_id"),
  capability: text().notNull(),
  inputCostPer1m: doublePrecision("input_cost_per_1m").notNull().default(0),
  outputCostPer1m: doublePrecision("output_cost_per_1m").notNull().default(0),
  maxContextTokens: integer("max_context_tokens").notNull().default(128000),
  cacheReadCostPer1m: doublePrecision("cache_read_cost_per_1m"),
  cacheWriteCostPer1m: doublePrecision("cache_write_cost_per_1m"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// model_price_windows (migration 021): time-of-day rates replacing a model's base rates
// ---------------------------------------------------------------------------

export const modelPriceWindows = pgTable("model_price_windows", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id")
    .notNull()
    .references(() => modelConfigs.modelId, { onDelete: "cascade", onUpdate: "cascade" }),
  isoWeekday: smallint("iso_weekday").notNull(),
  utcStartMinute: smallint("utc_start_minute").notNull(),
  utcEndMinute: smallint("utc_end_minute").notNull(),
  inputCostPer1m: doublePrecision("input_cost_per_1m").notNull(),
  outputCostPer1m: doublePrecision("output_cost_per_1m").notNull(),
  cacheReadCostPer1m: doublePrecision("cache_read_cost_per_1m"),
  cacheWriteCostPer1m: doublePrecision("cache_write_cost_per_1m"),
}, (t) => ({
  modelWeekdayStartUnique: unique("model_price_windows_model_id_iso_weekday_utc_start_minute_key")
    .on(t.modelId, t.isoWeekday, t.utcStartMinute),
}));

// ---------------------------------------------------------------------------
// system_settings
// ---------------------------------------------------------------------------

export const systemSettings = pgTable("system_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// secrets (migration 012) — owned by the Security context (ADR-075 S1)
// ---------------------------------------------------------------------------
// Ciphertext only: the AES-256-GCM key never enters the database (ADR-073 Q10).

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const secrets = pgTable("secrets", {
  name: text().primaryKey(),
  keyId: text("key_id").notNull(),
  iv: bytea().notNull(),
  ciphertext: bytea().notNull(),
  authTag: bytea("auth_tag").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// project_contracts (ADR-028, migration 019)
// ---------------------------------------------------------------------------
// Per-project, append-only versioned ProjectContract. Each amendment inserts a new
// row at version N+1 (prior versions kept for audit). The UNIQUE (project_id,
// version) constraint is the monotonicity guard: two racing amends that compute the
// same next version fail closed on the constraint instead of reusing a version. The
// whole body lives in `contract` jsonb, validated by Zod at both read and write.
// Since migration 014 `project_id` is a projects.id; rows written before it are
// keyed by a root work item id and carry no FK for that reason.

export const projectContracts = pgTable(
  "project_contracts",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id").notNull(),
    version: integer().notNull(),
    contract: jsonb().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUnique: unique("project_contracts_project_version_unique").on(t.projectId, t.version),
    projectVersionIdx: index("project_contracts_project_version_idx").on(t.projectId, t.version),
  }),
);

// ---------------------------------------------------------------------------
// task_cost_history
// ---------------------------------------------------------------------------

export const taskCostHistory = pgTable("task_cost_history", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id").notNull(),
  capability: text().notNull(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  actualCostUsd: doublePrecision("actual_cost_usd").notNull().default(0.0),
  modelId: text("model_id"),
  success: boolean().notNull().default(false),
  attempt: integer().notNull().default(1),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// llm_calls (migration 015, K10 cost ledger, Finance context)
// ---------------------------------------------------------------------------
// One row per provider call. Token and cost columns are nullable with no
// default: NULL means unmeasured, never zero.

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: uuid("task_id"),
    callSite: text("call_site").notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: numeric("cost_usd", { precision: 20, scale: 12, mode: "number" }),
    outcome: text().notNull(),
    errorKind: text("error_kind"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    // Migration 030: NULL only on rows written before it; a CHECK refuses NULL on every new row.
    finishReason: text("finish_reason"),
    reasoningTokens: integer("reasoning_tokens"),
  },
  (t) => ({
    projectCreatedIdx: index("idx_llm_calls_project_created").on(t.projectId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// client_messages (migration 016, K1 client channel, Engagement context)
// ---------------------------------------------------------------------------
// Direction/kind pairing, non-empty body and "an answer names its question" are
// CHECKs in the migration; inbound inserts NOTIFY 'ashara_events'.

export const clientMessages = pgTable(
  "client_messages",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    direction: varchar({ length: 10 }).notNull(),
    kind: varchar({ length: 10 }).notNull(),
    body: text().notNull(),
    inReplyTo: uuid("in_reply_to").references((): AnyPgColumn => clientMessages.id),
    consumedAt: timestamptz("consumed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    // Migration 019: failed intake attempts of a tender, with the last one's error.
    intakeAttempts: integer("intake_attempts").notNull().default(0),
    intakeLastError: text("intake_last_error"),
    // Migration 020: the planning outcome an outbound report tells the client about.
    reportsOn: varchar("reports_on", { length: 20 }),
    // Migration 022: an outbound question's 1-based rank among those posted with it.
    position: integer(),
  },
  (t) => ({
    projectCreatedIdx: index("idx_client_messages_project_created").on(t.projectId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// client_sessions (migration 017, ADR-076 web client)
// ---------------------------------------------------------------------------

export const clientSessions = pgTable("client_sessions", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  // SHA-256 of the cookie's token, hex; the token itself is never stored.
  tokenHash: text("token_hash").notNull().unique(),
  // The one client this session acts for (migration 018).
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
});

// ---------------------------------------------------------------------------
// client_login_failures (migration 018): the login throttle's evidence
// ---------------------------------------------------------------------------

export const clientLoginFailures = pgTable(
  "client_login_failures",
  {
    clientName: text("client_name").notNull(),
    // The attempt's source (migration 027): an IPv4 address or an IPv6 /64 (server/src/source-network.ts sourceNetwork).
    sourceAddress: text("source_address").notNull(),
    failedAt: timestamptz("failed_at").notNull().defaultNow(),
  },
  (t) => ({
    nameTimeIdx: index("idx_client_login_failures_name_time").on(t.clientName, t.failedAt),
    nameSourceTimeIdx: index("idx_client_login_failures_name_source_time").on(
      t.clientName,
      t.sourceAddress,
      t.failedAt,
    ),
    sourceTimeIdx: index("idx_client_login_failures_source_time").on(t.sourceAddress, t.failedAt),
    timeIdx: index("idx_client_login_failures_time").on(t.failedAt),
  }),
);
