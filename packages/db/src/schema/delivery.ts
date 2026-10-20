import { pgTable, primaryKey, uuid, varchar, text, jsonb, integer, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { clientMessages } from "./engagement.js";
import { projects } from "./project.js";

// Delivery: the plan, its revisions and repairs, and the project halts.

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
  // No default: every insert names its project.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  // Dispatch-guaranteed attempt counter. Incremented at the
  // dispatch seam so the retry bound survives a crashed agent or discarded output —
  // decoupled from any cost record. See CoreLoop.processTask. A dispatch that never ran the
  // work (a pre-call refusal, stale checks, a check dispute, an environment change) is refunded,
  // so the count is attempts counted against the task, not every dispatch.
  dispatchCount: integer("dispatch_count").notNull().default(0),
  // Who owns the item: its kind of work and the roster role
  // holding the capability that kind needs. Both or neither; only on a Task.
  workKind: text("work_kind"),
  ownerRoleId: uuid("owner_role_id"),
  // A Sprint 0 task's stack statement, written when its substrate
  // gate passed. On environment work, and on an implementation whose
  // verified merge produced a new environment version.
  environmentStatement: text("environment_statement"),
  // The environment version the statement was tested on; a later task's
  // statement is chosen by it. NULL on a statement recorded before the column existed.
  environmentStatementVersion: text("environment_statement_version"),
  // Infrastructure faults observed on the item's dispatches, none charged as an
  // attempt; the bound of its uncharged requeues.
  infrastructureFaults: integer("infrastructure_faults").notNull().default(0),
  // The startups in a row that found the item InProgress, left by a process that
  // died; the bound of its re-dispatches after a crash (startup reconciler).
  crashOrphans: integer("crash_orphans").notNull().default(0),
  // The largest context window an attempt of the item did not fit; its next
  // dispatch is on a model whose window is larger. NULL when no attempt has overflowed one.
  overflowedWindowTokens: integer("overflowed_window_tokens"),
  // The merge commit Z0's merge step made on the target's main for this task;
  // the only record of what was merged. NULL when nothing of the task was merged.
  mergeCommit: text("merge_commit"),
  // How merge_commit closed the task, 'merged' or 'already_delivered'; NULL when
  // not recorded (a record from before the column existed).
  mergeKind: text("merge_kind"),
  // Quality's verdict on the last attempt, written with every entry into Failed and
  // cleared on every exit from it. NULL on a Failed row that failed before the column existed.
  failureVerdict: jsonb("failure_verdict"),
  // On an environment-change task, the task it was opened for (the task whose
  // implementer needed the change), written when it is created; NULL on every other task and on an
  // environment-change task created before the column existed. Its spend is charged by this link, never by reading
  // the dependency graph.
  repairsTaskId: uuid("repairs_task_id"),
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
// project_blocks: one row per time Delivery halted a project. An open row is
// the halt itself: opened and ended by Delivery's halt guard, ended as
// 'client_stop' by the projects_stop_ends_halt trigger when the client stops the project.
// ---------------------------------------------------------------------------

/**
 * Every kind a project block episode can record (project_blocks.kind, CHECKed in the migrations).
 */
export const PROJECT_BLOCK_KINDS = [
  "budget_cap",
  "configuration",
  "fault",
  "planning_stopped",
  "check_dispute",
  "replan_bound",
  "suite_review",
  "plan_repair",
  "infrastructure",
  "replan_stopped",
  "replan_provider_failed",
  "model_failed",
  "provider_failed",
  "work_budget",
] as const;

export const projectBlocks = pgTable("project_blocks", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  errorClass: text("error_class"),
  reason: text(),
  blockedAt: timestamptz("blocked_at").notNull().defaultNow(),
  reportId: uuid("report_id").references(() => clientMessages.id, { onDelete: "set null" }),
  endedAt: timestamptz("ended_at"),
  endKind: text("end_kind"),
  unblockedBy: text("unblocked_by"),
  unblockReason: text("unblock_reason"),
  /** What the passing substrate probe observed, on an infrastructure halt it ended. */
  resumeEvidence: text("resume_evidence"),
  resumedReportId: uuid("resumed_report_id").references(() => clientMessages.id, { onDelete: "set null" }),
  /**
   * On a budget_cap halt, the amounts its cap was judged on (capUsd, spentUsd,
   * inFlightUsd, nextCallUsd); NULL on every other kind and on a budget_cap halt recorded before the column existed.
   */
  spend: jsonb("spend"),
  /**
   * On a work_budget halt, the work ledger as Finance read it when it refused the
   * request (budget, granted, spent, in flight, requests by call site); NULL on every other kind.
   */
  work: jsonb("work"),
});

// ---------------------------------------------------------------------------
// plan_revisions: one row per revision of a project's plan after
// the first, with what it did and the Liaison's one report on it.
// ---------------------------------------------------------------------------

export const planRevisions = pgTable(
  "plan_revisions",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    visionVersion: integer("vision_version").notNull(),
    /**
     * The earliest client message whose correction it took in, which its report replies to; null for
     * a plan repair. Every correction it took in is a correction_holds row naming it.
     */
    requestedBy: uuid("requested_by").references(() => clientMessages.id, { onDelete: "cascade" }),
    /** 'client_change' or 'repair'. */
    kind: text().notNull().default("client_change"),
    summary: jsonb().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    reportId: uuid("report_id").references(() => clientMessages.id, { onDelete: "set null" }),
  },
  (t) => ({
    oneNumber: unique("plan_revisions_one_per_number").on(t.projectId, t.revision),
  }),
);

// ---------------------------------------------------------------------------
// plan_repairs: one row per task the failure router abandoned, written by a
// trigger on the abandonment; the plan revision that re-planned around it is recorded on it.
// ---------------------------------------------------------------------------

export const planRepairs = pgTable("plan_repairs", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItems.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  planRevisionId: uuid("plan_revision_id").references(() => planRevisions.id, { onDelete: "set null" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// correction_holds: one row per client correction applied to a planned project (a change, a
// confirmed proposal, an answer that changed an assumption), naming the guarantee and assumption
// keys it affects. While a row has no plan_revision_id the tasks citing one of them are held and the
// project's other work goes on; the revision that replaced the held work is recorded on it.
// ---------------------------------------------------------------------------

export const correctionHolds = pgTable(
  "correction_holds",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The vision version the correction wrote (vision_revisions.version). */
    visionVersion: integer("vision_version").notNull(),
    /** The client message the correction answers: its change, its confirmation or its answer. */
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => clientMessages.id, { onDelete: "cascade" }),
    affected: text().array().notNull(),
    planRevisionId: uuid("plan_revision_id").references(() => planRevisions.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.visionVersion] }),
  }),
);
