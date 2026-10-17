import { pgTable, uuid, boolean, text, jsonb, integer, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { workItems } from "./delivery.js";
import { clientMessages } from "./engagement.js";
import { projects } from "./project.js";

// Quality: stored checks, disputes, suite reviews and acceptance sweeps.

// ---------------------------------------------------------------------------
// task_checks (migration 036, Quality): the checks the check author wrote for an
// implementation task, one row per check, append-only by revision. files is
// jsonb [{path, content}], parsed by the repository.
// ---------------------------------------------------------------------------

export const taskChecks = pgTable(
  "task_checks",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workItems.id),
    checkTaskId: uuid("check_task_id")
      .notNull()
      .references(() => workItems.id),
    revision: integer().notNull(),
    name: text().notNull(),
    command: text().notNull(),
    files: jsonb().notNull(),
    environmentVersion: text("environment_version").notNull(),
    /** The commit the revision was red-run on, its plan revision's foundation (migration 045); null before 045. */
    baselineCommit: text("baseline_commit"),
    /** The ids of the vision items the check decides, a non-empty jsonb array (migration 064); null before 064. */
    decides: jsonb(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueName: unique("task_checks_unique_name").on(t.taskId, t.revision, t.name),
  }),
);

// ---------------------------------------------------------------------------
// check_disputes (migration 039, Quality): an implementer's disputes of its task's
// stored checks, one row per dispute, append-only. Their count per check task
// bounds how often that check task is reopened to answer one.
// ---------------------------------------------------------------------------

export const checkDisputes = pgTable("check_disputes", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  taskId: uuid("task_id")
    .notNull()
    .references(() => workItems.id),
  checkTaskId: uuid("check_task_id")
    .notNull()
    .references(() => workItems.id),
  revision: integer().notNull(),
  checkName: text("check_name").notNull(),
  reason: text().notNull(),
  evidence: text(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// suite_review_findings (migration 044, Quality): one row per check task a review of a plan
// revision's suites named, with the problems naming it, append-only. Their count per check task
// bounds how often that check task is reopened for a review. problems is jsonb, parsed by the
// repository.
// ---------------------------------------------------------------------------

export const suiteReviewFindings = pgTable("suite_review_findings", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  reviewTaskId: uuid("review_task_id")
    .notNull()
    .references(() => workItems.id),
  checkTaskId: uuid("check_task_id")
    .notNull()
    .references(() => workItems.id),
  problems: jsonb().notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// suite_review_judgements (migrations 063, 069, 071, Quality): one row per finding of a suite review's
// first pass that Z0 could not disprove, routed, released or advisory, with both reviews' findings
// whole, what the second review was (none when no second review could change the outcome, or when
// it failed, with why in second_failure) and why it acted or did not (basis). Append-only; the jsonb
// columns are parsed by the repository.
// ---------------------------------------------------------------------------

export const suiteReviewJudgements = pgTable("suite_review_judgements", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  reviewTaskId: uuid("review_task_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  checkTaskId: uuid("check_task_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  /** The rejected check of an outside-vision finding; null for the other kinds. */
  checkName: text("check_name"),
  outcome: text().notNull(),
  basis: text().notNull(),
  firstFinding: jsonb("first_finding").notNull(),
  secondFindings: jsonb("second_findings").notNull(),
  firstModel: text("first_model").notNull(),
  secondModel: text("second_model"),
  secondReview: text("second_review"),
  secondFailure: text("second_failure"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// undecided_items (migration 069, Quality): one row per cited item a suite review found no check
// deciding where that finding did not act; the item stays undecided and is reported unverified.
// Append-only, one row per check task and item.
// ---------------------------------------------------------------------------

export const undecidedItems = pgTable(
  "undecided_items",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    reviewTaskId: uuid("review_task_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    checkTaskId: uuid("check_task_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    itemText: text("item_text").notNull(),
    judgementId: uuid("judgement_id")
      .notNull()
      .references(() => suiteReviewJudgements.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    onePerCheckTask: unique("undecided_items_one_per_check_task").on(t.checkTaskId, t.itemId),
  }),
);

// ---------------------------------------------------------------------------
// check_set_freezes (migration 069, Quality): one row per review task, written when the first
// implementation task depending on it is dispatched, with the check set it reviewed as it then
// stood. Append-only; check_set is parsed by the repository.
// ---------------------------------------------------------------------------

export const checkSetFreezes = pgTable("check_set_freezes", {
  reviewTaskId: uuid("review_task_id")
    .primaryKey()
    .references(() => workItems.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  frozenBy: uuid("frozen_by")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  checkSet: jsonb("check_set").notNull(),
  frozenAt: timestamptz("frozen_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// acceptance_sweeps (migration 049): one row per acceptance sweep Z0 ran on main HEAD; a passed
// one made its project 'accepted', a failed one opened its defect item.
// ---------------------------------------------------------------------------

export const acceptanceSweeps = pgTable("acceptance_sweeps", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  mainCommit: text("main_commit"),
  environmentVersion: text("environment_version"),
  checkedTasks: jsonb("checked_tasks").notNull(),
  uncheckedTasks: jsonb("unchecked_tasks").notNull(),
  passed: boolean().notNull(),
  details: text().notNull(),
  defectItemId: uuid("defect_item_id").references(() => workItems.id, { onDelete: "cascade" }),
  reportId: uuid("report_id").references(() => clientMessages.id, { onDelete: "set null" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  /**
   * Migration 062: failed attempts at the delivered report, the failed reads of its public interface
   * file among them, the last error, and when it is tried again.
   */
  reportFailures: integer("report_failures").notNull().default(0),
  reportInterfaceReadFailures: integer("report_interface_read_failures").notNull().default(0),
  reportLastError: text("report_last_error"),
  reportRetryAt: timestamptz("report_retry_at"),
  /** Migration 063: failed attempts whose records are on file but do not read as a report; only these count toward the substitute notice. */
  reportRecordFailures: integer("report_record_failures").notNull().default(0),
  /** Migration 065: the stored checks a passed sweep ran and saw pass, [{taskId, name, command}]; null on a failed sweep or one recorded before 065. */
  executedChecks: jsonb("executed_checks"),
});
