import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { projects } from "@ashara/db";
import { clientMessages, visionDocuments } from "@ashara/db/schema/engagement";
import type { Database, DbHandle } from "@ashara/db";
import { projectHalted } from "@ashara/delivery/predicates";
import { completedImplementationTaskIds, currentTasksCiting } from "@ashara/delivery/reads";
import { projectWork, projectWorkBudget, tasksWorkDrawn } from "@ashara/finance";
import type { WorkBudgets } from "@ashara/finance";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { clientMessageReadNow, noOpenStop } from "../predicates.js";
import type { HoldCorrection } from "../ports.js";
import { MAX_CHANGE_ATTEMPTS } from "../client-change.js";
import type { CorrectionWrite, OpenChange, StoredProposal } from "../client-change.js";
import { affectedKeys } from "../correction.js";
import type { ChangeImpact, CitingTask } from "../correction.js";
import { readVisionVersion } from "../vision.js";
import type { RevisionOp } from "../vision-language/contract-op.js";
import { ClientMessageRepository, clientInputStandingMoved } from "./client-message.js";
import { VisionRepository } from "./vision.js";

// The client's changes of direction (client_messages kind 'change'): each read once against its
// project's current vision, and consumed together with the revisions it writes, the hold on the work
// each applied revision touches and the impact note posted in reply to it, so a change is never left
// unread, never answered twice and never applied with the work it changes still dispatching.

/** An applied correction's version, or the one it was applied to, is not on record in its own transaction. */
class CorrectionVersionMissing extends Error {
  constructor(
    readonly projectId: string,
    readonly version: number,
  ) {
    super(`project ${projectId}: vision v${version - 1} and v${version}, which an applied correction reads and writes, are not both on record`);
    this.name = "CorrectionVersionMissing";
  }
}

/**
 * The guarantee and assumption keys a revision's operations affect, as applied as `version`: what a
 * task cites and a correction holds, read by affectedKeys against `version` and the version it was
 * applied to, as the correction's impact note reads them. Call it inside the correction's
 * transaction, after `version` is written.
 */
export async function affectedKeysOf(db: DbHandle, projectId: ProjectId, version: number, ops: readonly RevisionOp[]): Promise<string[]> {
  const rows = await db
    .select()
    .from(visionDocuments)
    .where(and(eq(visionDocuments.projectId, projectId), inArray(visionDocuments.version, [version - 1, version])));
  const appliedTo = rows.find((row) => row.version === version - 1);
  const written = rows.find((row) => row.version === version);
  if (appliedTo === undefined || written === undefined) throw new CorrectionVersionMissing(projectId, version);
  return affectedKeys(ops, readVisionVersion(appliedTo), readVisionVersion(written));
}

/**
 * Unconsumed inbound changes of active projects, those at work first, each oldest first, with its project's current vision,
 * every key its versions used, its proposals awaiting confirmation and whether it is halted. A halted
 * project's change is read all the same (a halt pauses the work, not the reading), except under a
 * halt the reading cannot get past, and a change at its cap of failed readings waits out any halt,
 * each as inboundDecision decides (clientMessageReadNow), which also holds a change of a project
 * with no vision yet for its tender's reading. One of a project with a stop awaiting the Liaison is
 * not listed, as for answers.
 */
export async function listUnconsumedChanges(db: DbHandle): Promise<OpenChange[]> {
  return openChangeRows(db, null);
}

/** One change as listUnconsumedChanges lists it, read now; null when it is no longer listed. */
export async function readOpenChange(db: DbHandle, changeId: string): Promise<OpenChange | null> {
  const [row] = await openChangeRows(db, changeId);
  return row ?? null;
}

const KeyRowsSchema = z.array(z.object({ key: z.string().min(1) }));
const ProposalRowsSchema = z.array(
  z.object({ id: z.string(), ops: z.unknown(), sourceMessageId: z.string().nullable(), sourceBody: z.string().nullable() }),
);

async function openChangeRows(db: DbHandle, changeId: string | null): Promise<OpenChange[]> {
  const rows = await db
    .select({
      id: clientMessages.id,
      projectId: clientMessages.projectId,
      body: clientMessages.body,
      intakeAttempts: clientMessages.intakeAttempts,
      intakeLastError: clientMessages.intakeLastError,
      intakeLastFailure: clientMessages.intakeLastFailure,
      halted: projectHalted(projects.id),
    })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "change"),
        isNull(clientMessages.consumedAt),
        clientMessageReadNow("change"),
        or(lt(clientMessages.intakeAttempts, MAX_CHANGE_ATTEMPTS), clientMessageReadNow("change", "atCap")),
        noOpenStop(clientMessages.projectId),
        changeId === null ? undefined : eq(clientMessages.id, changeId),
      ),
    )
    // A project at work first, whose reading refused by its own spend cap ends the step (CoreLoop.step) and
    // halts it; a halted project's refusal waits for its limit without ending the step (waitForLimit).
    .orderBy(asc(projectHalted(projects.id)), asc(clientMessages.createdAt), asc(clientMessages.id));

  const visions = new VisionRepository(db);
  const open: OpenChange[] = [];
  for (const row of rows) {
    const { halted, ...change } = row;
    const projectId = parseProjectId(row.projectId, "client_messages.project_id");
    open.push({
      ...change,
      projectId,
      paused: z.boolean().parse(halted),
      vision: await visions.getCurrent(projectId),
      usedKeys: await usedKeysOf(db, projectId),
      proposals: await proposalsOf(db, projectId),
    });
  }
  return open;
}

