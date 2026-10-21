import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { clientMessages, guaranteeVerdicts, visionDocuments, visionRevisions } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";
import { recordedSweep, sweepEvidence } from "@ashara/quality/published-reads";
import type { Evidence } from "../vision-language/index.js";
import { CheckEvidenceSchema } from "../vision-language/index.js";
import { StoredRevisionOpsSchema } from "../vision-language/contract-op.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import type { VisionVersion } from "../vision.js";
import { ContractRevisionMismatch, GuaranteeEvidenceMismatch, guaranteeTableOf } from "../guarantee-report.js";
import type { ContractRevision, GuaranteeRecords, GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import { REPORT_SUBJECT } from "../report-subjects.js";

// What a terminal message's guarantee table is read from: its sweep, the evidence that sweep
// recorded per guarantee and the vision version the evidence was recorded against, or, for a message
// no sweep is on record for, the version in force when it is told; every revision record of the
// project's contract, for its appendix; and the verdicts it persists beside the message, in the
// transaction that posts it.

/** guarantee_evidence.checks as stored: each stored check deciding the guarantee, its outcome and class. */
const StoredChecksSchema = z.array(
  z.strictObject({ taskCheckId: z.string().min(1), outcome: CheckEvidenceSchema.shape.outcome, class: CheckEvidenceSchema.shape.class }),
);

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
 * when it ran, its evidence unrecorded. No version by then is no contract on record.
 */
async function guaranteeRecordsOf(db: DbHandle, sweepId: string): Promise<GuaranteeRecords> {
  const sweep = await recordedSweep(db, sweepId);
  if (sweep === null) throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, "no acceptance_sweeps row has that id");
  const judged = { id: sweep.id, mainCommit: sweep.mainCommit };
  const rows = await sweepEvidence(db, sweepId);
  const versions = [...new Set(rows.map((row) => row.visionVersion))];
  if (versions.length > 1) throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, `its evidence names vision versions ${versions.join(", ")}, not one`);
  const [version] = versions;
  const [stored] = await db
    .select()
    .from(visionDocuments)
    .where(
      version === undefined
        ? and(eq(visionDocuments.projectId, sweep.projectId), lte(visionDocuments.createdAt, sweep.createdAt))
        : and(eq(visionDocuments.projectId, sweep.projectId), eq(visionDocuments.version, version)),
    )
    .orderBy(desc(visionDocuments.version))
    .limit(1);
  if (stored === undefined) {
    if (version === undefined) return { kind: "no-contract", sweep: judged };
    throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, `its evidence names vision v${version}, which the project does not hold`);
  }
  const vision = readVisionVersion(stored);
  const revisions = await revisionsOf(db, sweep.projectId);
  if (version === undefined) return { kind: "judged", sweep: judged, vision, evidence: { kind: "unrecorded" }, revisions };
  const byGuarantee = new Map<string, Evidence>();
  for (const row of rows) {
    const checks = StoredChecksSchema.safeParse(row.checks);
    if (!checks.success) throw new GuaranteeRecordsUnreadable(`sweep ${sweepId}`, `the evidence of ${row.guaranteeId} does not parse: ${z.prettifyError(checks.error)}`);
    byGuarantee.set(row.guaranteeId, {
      checks: checks.data.map((check) => ({ checkId: check.taskCheckId, outcome: check.outcome, class: check.class })),
      reviewLowers: row.reviewLowers,
    });
  }
  return { kind: "judged", sweep: judged, vision, evidence: { kind: "recorded", byGuarantee }, revisions };
}

/**
 * A message that carries the guarantee table as a terminal: the delivered report or acceptance notice of a sweep, a
 * halt's report, the client's stop report, or the planning-stopped report.
 */
const terminalReport = sql`(
  EXISTS (SELECT 1 FROM told_reports t WHERE t.report_id = ${clientMessages.id} AND t.subject_kind IN ('delivered', 'project-blocked'))
  OR ${inArray(clientMessages.reportsOn, [REPORT_SUBJECT.clientStop, REPORT_SUBJECT.planningStopped])})`;

/**
 * The verdict rows the project's last terminal report carries, as stored and unparsed; that the last terminal report
 * carries none (its table judged nothing: no contract, or records that did not read), never an older report's rows in
 * its place; or that the project has no terminal report.
 */
export async function lastReportGuaranteeVerdictsOf(db: DbHandle, projectId: string) {
  const [last] = await db
    .select({ reportId: clientMessages.id })
    .from(clientMessages)
    .where(and(eq(clientMessages.projectId, projectId), eq(clientMessages.direction, "outbound"), eq(clientMessages.kind, "report"), terminalReport))
    .orderBy(desc(clientMessages.createdAt), desc(clientMessages.id))
    .limit(1);
  if (last === undefined) return { kind: "no-terminal-report" } as const;
  const rows = await db
    .select({
      reportId: guaranteeVerdicts.reportId,
      guaranteeId: guaranteeVerdicts.guaranteeId,
      verdict: guaranteeVerdicts.verdict,
      reason: guaranteeVerdicts.reason,
      evidenceClass: guaranteeVerdicts.evidenceClass,
    })
    .from(guaranteeVerdicts)
    .where(eq(guaranteeVerdicts.reportId, last.reportId))
    .orderBy(asc(guaranteeVerdicts.guaranteeId));
  if (rows.length === 0) return { kind: "no-verdicts", reportId: last.reportId } as const;
  return { kind: "verdicts", reportId: last.reportId, rows } as const;
}

/**
 * The records of a message no sweep is on record for: the project's latest vision version, every
 * guarantee of it judged on no sweep; no version is no contract on record.
 */
async function recordsWithoutSweep(db: DbHandle, projectId: string): Promise<GuaranteeRecords> {
  const [stored] = await db.select().from(visionDocuments).where(eq(visionDocuments.projectId, projectId)).orderBy(desc(visionDocuments.version)).limit(1);
  if (stored === undefined) return { kind: "no-contract", sweep: null };
  return { kind: "judged", sweep: null, vision: readVisionVersion(stored), evidence: { kind: "unrecorded" }, revisions: await revisionsOf(db, projectId) };
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
    const unreadable = err instanceof GuaranteeRecordsUnreadable || err instanceof GuaranteeEvidenceMismatch || err instanceof ContractRevisionMismatch || err instanceof VisionUnreadable;
    if (!unreadable) throw err;
    const sweepId = source.kind === "sweep" ? source.sweepId : null;
    console.warn(`[guarantee-report] ${source.kind === "sweep" ? `sweep ${source.sweepId}` : `project ${source.projectId}`}: its guarantee table cannot be read, so its message judges no guarantee: ${describeErrorChain(err)}`);
    return { kind: "unreadable", sweepId };
  }
}

/** Persists a message's verdicts beside it, inside the transaction that posts it. */
export async function insertGuaranteeVerdicts(tx: DbHandle, projectId: string, reportId: string, table: TableVerdicts): Promise<void> {
  if (table.verdicts.length === 0) return;
  await tx.insert(guaranteeVerdicts).values(
    table.verdicts.map((verdict) => ({
      projectId,
      reportId,
      sweepId: table.sweepId,
      visionVersion: verdict.visionVersion,
      guaranteeId: verdict.guaranteeId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      basis: verdict.basis,
      evidenceClass: verdict.evidenceClass,
    })),
  );
}
