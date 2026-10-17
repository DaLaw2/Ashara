import { pgTable, uuid, text, integer, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// Finance: the cost ledger.

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
    // Migration 053: NULL exactly while the call is not recorded.
    outcome: text(),
    errorKind: text("error_kind"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    // Migration 030: NULL only on rows written before it and on rows not recorded yet (053).
    finishReason: text("finish_reason"),
    reasoningTokens: integer("reasoning_tokens"),
    // Migration 035: Finance's worst-case estimate, made before the call; the cap counts it when costUsd is NULL.
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 20, scale: 12, mode: "number" }),
    // Migration 053: 'pending' from admission to record, 'recorded' after it, 'unmeasured_after_crash'
    // when a later process's startup found it pending. A row in every state counts against the cap.
    state: text().notNull(),
    // Migration 075: the window of the model the call was sent to, written with its record; its
    // utilisation is inputTokens over it. NULL on rows recorded before it and on rows not recorded yet.
    contextWindowTokens: integer("context_window_tokens"),
  },
  (t) => ({
    projectCreatedIdx: index("idx_llm_calls_project_created").on(t.projectId, t.createdAt),
    // Migration 067: a task's drawn requests are counted on every request it sends.
    taskIdx: index("idx_llm_calls_task").on(t.taskId).where(sql`task_id IS NOT NULL`),
  }),
);

// ---------------------------------------------------------------------------
// work_grants (migration 067, ADR-084 decision 1, Finance context)
// ---------------------------------------------------------------------------
// The owner's explicit grant of more model requests to one project: the only way its work budget
// grows past the policy default. Append-only.

export const workGrants = pgTable(
  "work_grants",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requests: integer().notNull(),
    grantedBy: text("granted_by").notNull(),
    reason: text().notNull(),
    grantedAt: timestamptz("granted_at").notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index("idx_work_grants_project").on(t.projectId),
  }),
);
