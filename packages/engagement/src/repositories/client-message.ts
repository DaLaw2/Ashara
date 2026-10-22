import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { PROJECT_LIFECYCLES, ProjectRepository, insertedRow, projects, qualifiedColumn } from "@ashara/db";
import { clientMessages } from "@ashara/db/schema/engagement";
import type { Database, DbHandle, ProjectRow } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { HALT_KINDS, firstPlanned, openHaltKind, projectHalted, type HaltKind } from "@ashara/delivery/predicates";
import { INBOUND_KINDS, inboundDecision, type InboundKind, type InboundState } from "../inbound-policy.js";
import { clientMessageReadNow, noOpenStop, unverifiableContractHeld, visionWritten } from "../predicates.js";
import { REPORT_SUBJECT, type REPORT_SUBJECTS } from "../report-subjects.js";

// The client channel's one writer and reader in Engagement: the only file that holds the
// client_messages table object (boundary-rules.toml, module-names.client-messages). Every other file
// consumes, posts and reads a client message through the entries here, so the consumption below is
// the only one there is.

type ClientMessageRow = typeof clientMessages.$inferSelect;

/**
 * A message to insert. `kind` is Engagement's language and is validated by the
 * caller; the direction comes from the method, and the table's CHECK rejects a
 * kind that does not belong to that direction.
 */
interface NewClientMessage {
  /** The id a writer chose before posting, so it can tell whether the post is on record; generated when absent. */
  readonly id?: string;
  readonly projectId: ProjectId;
  readonly kind: string;
  readonly body: string;
  readonly inReplyTo: string | null;
}

// The only way a client message is consumed: consumeInbound takes a LockedStanding, and a
// LockedStanding exists only once its transaction holds the project row's lock and inboundDecision,
// read from the project's state after that lock, decided the message's reading. The lifecycle guard
// and the halt guard each lock the row to write, so the state it read holds until the transaction
// ends. Its constructor is private, so a writer that skips the check has no proof to consume with
// and does not compile.

const StateRowSchema = z.object({ lifecycle: z.enum(PROJECT_LIFECYCLES), halt: z.enum(HALT_KINDS).nullable(), visionWritten: z.boolean() });

/**
 * The project's lifecycle, its open halt's kind, whether its first vision is written and whether its
 * contract in force is declined: what inboundDecision decides a message by, and what a receipt states.
 */
export const projectStandingColumns = {
  lifecycle: projects.lifecycle,
  halt: openHaltKind(projects.id),
  visionWritten: visionWritten(projects.id),
  contractHeld: unverifiableContractHeld(projects.id),
};

/** Why the message's writer may not write under the project's present state: nothing is consumed. */
export interface StandingMoved {
  readonly kind: "moved";
  readonly detail: string;
}

interface Held {
  readonly tx: DbHandle;
  readonly projectId: ProjectId;
  readonly messageKind: InboundKind;
}

/**
 * The project row locked in `tx` (held to its end), then its state read in a statement of its own,
 * so the read sees what the writer the lock waited on committed. Null when the project does not exist.
 */
async function lockedState(tx: DbHandle, projectId: ProjectId): Promise<InboundState | null> {
  const [locked] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
  if (locked === undefined) return null;
  const [row] = await tx
    .select(projectStandingColumns)
    .from(projects)
    .where(eq(projects.id, projectId));
  if (row === undefined) return null;
  const state = StateRowSchema.parse(row);
  return state.lifecycle === "active" ? { lifecycle: "active", halt: state.halt, visionWritten: state.visionWritten } : { lifecycle: state.lifecycle };
}

function stateWords(state: InboundState): string {
  return `lifecycle '${state.lifecycle}'${state.lifecycle === "active" && state.halt !== null ? ", halted" : ""}`;
}

/** Proof that the project row is locked in `tx` and inboundDecision decided a message of `kind`'s reading under it. */
export class LockedStanding {
  private constructor(private readonly held: Held) {}

