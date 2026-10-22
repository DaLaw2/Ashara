import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { visionDocuments, visionRevisions } from "@ashara/db/schema/engagement";
import type { DbHandle } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";
import { recordedSweep } from "@ashara/quality/published-reads";
import { GuaranteeEvidenceMismatch, GuaranteeEvidenceUnreadable, guaranteeVerdictsOf, recordReportVerdicts, reportVerdicts, sweepEvidenceVersion } from "@ashara/quality/published-verdicts";
import { StoredRevisionOpsSchema } from "../vision-language/contract-op.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import type { VisionVersion } from "../vision.js";
import { ContractRevisionMismatch, GuaranteeVerdictsMismatch, guaranteeTableOf } from "../guarantee-report.js";
import type { ContractRevision, GuaranteeRecords, GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import { lastTerminalReportId } from "./client-message.js";

// What a terminal message's guarantee table is read from: its sweep, the vision version that sweep's
// evidence was recorded against and Quality's verdict on each of its guarantees, or, for a message no
// sweep is on record for, the version in force when it is told; every revision record of the
// project's contract, for its appendix. The verdicts the message carries are persisted through
// Quality, in the transaction that posts it.

/** A sweep's or a project's records do not hold together as the source of a guarantee table; a retry reads the same. */
class GuaranteeRecordsUnreadable extends Error {
  constructor(
    readonly subject: string,
    readonly detail: string,
  ) {
    super(`${subject}: its guarantee table cannot be read: ${detail}`);
    this.name = "GuaranteeRecordsUnreadable";
  }
}

const RevisionAuthorSchema = z.enum(["client", "ashara"]);
const RevisionDirectionSchema = z.enum(["widens", "narrows", "neutral"]);

/**
 * Every revision record of the project's contract, in the order it was made, each with the vision
 * versions it revised and wrote. A record that does not parse, or names a version the project does
 * not hold, is a record that does not hold together: it throws, never reads as no revision.
 */
async function revisionsOf(db: DbHandle, projectId: string): Promise<ContractRevision[]> {
  const rows = await db
    .select()
    .from(visionRevisions)
    .where(eq(visionRevisions.projectId, projectId))
    .orderBy(asc(visionRevisions.createdAt), asc(visionRevisions.id));
  if (rows.length === 0) return [];
  const versions = new Map<number, VisionVersion>();
  for (const stored of await db.select().from(visionDocuments).where(eq(visionDocuments.projectId, projectId))) versions.set(stored.version, readVisionVersion(stored));
  const subject = `project ${projectId}`;
  const versionOf = (revisionId: string, version: number): VisionVersion => {
    const held = versions.get(version);
    if (held === undefined) throw new GuaranteeRecordsUnreadable(subject, `revision ${revisionId} names vision v${version}, which the project does not hold`);
    return held;
  };
  return rows.map((row): ContractRevision => {
    const ops = StoredRevisionOpsSchema.safeParse(row.ops);
    if (!ops.success) throw new GuaranteeRecordsUnreadable(subject, `the operations of revision ${row.id} do not parse: ${z.prettifyError(ops.error)}`);
    const author = RevisionAuthorSchema.safeParse(row.author);
    const direction = RevisionDirectionSchema.safeParse(row.direction);
    if (!author.success || !direction.success) throw new GuaranteeRecordsUnreadable(subject, `revision ${row.id} records author ${row.author} and direction ${row.direction}`);
    const common = { author: author.data, direction: direction.data, basedOn: versionOf(row.id, row.basedOnVersion), ops: ops.data };
    if (row.status === "proposed" && row.version === null) return { ...common, status: "proposed" };
    if (row.status === "applied" && row.version !== null) return { ...common, status: "applied", wrote: versionOf(row.id, row.version) };
    throw new GuaranteeRecordsUnreadable(subject, `revision ${row.id} records status ${row.status} with version ${row.version ?? "none"}`);
  });
}

/**
 * The records a sweep's table is judged from. The vision version is the one its evidence names; a
 * sweep with no evidence row (recorded before evidence per guarantee was) reads the version current
 * when it ran, its evidence unrecorded. No version by then is no contract on record. Each guarantee's
 * verdict is Quality's, judged on that version.
 */
async function guaranteeRecordsOf(db: DbHandle, sweepId: string): Promise<GuaranteeRecords> {
  const sweep = await recordedSweep(db, sweepId);
  if (sweep === null) throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, "no acceptance_sweeps row has that id");
  const judged = { id: sweep.id, mainCommit: sweep.mainCommit };
  const version = await sweepEvidenceVersion(db, sweepId);
  const [stored] = await db
    .select()
    .from(visionDocuments)
    .where(
      version === null
        ? and(eq(visionDocuments.projectId, sweep.projectId), lte(visionDocuments.createdAt, sweep.createdAt))
        : and(eq(visionDocuments.projectId, sweep.projectId), eq(visionDocuments.version, version)),
    )
    .orderBy(desc(visionDocuments.version))
    .limit(1);
  if (stored === undefined) {
    if (version === null) return { kind: "no-contract", sweep: judged };
    throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, `its evidence names vision v${version}, which the project does not hold`);
  }
  const vision = readVisionVersion(stored);
  const revisions = await revisionsOf(db, sweep.projectId);
  const verdicts = await guaranteeVerdictsOf(db, { kind: "sweep", sweep: judged }, vision.version, vision.guarantees);
  return { kind: "judged", sweep: judged, vision, judged: verdicts, revisions };
}

