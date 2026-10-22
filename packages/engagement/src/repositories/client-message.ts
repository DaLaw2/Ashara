import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { PROJECT_LIFECYCLES, ProjectRepository, insertedRow, projects } from "@ashara/db";
import { clientMessages } from "@ashara/db/schema/engagement";
import type { Database, DbHandle, ProjectRow } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { HALT_KINDS, openHaltKind, type HaltKind } from "@ashara/delivery/predicates";
import { INBOUND_KINDS, inboundDecision, type InboundKind, type InboundState } from "../inbound-policy.js";
import { clientMessageReadNow, noOpenStop, visionWritten } from "../predicates.js";

type ClientMessageRow = typeof clientMessages.$inferSelect;

/**
 * A message to insert. `kind` is Engagement's language and is validated by the
 * caller; the direction comes from the method, and the table's CHECK rejects a
 * kind that does not belong to that direction.
 */
interface NewClientMessage {
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
    .select({ lifecycle: projects.lifecycle, halt: openHaltKind(projects.id), visionWritten: visionWritten(projects.id) })
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
