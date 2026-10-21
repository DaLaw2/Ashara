import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ProjectRepository, insertedRow, projects } from "@ashara/db";
import { clientMessages } from "@ashara/db/schema/engagement";
import type { Database, DbHandle, ProjectRow } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { noOpenStop, projectAtWork } from "../predicates.js";

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

/**
 * markConsumed found no unconsumed inbound row with this id.
 * @testseam client-message.test.ts asserts the typed rejection
 */
export class ClientMessageNotConsumable extends Error {
  constructor(readonly messageId: string) {
    super(
      `client message ${messageId} cannot be consumed: no inbound row with this id is unconsumed`,
    );
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
 * Sets the failed-reading count of every unconsumed change and answer of the project back to none,
 * keeping the last error's text on record (whose failure it was goes with the count it qualifies): run
 * in the transaction that ends the project's halt, so a message whose readings ran out while the halt
 * was open is read afresh once work resumes, and the resumption is not halted again at once for a
 * count no new reading made. Returns how many messages it set back.
 */
export async function restartClientReadings(db: DbHandle, projectId: ProjectId): Promise<number> {
  const rows = await db
    .update(clientMessages)
    .set({ intakeAttempts: 0, intakeLastFailure: null })
    .where(
      and(
        eq(clientMessages.projectId, projectId),
        eq(clientMessages.direction, "inbound"),
        inArray(clientMessages.kind, ["change", "answer"]),
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
   * Inbound tenders not yet consumed, of active projects, oldest first: the
   * Liaison's intake queue. A halted project's tender stays unconsumed and is
   * not taken in, and so does one whose project has a stop awaiting the Liaison.
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
          sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${clientMessages.projectId} AND ${projectAtWork()})`,
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

  /**
   * Sets an unconsumed tender's count of failed intake attempts back to none, keeping the last
   * error on record: the tender is read again from no attempts once its project is unblocked.
   */
  async resetIntakeAttempts(id: string): Promise<void> {
    const [row] = await this.db
      .update(clientMessages)
      .set({ intakeAttempts: 0 })
      .where(
        and(
          eq(clientMessages.id, id),
          eq(clientMessages.direction, "inbound"),
          eq(clientMessages.kind, "tender"),
          isNull(clientMessages.consumedAt),
        ),
      )
      .returning({ id: clientMessages.id });
    if (!row) throw new TenderNotOpen(id, "reset its failed intake attempts");
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

  async markConsumed(id: string): Promise<ClientMessageRow> {
    const [row] = await this.db
      .update(clientMessages)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(clientMessages.id, id),
          eq(clientMessages.direction, "inbound"),
          isNull(clientMessages.consumedAt),
        ),
      )
      .returning();
    if (!row) throw new ClientMessageNotConsumable(id);
    return row;
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
