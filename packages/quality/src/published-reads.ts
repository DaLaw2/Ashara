import { and, asc, count, desc, eq, lte, type SQL } from "drizzle-orm";
import { qualifiedColumn } from "@ashara/db";
import { acceptanceSweeps, checkDisputes } from "@ashara/db/schema/quality";
import type { DbHandle } from "@ashara/db";

// Quality's published reads of its acceptance sweeps and its check disputes, for the contexts that
// tell the client of them: what another context reads of these tables goes through these, never a
// query of its own. Each returns Quality's rows as stored,
// its jsonb unread. This module imports nothing of Quality, so a context Quality reads can import it
// without a cycle at load time.

/** What a terminal sweep was run for: the client's consumed stop, or a halt episode. */
type SweptTerminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };

/** The id of the sweep recorded for the terminal; null when none is on record (its recording failed, or it is yet to run). */
export async function sweepOfTerminal(db: DbHandle, terminal: SweptTerminal): Promise<string | null> {
  const [sweep] = await db
    .select({ id: acceptanceSweeps.id })
    .from(acceptanceSweeps)
    .where(terminal.kind === "stop" ? eq(acceptanceSweeps.stopId, terminal.stopId) : eq(acceptanceSweeps.blockId, terminal.blockId));
  return sweep === undefined ? null : sweep.id;
}

/** A sweep as a reader's filter names it: its id and project, each an SQL expression over the sweep the read is of. */
export interface SweepRef {
  readonly id: SQL;
  readonly projectId: SQL;
}

/** A sweep as recorded: its project, the main commit it ran on (null when it ran on none) and when. */
export interface RecordedSweep {
  readonly id: string;
  readonly projectId: string;
  readonly mainCommit: string | null;
  readonly createdAt: Date;
}

const SWEEP: SweepRef = { id: qualifiedColumn(acceptanceSweeps.id), projectId: qualifiedColumn(acceptanceSweeps.projectId) };

const recorded = { id: acceptanceSweeps.id, projectId: acceptanceSweeps.projectId, mainCommit: acceptanceSweeps.mainCommit, createdAt: acceptanceSweeps.createdAt };

/**
 * Every passed sweep `where` admits, oldest first, each with what `annotate` selects of it: the
 * reader's own record of the sweep, read in the same statement, as Postgres returns it.
 */
export async function passedSweepsWhere(
  db: DbHandle,
  where: (sweep: SweepRef) => SQL | undefined,
  annotate: (sweep: SweepRef) => SQL<unknown>,
): Promise<Array<RecordedSweep & { readonly annotation: unknown }>> {
  return db
    .select({ ...recorded, annotation: annotate(SWEEP) })
    .from(acceptanceSweeps)
    .where(and(eq(acceptanceSweeps.passed, true), where(SWEEP)))
    .orderBy(asc(acceptanceSweeps.createdAt), asc(acceptanceSweeps.id));
}

/** The sweep `sweepId` names, passed or not as `passed` asks (either when undefined); null when there is no such sweep. */
export async function recordedSweep(db: DbHandle, sweepId: string, passed?: boolean): Promise<RecordedSweep | null> {
  const [sweep] = await db
    .select(recorded)
    .from(acceptanceSweeps)
    .where(and(eq(acceptanceSweeps.id, sweepId), passed === undefined ? undefined : eq(acceptanceSweeps.passed, passed)));
  return sweep ?? null;
}

/** A dispute of a stored check, with how many times its check task was disputed by then. */
export interface RecordedDispute {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly checkName: string;
  readonly reason: string;
  readonly disputes: number;
}

/** The project's last dispute recorded at or before `at`, with its check task's count of disputes then; null when none was. */
export async function lastDisputeBy(db: DbHandle, projectId: string, at: Date): Promise<RecordedDispute | null> {
  const [last] = await db
    .select({ taskId: checkDisputes.taskId, checkTaskId: checkDisputes.checkTaskId, checkName: checkDisputes.checkName, reason: checkDisputes.reason })
    .from(checkDisputes)
    .where(and(eq(checkDisputes.projectId, projectId), lte(checkDisputes.createdAt, at)))
    .orderBy(desc(checkDisputes.createdAt), desc(checkDisputes.id))
    .limit(1);
  if (last === undefined) return null;
  const [counted] = await db
    .select({ disputes: count() })
    .from(checkDisputes)
    .where(and(eq(checkDisputes.checkTaskId, last.checkTaskId), lte(checkDisputes.createdAt, at)));
  if (counted === undefined) return null;
  return { ...last, disputes: counted.disputes };
}