  get tx(): DbHandle {
    return this.held.tx;
  }

  get projectId(): ProjectId {
    return this.held.projectId;
  }

  get messageKind(): InboundKind {
    return this.held.messageKind;
  }

  /**
   * Locks the project row in `tx` and mints the proof when inboundDecision reads a message of `kind`
   * now. `paused` is whether the write was composed while the project was halted: a write composed
   * under the other state is moved too. Null for a stop, which is read in every state.
   */
  static async readNow(tx: DbHandle, projectId: ProjectId, kind: InboundKind, paused: boolean | null): Promise<LockedStanding | StandingMoved> {
    const state = await lockedState(tx, projectId);
    if (state === null) return { kind: "moved", detail: "the project does not exist" };
    if (inboundDecision(state, kind).reading !== "now") return { kind: "moved", detail: `the project no longer reads the client's input (${stateWords(state)})` };
    const halted = state.lifecycle === "active" && state.halt !== null;
    if (paused !== null && halted !== paused) {
      return { kind: "moved", detail: `composed while the project was ${paused ? "halted" : "at work"}, but it is now ${halted ? "halted" : "at work"}` };
    }
    return new LockedStanding({ tx, projectId, messageKind: kind });
  }

  /** Locks the project row in `tx` and mints the proof when inboundDecision never reads a message of `kind`: its receipt closes it. */
  static async neverRead(tx: DbHandle, projectId: ProjectId, kind: InboundKind): Promise<LockedStanding | StandingMoved> {
    const state = await lockedState(tx, projectId);
    if (state === null) return { kind: "moved", detail: "the project does not exist" };
    if (inboundDecision(state, kind).reading !== "never") return { kind: "moved", detail: `the project still reads the client's ${kind} (${stateWords(state)})` };
    return new LockedStanding({ tx, projectId, messageKind: kind });
  }
}

/**
 * Consumes the unconsumed inbound message `messageId` of the proof's project and kind, in the proof's
 * transaction. "not-open" when no such message is unconsumed.
 */
export async function consumeInbound(standing: LockedStanding, messageId: string): Promise<"consumed" | "not-open"> {
  const rows = await standing.tx
    .update(clientMessages)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(clientMessages.id, messageId),
        eq(clientMessages.projectId, standing.projectId),
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, standing.messageKind),
        isNull(clientMessages.consumedAt),
      ),
    )
    .returning({ id: clientMessages.id });
  return rows.length === 0 ? "not-open" : "consumed";
}

/** consumeInbound found no unconsumed inbound message of the proof's project and kind with this id. */
export class ClientMessageNotConsumable extends Error {
  constructor(readonly messageId: string) {
    super(`client message ${messageId} cannot be consumed: no unconsumed inbound message of its project and kind has this id`);
    this.name = "ClientMessageNotConsumable";
  }
}

/** The operation needed an unconsumed inbound tender with this id, and found none. */
class TenderNotOpen extends Error {
  constructor(
    readonly messageId: string,
    readonly operation: string,
  ) {
    super(`cannot ${operation}: client message ${messageId} is not an unconsumed inbound tender`);
    this.name = "TenderNotOpen";
  }
}

/**
 * Sets the failed-reading count of every unconsumed message of the project whose kind the end of an
 * `ended` halt resets (inboundDecision, in the project's vision state) back to none, keeping the last error's text on record (whose
 * failure it was goes with the count it qualifies): run in the transaction that ends the project's
 * halt, so a message whose readings ran out while the halt was open is read afresh once work resumes,
 * and the resumption is not halted again at once for a count no new reading made. Returns how many
 * messages it set back.
 */