/**
 * The verdict rows the project's last terminal report carries, as stored and unparsed; that the last terminal report
 * carries none (its table judged nothing: no contract, or records that did not read), never an older report's rows in
 * its place; or that the project has no terminal report.
 */
export async function lastReportGuaranteeVerdictsOf(db: DbHandle, projectId: string) {
  const reportId = await lastTerminalReportId(db, projectId);
  if (reportId === null) return { kind: "no-terminal-report" } as const;
  const rows = await reportVerdicts(db, reportId);
  if (rows.length === 0) return { kind: "no-verdicts", reportId } as const;
  return { kind: "verdicts", reportId, rows } as const;
}

/**
 * The records of a message no sweep is on record for: the project's latest vision version, every
 * guarantee of it judged on no sweep; no version is no contract on record.
 */
async function recordsWithoutSweep(db: DbHandle, projectId: string): Promise<GuaranteeRecords> {
  const [stored] = await db.select().from(visionDocuments).where(eq(visionDocuments.projectId, projectId)).orderBy(desc(visionDocuments.version)).limit(1);
  if (stored === undefined) return { kind: "no-contract", sweep: null };
  const vision = readVisionVersion(stored);
  const judged = await guaranteeVerdictsOf(db, { kind: "no-sweep" }, vision.version, vision.guarantees);
  return { kind: "judged", sweep: null, vision, judged, revisions: await revisionsOf(db, projectId) };
}

/** Where a message's table is read from: its sweep, or, with none on record for it, its project's vision in force. */
export type TableSource = { readonly kind: "sweep"; readonly sweepId: string } | { readonly kind: "no-sweep"; readonly projectId: string };

/**
 * The table a terminal message carries. Records that do not hold together (evidence that does not
 * match its version, a version that does not read, a revision record that does not parse or names a
 * guarantee its versions do not hold) are the unreadable table, logged at warn with why, so the
 * message still goes out judging nothing; any other failure throws for a retry.
 */
export async function readGuaranteeTable(db: DbHandle, source: TableSource): Promise<GuaranteeTable> {
  try {
    return guaranteeTableOf(source.kind === "sweep" ? await guaranteeRecordsOf(db, source.sweepId) : await recordsWithoutSweep(db, source.projectId));
  } catch (err) {
    const unreadable =
      err instanceof GuaranteeRecordsUnreadable ||
      err instanceof GuaranteeEvidenceUnreadable ||
      err instanceof GuaranteeEvidenceMismatch ||
      err instanceof GuaranteeVerdictsMismatch ||
      err instanceof ContractRevisionMismatch ||
      err instanceof VisionUnreadable;
    if (!unreadable) throw err;
    const sweepId = source.kind === "sweep" ? source.sweepId : null;
    console.warn(`[guarantee-report] ${source.kind === "sweep" ? `sweep ${source.sweepId}` : `project ${source.projectId}`}: its guarantee table cannot be read, so its message judges no guarantee: ${describeErrorChain(err)}`);
    return { kind: "unreadable", sweepId };
  }
}

/** Persists a message's verdicts beside it through Quality, inside the transaction that posts it. */
export async function insertGuaranteeVerdicts(tx: DbHandle, projectId: string, reportId: string, table: TableVerdicts): Promise<void> {
  await recordReportVerdicts(tx, projectId, reportId, table);
}
