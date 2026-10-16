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
// suite_review_judgements (migration 063, Quality): one row per outside-vision rejection a suite
// review made that Z0 could not disprove, routed or released, with both reviews' findings whole and
// what the second review was. Append-only; the jsonb columns are parsed by the repository.
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
  checkName: text("check_name").notNull(),
  outcome: text().notNull(),
  firstFinding: jsonb("first_finding").notNull(),
  secondFindings: jsonb("second_findings").notNull(),
  firstModel: text("first_model").notNull(),
  secondModel: text("second_model").notNull(),
  secondReview: text("second_review").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
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