export async function restartClientReadings(db: DbHandle, projectId: ProjectId, ended: HaltKind): Promise<number> {
  const resetKinds = (written: boolean): SQL | null => {
    const kinds = INBOUND_KINDS.filter((kind) => inboundDecision({ lifecycle: "active", halt: ended, visionWritten: written }, kind).resetOnHaltEnd);
    if (kinds.length === 0) return null;
    const vision = visionWritten(clientMessages.projectId);
    return sql`(${written ? vision : sql`NOT ${vision}`} AND ${inArray(clientMessages.kind, kinds)})`;
  };
  const byVision = [resetKinds(true), resetKinds(false)].filter((each): each is SQL => each !== null);
  if (byVision.length === 0) return 0;
  const rows = await db
    .update(clientMessages)
    .set({ intakeAttempts: 0, intakeLastFailure: null })
    .where(
      and(
        eq(clientMessages.projectId, projectId),
        eq(clientMessages.direction, "inbound"),
        or(...byVision),
        isNull(clientMessages.consumedAt),
        sql`${clientMessages.intakeAttempts} > 0`,
      ),
    )
    .returning({ id: clientMessages.id });
  return rows.length;
}

/**
 * The client channel's rows. No HTTP route
 * creates an outbound one.
 */
export class ClientMessageRepository {
  constructor(private readonly db: DbHandle) {}

  /** The row is owed one receipt from its insert on (repositories/client-receipt.ts): none is written here. */
  async insertInbound(message: NewClientMessage): Promise<ClientMessageRow> {
    return this.insert("inbound", message);
  }

  async insertOutbound(message: NewClientMessage): Promise<ClientMessageRow> {
    return this.insert("outbound", message);
  }