/** Every key of an interface entry, guarantee, exclusion or assumption any version of the project held. */
async function usedKeysOf(db: DbHandle, projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ids.key FROM vision_documents v,
      LATERAL (
        SELECT e->>'id' AS key FROM jsonb_array_elements(v."interface") e
        UNION ALL SELECT e->>'id' FROM jsonb_array_elements(v.guarantees) e
        UNION ALL SELECT e->>'id' FROM jsonb_array_elements(v.exclusions) e
        UNION ALL SELECT e->>'key' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.inferences) = 'array' THEN v.inferences ELSE '[]'::jsonb END) e
      ) ids
    WHERE v.project_id = ${projectId} AND ids.key IS NOT NULL
    ORDER BY ids.key`);
  return KeyRowsSchema.parse(result.rows).map((row) => row.key);
}

/** The project's revisions awaiting confirmation, oldest first, each with the message it was read from. */
async function proposalsOf(db: DbHandle, projectId: ProjectId): Promise<StoredProposal[]> {
  const result = await db.execute(sql`
    SELECT r.id, r.ops, r.source_message_id AS "sourceMessageId", m.body AS "sourceBody"
    FROM vision_revisions r LEFT JOIN client_messages m ON m.id = r.source_message_id
    WHERE r.project_id = ${projectId} AND r.status = 'proposed'
    ORDER BY r.created_at, r.id`);
  return ProposalRowsSchema.parse(result.rows).map((row) => ({
    id: row.id,
    ops: row.ops,
    source: row.sourceMessageId === null || row.sourceBody === null ? null : { messageId: row.sourceMessageId, body: row.sourceBody },
  }));
}


/** Finance's read of the requests each task drew names no figure for a task it was asked of. */
class TaskDrawnUnread extends Error {
  constructor(readonly taskId: string) {
    super(`the work ledger read names no requests drawn for completed task ${taskId}, which it was asked of`);
    this.name = "TaskDrawnUnread";
  }
}

function drawnOf(drawn: ReadonlyMap<string, number>, taskId: string): number {
  const requests = drawn.get(taskId);
  if (requests === undefined) throw new TaskDrawnUnread(taskId);
  return requests;
}

/** A citing task's status in the words the impact note uses; a status outside the current plan's never reaches here. */
class CitingTaskStatusUnknown extends Error {
  constructor(
    readonly taskId: string,
    readonly status: string,
  ) {
    super(`task ${taskId} cites an affected key with status ${status}, which no impact note words`);
    this.name = "CitingTaskStatusUnknown";
  }
}

function citingStatus(taskId: string, status: string): CitingTask["status"] {
  switch (status) {
    case "Pending":
      return "pending";
    case "InProgress":
      return "in progress";
    case "Blocked":
    case "Failed":
      return "blocked";
    case "Completed":
      return "merged";
    default:
      throw new CitingTaskStatusUnknown(taskId, status);
  }
}

/**
 * What a correction of `ids` touches: the implementation tasks of the project's current plan citing
 * any of them, the requests each completed implementation task drew, and what the project's work
 * budget has left.
 */
export async function readChangeImpact(db: DbHandle, projectId: ProjectId, ids: readonly string[], budgets: WorkBudgets): Promise<ChangeImpact> {
  const tasks = (await currentTasksCiting(db, projectId, ids)).map((row): CitingTask => ({ id: row.id, title: row.title, status: citingStatus(row.id, row.status), cites: row.cites }));
  const completed = await completedImplementationTaskIds(db, projectId, null, "planned");
  const drawnByTask = await tasksWorkDrawn(db, completed);
  const work = await projectWork(db, projectId);
  return {
    tasks,
    completedTaskRequests: completed.map((id) => drawnOf(drawnByTask, id)),
    budgetLeftRequests: Math.max(0, projectWorkBudget(budgets, work.granted).budgetRequests - work.drawn),
  };
}

/** An unconsumed inbound change with this id was needed, and none was found. */
class ChangeNotOpen extends Error {
  constructor(
    readonly changeId: string,
    readonly operation: string,
  ) {
    super(`cannot ${operation}: client message ${changeId} is not an unconsumed inbound change`);
    this.name = "ChangeNotOpen";
  }
}

/** Counts one failed attempt to read an unconsumed change with its error and whose failure it was; returns the count after it. */
export async function recordChangeFailure(db: DbHandle, changeId: string, error: string, failure: "model" | "provider"): Promise<number> {
  const [row] = await db
    .update(clientMessages)
    .set({ intakeAttempts: sql`${clientMessages.intakeAttempts} + 1`, intakeLastError: error, intakeLastFailure: failure })
    .where(and(eq(clientMessages.id, changeId), eq(clientMessages.direction, "inbound"), eq(clientMessages.kind, "change"), isNull(clientMessages.consumedAt)))
    .returning({ intakeAttempts: clientMessages.intakeAttempts });
  if (!row) throw new ChangeNotOpen(changeId, "record a failed attempt to read it");
  return row.intakeAttempts;
}

/** What the change was composed against no longer holds when the write's transaction reads it: nothing was written. */
class ChangeContextMoved extends Error {
  constructor(
    readonly changeId: string,
    readonly detail: string,
  ) {
    super(`change ${changeId} was composed against a state that moved: ${detail}; nothing was written`);
    this.name = "ChangeContextMoved";
  }
}

/**
 * In one transaction: the change consumed (a change already consumed gets nothing new), each proposal
 * it confirms applied as the next version, its own revision applied as the version after them or
 * recorded as a proposal, Delivery's hold on the work each applied version touches (`hold`), and the
 * impact note posted in reply to it, with the project row locked. A write composed against a vision
 * version that is no longer current, or while the project stood otherwise than it stands under the
 * lock (it no longer reads the client's input, or was halted or resumed meanwhile, which the note
 * states), writes nothing and is returned as "moved".
 */
export async function recordCorrection(
  db: Database,
  write: CorrectionWrite,
  hold: HoldCorrection,
): Promise<{ readonly kind: "recorded" } | { readonly kind: "already-consumed" } | { readonly kind: "moved"; readonly detail: string }> {
  try {
    return { kind: await writeCorrection(db, write, hold) };
  } catch (err) {
    if (err instanceof ChangeContextMoved) return { kind: "moved", detail: err.message };
    throw err;
  }
}

function writeCorrection(db: Database, write: CorrectionWrite, hold: HoldCorrection): Promise<"recorded" | "already-consumed"> {
  return db.transaction(async (tx) => {
    const standing = await clientInputStandingMoved(tx, write.projectId, "change", write.paused);
    if (standing !== null) throw new ChangeContextMoved(write.changeId, standing);
    const consumed = await tx
      .update(clientMessages)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(clientMessages.id, write.changeId),
          eq(clientMessages.projectId, write.projectId),
          eq(clientMessages.direction, "inbound"),
          eq(clientMessages.kind, "change"),
          isNull(clientMessages.consumedAt),
        ),
      )
      .returning({ id: clientMessages.id });
    if (consumed.length === 0) return "already-consumed";

    const visions = new VisionRepository(tx);
    const moved = (current: number | null, basedOn: number) =>
      new ChangeContextMoved(write.changeId, `composed against vision v${basedOn}, current is ${current === null ? "none" : `v${current}`}`);
    for (const confirmation of write.confirmations) {
      const [first, ...rest] = confirmation.ops;
      if (first === undefined) continue;
      const applied = await visions.applyProposal(write.projectId, confirmation.proposalId, write.changeId, confirmation.vision, {
        ops: [first, ...rest],
        direction: confirmation.direction,
      });
      if (applied.kind === "moved") throw moved(applied.current, confirmation.vision.basedOnVersion);
      await hold(tx, { projectId: write.projectId, visionVersion: applied.version, requestedBy: write.changeId, affected: await affectedKeysOf(tx, write.projectId, applied.version, confirmation.ops) });
    }
    const { revision } = write;
    if (revision?.status === "applied") {
      const applied = await visions.append(write.projectId, revision.vision, revision.record);
      if (applied.kind === "moved") throw moved(applied.current, revision.vision.basedOnVersion);
      await hold(tx, { projectId: write.projectId, visionVersion: applied.version, requestedBy: write.changeId, affected: await affectedKeysOf(tx, write.projectId, applied.version, revision.record.ops) });
    } else if (revision?.status === "proposed") {
      const current = await visions.getCurrent(write.projectId);
      if (current?.version !== revision.basedOnVersion) throw moved(current?.version ?? null, revision.basedOnVersion);
      await visions.propose(write.projectId, revision.basedOnVersion, revision.record);
    } else if (write.confirmations.length === 0) {
      const current = await visions.getCurrent(write.projectId);
      if (current?.version !== write.basedOnVersion) throw moved(current?.version ?? null, write.basedOnVersion);
    }
    await new ClientMessageRepository(tx).insertOutbound({ projectId: write.projectId, kind: "report", body: write.note, inReplyTo: write.changeId });
    return "recorded";
  });
}
