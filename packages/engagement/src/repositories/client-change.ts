import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { clientMessages, noOpenStop, projectAtWork, projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { projectWorkBudget } from "@ashara/finance";
import type { WorkBudgets } from "@ashara/finance";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { CorrectionWrite, OpenChange, StoredProposal } from "../client-change.js";
import type { ChangeImpact, CitingTask } from "../correction.js";
import { ClientMessageRepository } from "./client-message.js";
import { VisionRepository } from "./vision.js";

// The client's changes of direction (client_messages kind 'change'): each read once against its
// project's current vision, and consumed together with the revisions it writes and the impact note
// posted in reply to it, so a change is never left unread and never answered twice.

/**
 * Unconsumed inbound changes of active projects, oldest first, each with its project's current vision,
 * every key its versions used and its proposals awaiting confirmation. A project with a stop awaiting
 * the Liaison is not listed, as for answers.
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
    })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "change"),
        isNull(clientMessages.consumedAt),
        projectAtWork(),
        noOpenStop(clientMessages.projectId),
        changeId === null ? undefined : eq(clientMessages.id, changeId),
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));

  const visions = new VisionRepository(db);
  const open: OpenChange[] = [];
  for (const row of rows) {
    const projectId = parseProjectId(row.projectId, "client_messages.project_id");
    open.push({
      ...row,
      projectId,
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

const count = z.coerce.number().int().nonnegative();
const CitingRowsSchema = z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), cites: z.array(z.string()) }));
const LedgerRowsSchema = z.tuple([z.object({ drawn: count, granted: count })]);

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

/** The implementation tasks of the project's current plan (none abandoned) and the vision keys each cites. */
const currentTasks = sql`w.level = 'Task' AND w.work_kind = 'implementation' AND w.status <> 'Abandoned'
  AND jsonb_typeof(w.task_spec->'sources') = 'array'`;

/**
 * What a correction of `ids` touches: the implementation tasks of the project's current plan citing
 * any of them, the requests each completed implementation task drew, and what the project's work
 * budget has left.
 */
export async function readChangeImpact(db: DbHandle, projectId: ProjectId, ids: readonly string[], budgets: WorkBudgets): Promise<ChangeImpact> {
  // The keys are vision keys (a letter and a number), so the array literal needs no quoting.
  const keys = `{${ids.join(",")}}`;
  const citing = await db.execute(sql`
    SELECT w.id, w.title, w.status,
      ARRAY(SELECT DISTINCT s->>'id' FROM jsonb_array_elements(w.task_spec->'sources') s
            WHERE s->>'id' = ANY(${keys}::text[])) AS cites
    FROM work_items w
    WHERE w.project_id = ${projectId} AND ${currentTasks}
    ORDER BY w.created_at, w.id`);
  const tasks = CitingRowsSchema.parse(citing.rows)
    .filter((row) => row.cites.length > 0)
    .map((row): CitingTask => ({ id: row.id, title: row.title, status: citingStatus(row.id, row.status), cites: row.cites }));
  const drawn = await db.execute(sql`
    SELECT (SELECT count(*) FROM llm_calls c WHERE c.task_id = w.id) AS drawn
    FROM work_items w
    WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.work_kind = 'implementation' AND w.status = 'Completed'`);
  const ledger = await db.execute(sql`
    SELECT (SELECT count(*) FROM llm_calls c WHERE c.project_id = ${projectId}) AS drawn,
           (SELECT COALESCE(sum(g.requests), 0) FROM work_grants g WHERE g.project_id = ${projectId}) AS granted`);
  const [figures] = LedgerRowsSchema.parse(ledger.rows);
  return {
    tasks,
    completedTaskRequests: z.array(z.object({ drawn: count })).parse(drawn.rows).map((row) => row.drawn),
    budgetLeftRequests: Math.max(0, projectWorkBudget(budgets, figures.granted).budgetRequests - figures.drawn),
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
 * recorded as a proposal, and the impact note posted in reply to it. A write composed against a vision
 * version that is no longer current is rolled back whole and returned as "moved".
 */
export async function recordCorrection(
  db: Database,
  write: CorrectionWrite,
): Promise<{ readonly kind: "recorded" } | { readonly kind: "already-consumed" } | { readonly kind: "moved"; readonly detail: string }> {
  try {
    return { kind: await writeCorrection(db, write) };
  } catch (err) {
    if (err instanceof ChangeContextMoved) return { kind: "moved", detail: err.message };
    throw err;
  }
}

function writeCorrection(db: Database, write: CorrectionWrite): Promise<"recorded" | "already-consumed"> {
  return db.transaction(async (tx) => {
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
    }
    const { revision } = write;
    if (revision?.status === "applied") {
      const applied = await visions.append(write.projectId, revision.vision, revision.record);
      if (applied.kind === "moved") throw moved(applied.current, revision.vision.basedOnVersion);
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
