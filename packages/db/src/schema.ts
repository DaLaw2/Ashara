import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  bigint,
  doublePrecision,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

function timestamptz(name?: string) {
  return name
    ? timestamp(name, { withTimezone: true })
    : timestamp({ withTimezone: true });
}

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
  // Run-scope association (migration 003). Either a runId (UUID from openRun),
  // RUN_SCOPE_PRE_SCOPING for rows that existed before this column, or
  // RUN_SCOPE_AD_HOC for items created outside any orchestrator run (HTTP API).
  // No default: every insert site must supply the value explicitly.
  runScope: varchar("run_scope", { length: 50 }).notNull(),
  // Dispatch-guaranteed attempt counter (migration 018, r9f-t1). Incremented at the
  // dispatch seam so the retry bound survives a crashed agent or discarded output —
  // decoupled from task_cost_history billing. See CoreLoop.processTask.
  dispatchCount: integer("dispatch_count").notNull().default(0),
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

export const visionDocuments = pgTable("vision_documents", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  version: integer().notNull().default(1),
  visionText: text("vision_text").notNull(),
  summary: text().notNull(),
  inferences: jsonb().notNull().default({}),
  scopeBoundaries: jsonb("scope_boundaries").notNull().default(sql`'[]'`),
  confirmedDirections: jsonb("confirmed_directions").notNull().default(sql`'[]'`),
  userAnswers: jsonb("user_answers").notNull().default(sql`'[]'`),
  openQuestions: jsonb("open_questions").notNull().default(sql`'[]'`),
  changeReason: text("change_reason"),
  projectPath: text("project_path"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

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

export const providerConfigs = pgTable("provider_configs", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull().unique(),
  providerType: text("provider_type").notNull(),
  apiKey: text("api_key"),
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
  supportsCaching: boolean("supports_caching").notNull().default(false),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// system_settings
// ---------------------------------------------------------------------------

export const systemSettings = pgTable("system_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
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

