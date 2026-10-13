import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { clientMessages } from "../schema.js";
import { ProjectRepository, type ProjectRecord } from "./project.js";

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

/**
 * The client channel's rows (architecture K1, migration 016). The only writer of
 * outbound messages: no HTTP route creates one.
 */
export class ClientMessageRepository {
  constructor(private readonly db: DbHandle) {}

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
   * Both directions, oldest first; `since` keeps only rows created strictly after
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
      .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
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
    const [row] = await this.db
      .insert(clientMessages)
      .values({
        projectId: message.projectId,
        direction,
        kind: message.kind,
        body: message.body,
        inReplyTo: message.inReplyTo,
      })
      .returning();
    return row;
  }
}

export interface CreatedTender {
  readonly project: ProjectRecord;
  readonly message: ClientMessageRow;
}

/**
 * A tender: the project row and its inbound 'tender' message, committed together
 * so no project exists without the tender that started it.
 */
export async function createProjectWithTender(
  db: Database,
  name: string,
  body: string,
): Promise<CreatedTender> {
  return db.transaction(async (tx) => {
    const project = await new ProjectRepository(tx).create(name);
    const message = await new ClientMessageRepository(tx).insertInbound({
      projectId: project.id,
      kind: "tender",
      body,
      inReplyTo: null,
    });
    return { project, message };
  });
}
