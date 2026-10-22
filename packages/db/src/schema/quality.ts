import { pgTable, uuid, boolean, text, jsonb, integer, primaryKey, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { projectBlocks, workItems } from "./delivery.js";
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
// it acted or did not (basis), and how its judges stood to the check work. Append-only; the jsonb
// columns are parsed by the repository.
// ---------------------------------------------------------------------------

/**
 * How the judges a suite review row rests on stood to the check work they judged: judge_tier, the
 * grade of the weaker of them (the first review, and the second where it answered); judged_tier,
 * the check work's tier; tier_relation, "above" or "equal". All three on every row written now
 * (*_tiers_recorded); none on a row written before they were recorded. first_tier and second_tier
 * are each review's grade as called, the second's only where one answered, so a reader names which
 * review was not above the work (*_review_tiers_recorded); neither on a row written before they were.
 */
function judgeTierColumns() {
  return {
    judgeTier: text("judge_tier"),
    judgedTier: text("judged_tier"),
    tierRelation: text("tier_relation"),
    firstTier: text("first_tier"),
    secondTier: text("second_tier"),
  };
}

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
  ...judgeTierColumns(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// suite_review_claims (Quality): one row per suite review whose outcome routed
// nothing: its claim that the checks decide the items it covers, with the second review that confirms
// it or not (basis) whole, at the strength it answered (second_strength) after the strengths it passed
// over, and how its judges stood to the check work. Append-only; second_findings, covered and
// passed_over are jsonb arrays.
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
  ...judgeTierColumns(),
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
// acceptance_sweeps: one row per sweep Z0 ran on main HEAD. An acceptance sweep
// that passed made its project 'accepted', a failed one opened its defect item. A
// terminal sweep ran once when the project reached a terminal short of acceptance
// (the client's stop, or a halt episode): it is never passed and opens nothing.
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
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  /** Every stored check the sweep ran, [{taskCheckId, taskId, name, command, outcome}] with outcome passed, failed or not-run; null on a row recorded before the column existed. */
  checkOutcomes: jsonb("check_outcomes"),
  /** "acceptance" or "terminal" (the acceptance_sweeps_purpose_known CHECK). */
  purpose: text().notNull().default("acceptance"),
  /** A terminal sweep's consumed client stop; null on every other sweep. */
  stopId: uuid("stop_id").references(() => clientMessages.id, { onDelete: "cascade" }),
  /** A terminal sweep's halt episode; null on every other sweep. */
  blockId: uuid("block_id").references(() => projectBlocks.id, { onDelete: "cascade" }),
});

// ---------------------------------------------------------------------------
// guarantee_evidence (Quality): one row per guarantee of the vision version in
// force per sweep, each stored check deciding it with its outcome and evidence
// class, an empty list when no check decides it. Append-only.
// ---------------------------------------------------------------------------

export const guaranteeEvidence = pgTable(
  "guarantee_evidence",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sweepId: uuid("sweep_id")
      .notNull()
      .references(() => acceptanceSweeps.id, { onDelete: "cascade" }),
    visionVersion: integer("vision_version").notNull(),
    guaranteeId: text("guarantee_id").notNull(),
    /** The sweep's main commit; null when the sweep ran on no commit, which then holds no check. */
    mainCommit: text("main_commit"),
    /** [{taskCheckId, outcome, class}], parsed by the repository. */
    checks: jsonb().notNull(),
    reviewLowers: boolean("review_lowers").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    onePerSweep: unique("guarantee_evidence_one_per_sweep").on(t.sweepId, t.guaranteeId),
  }),
);

// ---------------------------------------------------------------------------
// guarantee_verdicts (Quality): the verdicts each terminal message carries
// ---------------------------------------------------------------------------
// One row per guarantee of the vision version a terminal message's sweep evidence was recorded
// against: Quality's verdict, why it is unjudged, its basis and the class of evidence behind it,
// persisted beside the message in the transaction that posts it. The vocabulary, "a reason exactly
// when unjudged" and "a pass rests on executed evidence" are CHECKs in the migration; the sweep's
// foreign key is there too. Append-only.

export const guaranteeVerdicts = pgTable(
  "guarantee_verdicts",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => clientMessages.id, { onDelete: "cascade" }),
    // null when no sweep is on record for the message; every verdict is then unjudged (a CHECK).
    sweepId: uuid("sweep_id"),
    visionVersion: integer("vision_version").notNull(),
    guaranteeId: text("guarantee_id").notNull(),
    verdict: text().notNull(),
    reason: text(),
    basis: text().notNull(),
    evidenceClass: text("evidence_class").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    onePerReport: unique("guarantee_verdicts_one_per_report").on(t.reportId, t.guaranteeId),
  }),
);

// ---------------------------------------------------------------------------
// reviewer_outcomes (Quality): one row per piece of later evidence about one
// reviewer's verdict (a suite review claim or judgement, or an intake reading): its pass
// contradicted, or its finding witnessed or refuted, with the evidence it rests on. Append-only;
// a row leaves only with its project.
// ---------------------------------------------------------------------------

export const reviewerOutcomes = pgTable(
  "reviewer_outcomes",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    verdictKind: text("verdict_kind").notNull(),
    verdictId: uuid("verdict_id").notNull(),
    /** "provider/model", as the verdict's row names the model that answered. */
    reviewerModel: text("reviewer_model").notNull(),
    reviewerRole: text("reviewer_role").notNull(),
    outcome: text().notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    /** The evidence row: a check dispute's or acceptance sweep's id, or "<task id>#<revision>" of a re-authored check revision. */
    evidenceRef: text("evidence_ref").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    onePerEvidence: unique("reviewer_outcomes_one_per_evidence").on(t.verdictKind, t.verdictId, t.reviewerRole, t.evidenceKind, t.evidenceRef),
  }),
);
