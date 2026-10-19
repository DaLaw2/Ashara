import { pgTable, uuid, varchar, text, jsonb, integer, boolean, unique, index, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// Engagement: the vision versions and the client channel.

// ---------------------------------------------------------------------------
// vision_documents
// ---------------------------------------------------------------------------

// `version` counts per project; UNIQUE (project_id, version) fails a racing
// writer closed instead of letting two rows share a version.
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
    openQuestions: jsonb("open_questions").notNull().default(sql`'[]'`),
    // 'scope-lines' or 'guarantees': which records hold the contract. A CHECK in the migration keeps
    // a guarantees row's interface and guarantees non-empty and its scope lines empty, and a
    // scope-lines row's contract lists empty.
    contractForm: text("contract_form").notNull().default("scope-lines"),
    interface: jsonb("interface").notNull().default(sql`'[]'`),
    guarantees: jsonb().notNull().default(sql`'[]'`),
    exclusions: jsonb().notNull().default(sql`'[]'`),
    changeReason: text("change_reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUnique: unique("vision_documents_project_version_unique").on(t.projectId, t.version),
  }),
);

// ---------------------------------------------------------------------------
// client_messages (the client channel, Engagement context)
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
    // Failed intake attempts of a tender, with the last one's error.
    intakeAttempts: integer("intake_attempts").notNull().default(0),
    intakeLastError: text("intake_last_error"),
    // Whose failure an answer's last counted reading attempt was, 'model' or 'provider'.
    intakeLastFailure: text("intake_last_failure"),
    // The planning outcome an outbound report tells the client about.
    reportsOn: varchar("reports_on", { length: 20 }),
    // An outbound question's 1-based rank among those posted with it.
    position: integer(),
    // On the inbound stop that moved its project to 'stopped': whether Delivery had it halted then.
    stopFoundHalted: boolean("stop_found_halted"),
  },
  (t) => ({
    projectCreatedIdx: index("idx_client_messages_project_created").on(t.projectId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// intake_readings (Engagement context)
// ---------------------------------------------------------------------------
// One row per project, written with vision v1: how many questions the tender's first reading asked
// and, when it asked none, the second reading that confirmed it or raised questions, with its
// strength, or that none answered at any strength. Its consistency is CHECKs in the migration.

export const intakeReadings = pgTable("intake_readings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  tenderId: uuid("tender_id")
    .notNull()
    .references(() => clientMessages.id, { onDelete: "cascade" }),
  firstProvider: text("first_provider").notNull(),
  firstModel: text("first_model").notNull(),
  firstQuestions: integer("first_questions").notNull(),
  confirmation: text().notNull(),
  secondStrength: text("second_strength"),
  secondProvider: text("second_provider"),
  secondModel: text("second_model"),
  secondQuestions: integer("second_questions"),
  judgedTier: text("judged_tier"),
  judgeTier: text("judge_tier"),
  passedOver: jsonb("passed_over").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// work_burn_warnings (Engagement context)
// ---------------------------------------------------------------------------
// One row per zone of the work ledger's fever chart a project entered in one plan revision, with
// the figures it was decided on and the Liaison's one report of it; the red zone's also carries
// what the operator is told. The primary key makes each zone once per project and revision.

export const workBurnWarnings = pgTable(
  "work_burn_warnings",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    planRevision: integer("plan_revision").notNull(),
    zone: text().notNull(),
    drawnRequests: integer("drawn_requests").notNull(),
    budgetRequests: integer("budget_requests").notNull(),
    reserveRequests: integer("reserve_requests").notNull(),
    upstreamRequests: integer("upstream_requests").notNull(),
    plannedTasks: integer("planned_tasks").notNull(),
    completedTasks: integer("completed_tasks").notNull(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => clientMessages.id),
    operatorReport: text("operator_report"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.planRevision, t.zone] })],
);

// ---------------------------------------------------------------------------
// guarantee_verdicts (Engagement context)
// ---------------------------------------------------------------------------
// One row per guarantee of the vision version a terminal message's sweep evidence was recorded
// against: its verdict, why it is unjudged, its basis and the class of evidence behind it. The
// vocabulary, "a reason exactly when unjudged" and "a pass rests on executed evidence" are CHECKs in
// the migration; the sweep's foreign key is there too. Append-only.

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
// vision_revisions (Engagement context)
// ---------------------------------------------------------------------------
// One row per revision of a project's contract after vision v1: who wrote it (the client, from the
// change or answer message it names, or Ashara, from none), who approved it, which way it moved what
// Ashara promises, why, its typed operations, and the Liaison's pushback when it held it. An applied
// revision names the version it wrote; a proposed one awaits the client's confirmation and wrote none.
// The consistency of each row is CHECKs in the migration.

export const visionRevisions = pgTable(
  "vision_revisions",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    basedOnVersion: integer("based_on_version").notNull(),
    version: integer(),
    author: text().notNull(),
    approver: text(),
    direction: text().notNull(),
    cause: text().notNull(),
    sourceMessageId: uuid("source_message_id").references(() => clientMessages.id, { onDelete: "cascade" }),
    confirmedByMessageId: uuid("confirmed_by_message_id").references(() => clientMessages.id, { onDelete: "cascade" }),
    ops: jsonb().notNull(),
    pushback: jsonb(),
    status: text().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUnique: unique("vision_revisions_project_version_unique").on(t.projectId, t.version),
  }),
);
