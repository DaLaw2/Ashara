import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { PROJECT_LIFECYCLES, clientMessages, projectReadsClientInput, projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { receiptSubject } from "../client-receipt.js";
import type { DueReceipt, ProjectStanding } from "../client-receipt.js";

// The receipts owed to the client's messages: an inbound message is owed one until an outbound
// report names it in receipt_of, whose unique index admits one per message, unless it was consumed
// before receipts existed (receipt_waived). A receipt and, for a closed project's message, its
// consumption are written in one transaction under the project row's lock, after the project's state
// and the message's consumption are read again, so a receipt never states a state that moved.

const InboundKindSchema = z.enum(["tender", "answer", "change", "stop"]);
const StandingRowSchema = z.object({ lifecycle: z.enum(PROJECT_LIFECYCLES), halt: z.string().nullable(), readsInput: z.boolean() });
const DueRowSchema = z.object({ messageId: z.string(), projectId: z.string(), kind: z.string(), consumed: z.boolean(), stoppedProject: z.boolean() });

/** The project's lifecycle, its open halt's kind, and whether its answers and changes are read: what a receipt states. */
const standingColumns = {
  lifecycle: projects.lifecycle,
  halt: sql<unknown>`(SELECT hb.kind FROM project_blocks hb WHERE hb.project_id = projects.id AND hb.ended_at IS NULL)`,
  readsInput: projectReadsClientInput(),
};

/** A stored lifecycle and halt that do not hold together: a stopped or delivered project has no open halt. */
class ProjectStandingIncoherent extends Error {
  constructor(
    readonly projectId: string,
    readonly lifecycle: string,
    readonly halt: string,
  ) {
    super(`project ${projectId} is '${lifecycle}' with an open '${halt}' halt, which only an active project can have; no receipt can state its state`);
    this.name = "ProjectStandingIncoherent";
  }
}

function standingOf(projectId: string, row: unknown): ProjectStanding {
  const { lifecycle, halt, readsInput } = StandingRowSchema.parse(row);
  if (lifecycle === "active") return halt === null ? { kind: "at-work" } : { kind: "paused", halt, readsInput };
  if (halt !== null) throw new ProjectStandingIncoherent(projectId, lifecycle, halt);
  return { kind: lifecycle === "stopped" ? "stopped" : "accepted" };
}

function sameStanding(a: ProjectStanding, b: ProjectStanding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "paused" && b.kind === "paused") return a.halt === b.halt && a.readsInput === b.readsInput;
  return true;
}

/** Every inbound message owed a receipt, oldest first, with its project's state; each read on its own (readEach). */
export async function listDueReceipts(db: DbHandle): Promise<Array<DueReceipt | UnreadSubject>> {
  const rows = await db
    .select({
      messageId: clientMessages.id,
      projectId: clientMessages.projectId,
      kind: clientMessages.kind,
      consumed: sql<unknown>`(${clientMessages.consumedAt} IS NOT NULL)`,
      stoppedProject: sql<unknown>`(${clientMessages.stopFoundHalted} IS NOT NULL)`,
      ...standingColumns,
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
  return readEach(
    rows,
    (row) => ({ id: receiptSubject(row.messageId), projectId: parseProjectId(row.projectId, "client_messages.project_id") }),
    (row): DueReceipt => {
      const due = DueRowSchema.parse(row);
      return {
        messageId: due.messageId,
        projectId: parseProjectId(due.projectId, "client_messages.project_id"),
        kind: InboundKindSchema.parse(due.kind),
        consumed: due.consumed,
        stoppedProject: due.stoppedProject,
        standing: standingOf(due.projectId, row),
      };
    },
  );
}

/** A receipt was asked for a message that is not an inbound message of its project. */
class ReceiptMessageNotFound extends Error {
  constructor(
    readonly messageId: string,
    readonly projectId: ProjectId,
  ) {
    super(`cannot post a receipt for client message ${messageId}: no inbound message of project ${projectId} has that id`);
    this.name = "ReceiptMessageNotFound";
  }
}

/** A receipt that consumes its message was asked for one a reader may still act on: only a closed project's unconsumed answer, change or tender is consumed by its receipt. */
class ReceiptCannotClose extends Error {
  constructor(readonly messageId: string) {
    super(`the receipt for client message ${messageId} was to consume it, but it is a stop, already consumed, or of a project that is not closed`);
    this.name = "ReceiptCannotClose";
  }
}

/**
 * In one transaction with the project row locked (every lifecycle and halt writer locks it too): the
 * project's state and the message's consumption read again, then the receipt posted in reply to the
 * message, and the message consumed with it when the write `closes` it. "moved" writes nothing.
 */
export async function postClientReceipt(
  db: Database,
  write: { readonly due: DueReceipt; readonly body: string; readonly closes: boolean },
): Promise<"posted" | "already-posted" | "moved"> {
  const { due } = write;
  return db.transaction(async (tx) => {
    const [project] = await tx.select(standingColumns).from(projects).where(eq(projects.id, due.projectId)).for("update", { of: projects });
    const [message] = await tx
      .select({ consumedAt: clientMessages.consumedAt, kind: clientMessages.kind })
      .from(clientMessages)
      .where(and(eq(clientMessages.id, due.messageId), eq(clientMessages.projectId, due.projectId), eq(clientMessages.direction, "inbound")));
    if (project === undefined || message === undefined) throw new ReceiptMessageNotFound(due.messageId, due.projectId);
    if (!sameStanding(standingOf(due.projectId, project), due.standing) || (message.consumedAt !== null) !== due.consumed) return "moved";

    const inserted = await tx
      .insert(clientMessages)
      .values({ projectId: due.projectId, direction: "outbound", kind: "report", body: write.body, inReplyTo: due.messageId, receiptOf: due.messageId })
      .onConflictDoNothing({ target: clientMessages.receiptOf })
      .returning({ id: clientMessages.id });
    if (inserted.length === 0) return "already-posted";

    if (write.closes) {
      if (message.kind === "stop" || due.standing.kind === "at-work" || due.standing.kind === "paused") throw new ReceiptCannotClose(due.messageId);
      const closed = await tx
        .update(clientMessages)
        .set({ consumedAt: new Date() })
        .where(and(eq(clientMessages.id, due.messageId), eq(clientMessages.direction, "inbound"), isNull(clientMessages.consumedAt)))
        .returning({ id: clientMessages.id });
      if (closed.length === 0) throw new ReceiptCannotClose(due.messageId);
    }
    return "posted";
  });
}