  async findById(id: string): Promise<ClientMessageRow | null> {
    const [row] = await this.db
      .select()
      .from(clientMessages)
      .where(eq(clientMessages.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Questions posted together in reply to one message, in the order given: each
   * row records its 1-based position, since rows written in one
   * transaction share a created_at.
   */
  async insertQuestions(
    projectId: ProjectId,
    inReplyTo: string,
    bodies: readonly string[],
  ): Promise<ClientMessageRow[]> {
    const rows: ClientMessageRow[] = [];
    for (const [i, body] of bodies.entries()) {
      const inserted = await this.db
        .insert(clientMessages)
        .values({ projectId, direction: "outbound", kind: "question", body, inReplyTo, position: i + 1 })
        .returning();
      rows.push(insertedRow(inserted, "client_messages", `post question ${i + 1} to project ${projectId}`));
    }
    return rows;
  }

  /**
   * Both directions, oldest first, questions posted together in their recorded
   * position; `since` keeps only rows created strictly after
   * it. created_at is compared at millisecond precision, the precision of a
   * returned createdAt, so passing back the last row's createdAt excludes that row.
   */
  async listByProject(projectId: ProjectId, since?: Date): Promise<ClientMessageRow[]> {
    const byProject = eq(clientMessages.projectId, projectId);
    const after = since
      ? sql`date_trunc('milliseconds', ${clientMessages.createdAt}) > ${since.toISOString()}::timestamptz`
      : undefined;
    return this.db
      .select()
      .from(clientMessages)
      .where(after ? and(byProject, after) : byProject)
      .orderBy(asc(clientMessages.createdAt), asc(clientMessages.position), asc(clientMessages.id));
  }

  /**
   * Inbound tenders not yet consumed, read now by inboundDecision
   * (clientMessageReadNow), oldest first: the Liaison's intake queue. One whose
   * project has a stop awaiting the Liaison stays unconsumed and is not taken in.
   */
  async listUnconsumedTenders(): Promise<ClientMessageRow[]> {
    return this.db
      .select()
      .from(clientMessages)
      .where(
        and(
          eq(clientMessages.direction, "inbound"),
          eq(clientMessages.kind, "tender"),
          isNull(clientMessages.consumedAt),
          sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${clientMessages.projectId} AND ${clientMessageReadNow("tender")})`,
          noOpenStop(clientMessages.projectId),
        ),
      )
      .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
  }

  /**
   * Counts one failed intake attempt on an unconsumed tender and records the
   * error that ended it. Returns the attempt count after this one.
   */
  async recordIntakeFailure(id: string, error: string): Promise<number> {
    const [row] = await this.db
      .update(clientMessages)
      .set({
        intakeAttempts: sql`${clientMessages.intakeAttempts} + 1`,
        intakeLastError: error,
      })
      .where(
        and(
          eq(clientMessages.id, id),
          eq(clientMessages.direction, "inbound"),
          eq(clientMessages.kind, "tender"),
          isNull(clientMessages.consumedAt),
        ),
      )
      .returning({ intakeAttempts: clientMessages.intakeAttempts });
    if (!row) throw new TenderNotOpen(id, "record a failed intake attempt");
    return row.intakeAttempts;
  }

  /** The answer already given to this question, or null when it has none. */
  async findAnswerTo(questionId: string): Promise<ClientMessageRow | null> {
    const [row] = await this.db
      .select()
      .from(clientMessages)
      .where(and(eq(clientMessages.inReplyTo, questionId), eq(clientMessages.kind, "answer")))
      .limit(1);
    return row ?? null;
  }

  private async insert(
    direction: "inbound" | "outbound",
    message: NewClientMessage,
  ): Promise<ClientMessageRow> {
    const rows = await this.db
      .insert(clientMessages)
      .values({
        ...(message.id === undefined ? {} : { id: message.id }),
        projectId: message.projectId,
        direction,
        kind: message.kind,
        body: message.body,
        inReplyTo: message.inReplyTo,
      })
      .returning();
    return insertedRow(rows, "client_messages", `insert a ${direction} ${message.kind} for project ${message.projectId}`);
  }
}

/** Whether an answer to the question has been read by the Liaison: one replying to it is consumed. */
export async function questionAnswerRead(db: DbHandle, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clientMessages.id })
    .from(clientMessages)
    .where(and(eq(clientMessages.inReplyTo, questionId), eq(clientMessages.kind, "answer"), isNotNull(clientMessages.consumedAt)))
    .limit(1);
  return row !== undefined;
}

export interface CreatedTender {
  readonly project: ProjectRow;
  readonly message: ClientMessageRow;
}

/**
 * A tender: the project row and its inbound 'tender' message, committed together
 * so no project exists without the tender that started it.
 */
export async function createProjectWithTender(
  db: Database,
  clientId: string,
  name: string,
  body: string,
): Promise<CreatedTender> {
  return db.transaction(async (tx) => {
    const project = await new ProjectRepository(tx).create(name, clientId);
    const message = await new ClientMessageRepository(tx).insertInbound({
      projectId: project.id,
      kind: "tender",
      body,
      inReplyTo: null,
    });
    return { project, message };
  });
}

/** A message that counts its failed readings toward a cap: an answer or a change. */
type CountedKind = "answer" | "change";

/**
 * The reading queue of `kind`: unconsumed inbound messages read now by inboundDecision
 * (clientMessageReadNow), under their cap of `maxAttempts` failed readings or read at it, of a
 * project with no stop awaiting the Liaison; `id` narrows it to that message.
 */
function readingQueue(kind: CountedKind, maxAttempts: number, id: string | null): SQL | undefined {
  return and(
    eq(clientMessages.direction, "inbound"),
    eq(clientMessages.kind, kind),
    isNull(clientMessages.consumedAt),
    clientMessageReadNow(kind),
    or(lt(clientMessages.intakeAttempts, maxAttempts), clientMessageReadNow(kind, "atCap")),
    noOpenStop(clientMessages.projectId),
    id === null ? undefined : eq(clientMessages.id, id),
  );
}

const readingColumns = {
  id: clientMessages.id,
  projectId: clientMessages.projectId,
  body: clientMessages.body,
  intakeAttempts: clientMessages.intakeAttempts,
  intakeLastError: clientMessages.intakeLastError,
  intakeLastFailure: clientMessages.intakeLastFailure,
};

// A project at work first, whose reading refused by its own spend cap ends the step (CoreLoop.step) and
// halts it; a halted project's refusal waits for its limit without ending the step (waitForLimit).
const readingOrder = (): SQL[] => [asc(projectHalted(projects.id)), asc(clientMessages.createdAt), asc(clientMessages.id)];

const questions = alias(clientMessages, "question");

/** The answers' reading queue, as stored, with the question each answers, whether its project has a first plan and whether Delivery has it halted. */
export async function openAnswerMessages(db: DbHandle, maxAttempts: number, answerId: string | null) {
  return db
    .select({
      ...readingColumns,
      questionId: questions.id,
      // An EXISTS is never null: the driver yields a boolean, decoded as one with no per-row parse to fail.
      planned: firstPlanned(projects.id).mapWith(Boolean),
      halted: projectHalted(projects.id).mapWith(Boolean),
    })
    .from(clientMessages)
    .innerJoin(questions, eq(questions.id, clientMessages.inReplyTo))
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(readingQueue("answer", maxAttempts, answerId))
    .orderBy(...readingOrder());
}

/** The changes' reading queue, as stored, with whether Delivery has each one's project halted. */
export async function openChangeMessages(db: DbHandle, maxAttempts: number, changeId: string | null) {
  return db
    .select({ ...readingColumns, halted: projectHalted(projects.id) })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(readingQueue("change", maxAttempts, changeId))
    .orderBy(...readingOrder());
}

/**
 * Counts one failed attempt to read the unconsumed inbound `kind` message `id`, with its error and
 * whose failure it was. The count after it; null when no such message is unconsumed.
 */
export async function recordReadingFailure(db: DbHandle, kind: CountedKind, id: string, error: string, failure: "model" | "provider"): Promise<number | null> {
  const [row] = await db
    .update(clientMessages)
    .set({ intakeAttempts: sql`${clientMessages.intakeAttempts} + 1`, intakeLastError: error, intakeLastFailure: failure })
    .where(and(eq(clientMessages.id, id), eq(clientMessages.direction, "inbound"), eq(clientMessages.kind, kind), isNull(clientMessages.consumedAt)))
    .returning({ intakeAttempts: clientMessages.intakeAttempts });
  return row === undefined ? null : row.intakeAttempts;
}

/** Inbound stops not yet consumed, read now by inboundDecision (clientMessageReadNow), oldest first, as stored. */
export async function unconsumedStopMessages(db: DbHandle): Promise<Array<{ readonly id: string; readonly projectId: string }>> {
  return db
    .select({ id: clientMessages.id, projectId: clientMessages.projectId })
    .from(clientMessages)
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNull(clientMessages.consumedAt),
        sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${clientMessages.projectId} AND ${clientMessageReadNow("stop")})`,
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
}

/** Whether the project's stop report is posted. */
function stopReportPostedSql(projectId: string | SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM client_messages r WHERE r.project_id = ${projectId} AND r.reports_on = ${REPORT_SUBJECT.clientStop})`;
}

/** Whether the project's stop report is posted; null when the project does not exist. */
export async function stopReportPosted(db: DbHandle, projectId: ProjectId): Promise<boolean | null> {
  const [row] = await db.select({ posted: stopReportPostedSql(projectId) }).from(projects).where(eq(projects.id, projectId));
  return row === undefined ? null : row.posted;
}

/** Records on the stop `stopId`, consumed in the proof's transaction, whether Delivery had its project halted when it stopped it. */
export async function recordStopFoundHalted(standing: LockedStanding, stopId: string, wasHalted: boolean): Promise<void> {
  await standing.tx
    .update(clientMessages)
    .set({ stopFoundHalted: wasHalted })
    .where(and(eq(clientMessages.id, stopId), eq(clientMessages.projectId, standing.projectId), eq(clientMessages.kind, standing.messageKind)));
}

/** Every stop that stopped its project, the project still stopped and with no stop report yet, oldest consumed first, as stored. */
export async function dueStopReportMessages(db: DbHandle) {
  return db
    .select({ stopId: clientMessages.id, projectId: clientMessages.projectId, paused: clientMessages.stopFoundHalted })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNotNull(clientMessages.stopFoundHalted),
        eq(projects.lifecycle, "stopped"),
        sql`NOT ${stopReportPostedSql(sql`${clientMessages.projectId}`)}`,
      ),
    )
    .orderBy(asc(clientMessages.consumedAt), asc(clientMessages.id));
}

/** What posting a stop's report did: posted (its project and the report's id), already posted for the project, or no inbound stop has the id. */
type StopReportPosting =
  | { readonly kind: "posted"; readonly projectId: string; readonly reportId: string }
  | { readonly kind: "already-posted" }
  | { readonly kind: "not-a-stop" };

/** Posts the report of the stop `stopId` in reply to it, once per project (the unique index on (project_id, reports_on)). */
export async function postOnStop(tx: DbHandle, stopId: string, body: string): Promise<StopReportPosting> {
  const [stop] = await tx
    .select({ projectId: clientMessages.projectId })
    .from(clientMessages)
    .where(and(eq(clientMessages.id, stopId), eq(clientMessages.direction, "inbound"), eq(clientMessages.kind, "stop")));
  if (stop === undefined) return { kind: "not-a-stop" };
  const reportId = await postOnSubject(tx, { projectId: stop.projectId, body, inReplyTo: stopId, reportsOn: REPORT_SUBJECT.clientStop }, "skip");
  return reportId === null ? { kind: "already-posted" } : { kind: "posted", projectId: stop.projectId, reportId };
}

/** An outbound report on one of the subjects a project gets at most one report on. */
interface SubjectReport {
  readonly projectId: string;
  readonly body: string;
  readonly inReplyTo: string | null;
  readonly reportsOn: (typeof REPORT_SUBJECTS)[number];
}

/**
 * Posts the report on its subject and returns its id. The partial unique index on (project_id,
 * reports_on) admits one per project: on a repeat, "skip" inserts nothing and returns null, and
 * "fail" fails the statement, rolling back the transaction it is in.
 */
export async function postOnSubject(tx: DbHandle, report: SubjectReport, onRepeat: "skip" | "fail"): Promise<string | null> {
  const insert = tx
    .insert(clientMessages)
    .values({ projectId: report.projectId, direction: "outbound", kind: "report", body: report.body, inReplyTo: report.inReplyTo, reportsOn: report.reportsOn });
  if (onRepeat === "fail") {
    return insertedRow(await insert.returning({ id: clientMessages.id }), "client_messages", `post the ${report.reportsOn} report to project ${report.projectId}`).id;
  }
  const [row] = await insert
    .onConflictDoNothing({ target: [clientMessages.projectId, clientMessages.reportsOn], where: isNotNull(clientMessages.reportsOn) })
    .returning({ id: clientMessages.id });
  return row === undefined ? null : row.id;
}

/** Posts an outbound report to the project, in reply to `inReplyTo` when it answers a message, and returns its id. */
export async function insertOutboundReport(tx: DbHandle, projectId: string, body: string, inReplyTo: string | null, what: string): Promise<string> {
  const rows = await tx
    .insert(clientMessages)
    .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo })
    .returning({ id: clientMessages.id });
  return insertedRow(rows, "client_messages", what).id;
}

/** Every inbound message owed a receipt, oldest first, with its project's standing, as stored. */
export async function dueReceiptMessages(db: DbHandle) {
  return db
    .select({
      messageId: clientMessages.id,
      projectId: clientMessages.projectId,
      kind: clientMessages.kind,
      consumed: sql<unknown>`(${clientMessages.consumedAt} IS NOT NULL)`,
      stoppedProject: sql<unknown>`(${clientMessages.stopFoundHalted} IS NOT NULL)`,
      ...projectStandingColumns,
    })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.receiptWaived, false),
        sql`NOT EXISTS (SELECT 1 FROM client_messages rc WHERE rc.receipt_of = ${clientMessages.id})`,
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
}

/** The inbound message `messageId` of the project, as stored: when it was consumed and its kind; null when the project has no such inbound message. */
export async function inboundMessageOf(db: DbHandle, messageId: string, projectId: string): Promise<{ readonly consumedAt: Date | null; readonly kind: string } | null> {
  const [message] = await db
    .select({ consumedAt: clientMessages.consumedAt, kind: clientMessages.kind })
    .from(clientMessages)
    .where(and(eq(clientMessages.id, messageId), eq(clientMessages.projectId, projectId), eq(clientMessages.direction, "inbound")));
  return message === undefined ? null : message;
}

/** Posts the receipt of the message `messageId` in reply to it; one per message (the unique index on receipt_of). */
export async function postReceiptOf(tx: DbHandle, receipt: { readonly projectId: string; readonly messageId: string; readonly body: string }): Promise<"posted" | "already-posted"> {
  const inserted = await tx
    .insert(clientMessages)
    .values({ projectId: receipt.projectId, direction: "outbound", kind: "report", body: receipt.body, inReplyTo: receipt.messageId, receiptOf: receipt.messageId })
    .onConflictDoNothing({ target: clientMessages.receiptOf })
    .returning({ id: clientMessages.id });
  return inserted.length === 0 ? "already-posted" : "posted";
}

/**
 * A message that carries the guarantee table as a terminal: the delivered report or acceptance notice of a sweep, a
 * halt's report, the client's stop report, or the planning-stopped report.
 */
const terminalReport = sql`(
  EXISTS (SELECT 1 FROM told_reports t WHERE t.report_id = ${clientMessages.id} AND t.subject_kind IN ('delivered', 'project-blocked'))
  OR ${inArray(clientMessages.reportsOn, [REPORT_SUBJECT.clientStop, REPORT_SUBJECT.planningStopped])})`;

/** The id of the project's last terminal report; null when it has none. */
export async function lastTerminalReportId(db: DbHandle, projectId: string): Promise<string | null> {
  const [last] = await db
    .select({ reportId: clientMessages.id })
    .from(clientMessages)
    .where(and(eq(clientMessages.projectId, projectId), eq(clientMessages.direction, "outbound"), eq(clientMessages.kind, "report"), terminalReport))
    .orderBy(desc(clientMessages.createdAt), desc(clientMessages.id))
    .limit(1);
  return last === undefined ? null : last.reportId;
}

/** The words of each client message `ids` names that exists. */
export async function clientMessageBodies(db: DbHandle, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: clientMessages.id, body: clientMessages.body }).from(clientMessages).where(inArray(clientMessages.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.body]));
}

/** A consumed stop as a reader's filter names it: its id, an SQL expression over the stop the read is of. */
export interface StopRef {
  readonly id: SQL;
}

/**
 * Every consumed stop that stopped its project, the project still stopped, that `where` admits,
 * earliest consumed first. The stop that stopped the project is the one that records it
 * (stop_found_halted), or, on a stop that records nothing of it, the one its stop report answers; a
 * second stop of a project already stopped stopped nothing.
 */
export async function stopsThatStopped(db: DbHandle, where: (stop: StopRef) => SQL | undefined): Promise<Array<{ readonly stopId: string; readonly projectId: string }>> {
  return db
    .select({ stopId: clientMessages.id, projectId: clientMessages.projectId })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNotNull(clientMessages.consumedAt),
        eq(projects.lifecycle, "stopped"),
        sql`(${clientMessages.stopFoundHalted} IS NOT NULL OR EXISTS (SELECT 1 FROM client_messages r WHERE r.in_reply_to = ${clientMessages.id} AND r.reports_on = ${REPORT_SUBJECT.clientStop}))`,
        where({ id: qualifiedColumn(clientMessages.id) }),
      ),
    )
    .orderBy(asc(clientMessages.consumedAt), asc(clientMessages.id));
}
