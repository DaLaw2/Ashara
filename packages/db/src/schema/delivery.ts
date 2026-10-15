import { pgTable, uuid, varchar, text, jsonb, integer, unique } from "drizzle-orm/pg-core";
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
  // No default: every insert names its project (migration 014).
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  // Dispatch-guaranteed attempt counter (migration 018, r9f-t1). Incremented at the
  // dispatch seam so the retry bound survives a crashed agent or discarded output —
  // decoupled from any cost record. See CoreLoop.processTask.
  dispatchCount: integer("dispatch_count").notNull().default(0),
  // Who owns the item (migration 031): its kind of work and the roster role
  // holding the capability that kind needs. Both or neither; only on a Task.
  workKind: text("work_kind"),
  ownerRoleId: uuid("owner_role_id"),
  // Migration 033: a Sprint 0 task's stack statement, written when its substrate
  // gate passed. On environment work, and (migration 043) on an implementation whose
  // verified merge produced a new environment version.
  environmentStatement: text("environment_statement"),
  // Migration 037: the environment version the statement was tested on; a later task's
  // statement is chosen by it. NULL on a statement recorded before 037.
  environmentStatementVersion: text("environment_statement_version"),
  // Migration 048: infrastructure faults observed on the item's dispatches, none charged as an
  // attempt; the bound of its uncharged requeues.
  infrastructureFaults: integer("infrastructure_faults").notNull().default(0),
  // Migration 041: the merge commit Z0's merge step made on the target's main for this task;
  // the only record of what was merged. NULL when nothing of the task was merged.
  mergeCommit: text("merge_commit"),
  // Migration 049: how merge_commit closed the task, 'merged' or 'already_delivered'; NULL when
  // not recorded (a record from before 049).
  mergeKind: text("merge_kind"),
  // Migration 058: Quality's verdict on the last attempt, written with every entry into Failed and
  // cleared on every exit from it. NULL on a Failed row that failed before 058.
  failureVerdict: jsonb("failure_verdict"),
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
// project_blocks (migration 040): one row per time Delivery halted a project. An open row is
// the halt itself (migration 059): opened and ended by Delivery's halt guard, ended as
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
  /** Migration 048: what the passing substrate probe observed, on an infrastructure halt it ended. */
  resumeEvidence: text("resume_evidence"),
  resumedReportId: uuid("resumed_report_id").references(() => clientMessages.id, { onDelete: "set null" }),
});

// ---------------------------------------------------------------------------
// plan_revisions (migration 042): one row per revision of a project's plan after
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
     * The earliest client answer it took in, which its report replies to; null for a plan repair
     * (migration 045). Every answer it took in is a replan_requests row naming it (migration 052).
     */
    requestedBy: uuid("requested_by").references(() => clientMessages.id, { onDelete: "cascade" }),
    /** 'client_change' or 'repair' (migration 045). */
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
// plan_repairs (migration 045): one row per task the failure router abandoned, written by a
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
// replan_requests (migration 052): one row per client answer that changed an assumption the plan
// was built on. While a row has no plan_revision_id the project awaits a revision and none of its
// tasks is dispatched; the revision that took the answer in is recorded on it.
// ---------------------------------------------------------------------------

export const replanRequests = pgTable("replan_requests", {
  answerId: uuid("answer_id")
    .primaryKey()
    .references(() => clientMessages.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  planRevisionId: uuid("plan_revision_id").references(() => planRevisions.id, { onDelete: "cascade" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
