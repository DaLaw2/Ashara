import { eq } from "drizzle-orm";
import { z } from "zod";
import { PROJECT_LIFECYCLES, projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { HALT_KINDS } from "@ashara/delivery/predicates";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { INBOUND_KINDS } from "../inbound-policy.js";
import { receiptSubject } from "../client-receipt.js";
import type { DueReceipt, ProjectStanding, ReceiptWrite } from "../client-receipt.js";
import { LockedStanding, consumeInbound, dueReceiptMessages, inboundMessageOf, postReceiptOf, projectStandingColumns } from "./client-message.js";

// The receipts owed to the client's messages: an inbound message is owed one until an outbound
// report names it in receipt_of, whose unique index admits one per message, unless it was consumed
// before receipts existed (receipt_waived). A receipt and, for a closed project's message, its
// consumption are written in one transaction under the project row's lock, after the project's state
// and the message's consumption are read again, so a receipt never states a state that moved.

const InboundKindSchema = z.enum(INBOUND_KINDS);
const StandingRowSchema = z.object({
  lifecycle: z.enum(PROJECT_LIFECYCLES),
  halt: z.enum(HALT_KINDS).nullable(),
  visionWritten: z.boolean(),
  contractHeld: z.boolean(),
});
const DueRowSchema = z.object({ messageId: z.string(), projectId: z.string(), kind: z.string(), consumed: z.boolean(), stoppedProject: z.boolean() });

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
  const { lifecycle, halt, visionWritten: written, contractHeld } = StandingRowSchema.parse(row);
  const contract = contractHeld ? "held" : "workable";
  if (lifecycle === "active") {
    return halt === null ? { kind: "at-work", visionWritten: written, contract } : { kind: "paused", halt, visionWritten: written, contract };
  }
  if (halt !== null) throw new ProjectStandingIncoherent(projectId, lifecycle, halt);
  return { kind: lifecycle === "stopped" ? "stopped" : "accepted" };
}

function sameStanding(a: ProjectStanding, b: ProjectStanding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "paused" && b.kind === "paused") return a.halt === b.halt && a.visionWritten === b.visionWritten && a.contract === b.contract;
  if (a.kind === "at-work" && b.kind === "at-work") return a.visionWritten === b.visionWritten && a.contract === b.contract;
  return true;
}

/** Every inbound message owed a receipt, oldest first, with its project's state; each read on its own (readEach). */
export async function listDueReceipts(db: DbHandle): Promise<Array<DueReceipt | UnreadSubject>> {
  const rows = await dueReceiptMessages(db);
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

/** A receipt that consumes its message was asked for one a reader may still act on: only an unconsumed message inboundDecision says is never read is consumed by its receipt. */
class ReceiptCannotClose extends Error {
  constructor(readonly messageId: string) {
    super(`the receipt for client message ${messageId} was to consume it, but it is already consumed, or a message its project's state still reads`);
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
  write: ReceiptWrite,
): Promise<"posted" | "already-posted" | "moved"> {
  const { due } = write;
  return db.transaction(async (tx) => {
    const [project] = await tx.select(projectStandingColumns).from(projects).where(eq(projects.id, due.projectId)).for("update", { of: projects });
    const message = await inboundMessageOf(tx, due.messageId, due.projectId);
    if (project === undefined || message === null) throw new ReceiptMessageNotFound(due.messageId, due.projectId);
    if (!sameStanding(standingOf(due.projectId, project), due.standing) || (message.consumedAt !== null) !== due.consumed) return "moved";

    if ((await postReceiptOf(tx, { projectId: due.projectId, messageId: due.messageId, body: write.body })) === "already-posted") return "already-posted";

    if (write.closes) {
      const standing = await LockedStanding.neverRead(tx, due.projectId, InboundKindSchema.parse(message.kind));
      if (!(standing instanceof LockedStanding)) throw new ReceiptCannotClose(due.messageId);
      if ((await consumeInbound(standing, due.messageId)) === "not-open") throw new ReceiptCannotClose(due.messageId);
    }
    return "posted";
  });
}
