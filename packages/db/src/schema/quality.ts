import { pgTable, uuid, boolean, text, jsonb, integer, primaryKey, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { workItems } from "./delivery.js";
import { clientMessages } from "./engagement.js";
import { projects } from "./project.js";

// Quality: stored checks, disputes, suite reviews and acceptance sweeps.

// ---------------------------------------------------------------------------
// task_checks (Quality): the checks the check author wrote for an
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
    /** The commit the revision was red-run on, its plan revision's foundation; null on a row written before the column existed. */
    baselineCommit: text("baseline_commit"),
    /** The ids of the vision items the check decides, a non-empty jsonb array; null on a row written before the column existed. */
    decides: jsonb(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueName: unique("task_checks_unique_name").on(t.taskId, t.revision, t.name),
  }),
);

// ---------------------------------------------------------------------------
// check_disputes (Quality): an implementer's disputes of its task's
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
// suite_review_findings (Quality): one row per check task a review of a plan
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
// suite_review_judgements (Quality): one row per finding of a suite
// review's first pass that Z0 could not disprove, routed, released or advisory, with both reviews'
// findings whole, the second review's model and strength (none when no second review could change
// the outcome, or when it failed, with why in second_failure), the strengths it passed over, and why
// it acted or did not (basis). Append-only; the jsonb columns are parsed by the repository.
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
  secondStrength: text("second_strength"),
  passedOver: jsonb("passed_over").notNull(),
  secondFailure: text("second_failure"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// suite_review_claims (Quality): one row per suite review whose outcome routed
// nothing: its claim that the checks decide the items it covers, with the second review that confirms
// it or not (basis) whole, at the strength it answered (second_strength) after the strengths it passed
// over. Append-only; second_findings, covered and passed_over are jsonb arrays.
// ---------------------------------------------------------------------------

export const suiteReviewClaims = pgTable("suite_review_claims", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  reviewTaskId: uuid("review_task_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  basis: text().notNull(),
  covered: jsonb().notNull(),
  firstModel: text("first_model").notNull(),
  secondModel: text("second_model"),
  secondStrength: text("second_strength"),
  passedOver: jsonb("passed_over").notNull(),
  secondFindings: jsonb("second_findings").notNull(),
  secondFailure: text("second_failure"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// undecided_items (Quality): one row per cited item a suite review left
// undecided: a finding on it that did not act (judgement_id), or a claim covering it that no second
// review confirmed (claim_id), exactly one: the source that kept the row first. Every claim that
// leaves the item undecided, that first one included, is tied to it in undecided_item_claims, which
// the readers go through; the item is reported unverified. Append-only, one row per check task and item.
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
    judgementId: uuid("judgement_id").references(() => suiteReviewJudgements.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id").references(() => suiteReviewClaims.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    onePerCheckTask: unique("undecided_items_one_per_check_task").on(t.checkTaskId, t.itemId),
  }),
);

// ---------------------------------------------------------------------------
// undecided_item_claims (Quality): one row per claim and item it leaves undecided,
// so an item several claims leave undecided reads back under each of them. undecided_items.claim_id
// is held to a row here by a deferred foreign key the migration declares. Append-only.
// ---------------------------------------------------------------------------

export const undecidedItemClaims = pgTable(
  "undecided_item_claims",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => suiteReviewClaims.id, { onDelete: "cascade" }),
    checkTaskId: uuid("check_task_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.claimId, t.checkTaskId, t.itemId] }),
  }),
);

// ---------------------------------------------------------------------------
// check_set_freezes (Quality): one row per review task, written when the first
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
// acceptance_sweeps: one row per acceptance sweep Z0 ran on main HEAD; a passed
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
   * Failed attempts at the delivered report, the failed reads of its public interface
   * file among them, the last error, and when it is tried again.
   */
  reportFailures: integer("report_failures").notNull().default(0),
  reportInterfaceReadFailures: integer("report_interface_read_failures").notNull().default(0),
  reportLastError: text("report_last_error"),
  reportRetryAt: timestamptz("report_retry_at"),
  /** Failed attempts whose records are on file but do not read as a report; only these count toward the substitute notice. */
  reportRecordFailures: integer("report_record_failures").notNull().default(0),
  /** The stored checks a passed sweep ran and saw pass, [{taskId, name, command}]; null on a failed sweep or one recorded before the column existed. */
  executedChecks: jsonb("executed_checks"),
});
