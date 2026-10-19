import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, clientMessages, guaranteeEvidence, guaranteeVerdicts, visionDocuments } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";
import type { Evidence } from "../vision-language/index.js";
import { CheckEvidenceSchema } from "../vision-language/index.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import { GuaranteeEvidenceMismatch, guaranteeTableOf } from "../guarantee-report.js";
import type { GuaranteeRecords, GuaranteeTable, TableVerdicts } from "../guarantee-report.js";

// What a terminal message's guarantee table is read from: its sweep, the evidence that sweep
// recorded per guarantee and the vision version the evidence was recorded against, or, for a message
// no sweep is on record for, the version in force when it is told; and the verdicts it persists
// beside the message, in the transaction that posts it.

/** guarantee_evidence.checks as stored: each stored check deciding the guarantee, its outcome and class. */
const StoredChecksSchema = z.array(
  z.strictObject({ taskCheckId: z.string().min(1), outcome: CheckEvidenceSchema.shape.outcome, class: CheckEvidenceSchema.shape.class }),
);

/** A sweep's records do not hold together as the source of a guarantee table; a retry reads the same. */
class GuaranteeRecordsUnreadable extends Error {
  constructor(
    readonly sweepId: string,
    readonly detail: string,
  ) {
    super(`sweep ${sweepId}: its guarantee table cannot be read: ${detail}`);
    this.name = "GuaranteeRecordsUnreadable";
  }
}

/**
 * The records a sweep's table is judged from. The vision version is the one its evidence names; a
 * sweep with no evidence row (recorded before evidence per guarantee was) reads the version current
 * when it ran, its evidence unrecorded. No version by then is no contract on record.
 */
export async function guaranteeRecordsOf(db: DbHandle, sweepId: string): Promise<GuaranteeRecords> {
  const [sweep] = await db
    .select({ id: acceptanceSweeps.id, projectId: acceptanceSweeps.projectId, mainCommit: acceptanceSweeps.mainCommit, createdAt: acceptanceSweeps.createdAt })
    .from(acceptanceSweeps)
    .where(eq(acceptanceSweeps.id, sweepId));
  if (sweep === undefined) throw new GuaranteeRecordsUnreadable(sweepId, "no acceptance_sweeps row has that id");
  const judged = { id: sweep.id, mainCommit: sweep.mainCommit };
  const rows = await db
    .select({ guaranteeId: guaranteeEvidence.guaranteeId, visionVersion: guaranteeEvidence.visionVersion, checks: guaranteeEvidence.checks, reviewLowers: guaranteeEvidence.reviewLowers })
    .from(guaranteeEvidence)
    .where(eq(guaranteeEvidence.sweepId, sweepId));
  const versions = [...new Set(rows.map((row) => row.visionVersion))];
  if (versions.length > 1) throw new GuaranteeRecordsUnreadable(sweepId, `its evidence names vision versions ${versions.join(", ")}, not one`);
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
    throw new GuaranteeRecordsUnreadable(sweepId, `its evidence names vision v${version}, which the project does not hold`);
  }
  const vision = readVisionVersion(stored);
  if (version === undefined) return { kind: "judged", sweep: judged, vision, evidence: { kind: "unrecorded" } };
  const byGuarantee = new Map<string, Evidence>();
  for (const row of rows) {
    const checks = StoredChecksSchema.safeParse(row.checks);
    if (!checks.success) throw new GuaranteeRecordsUnreadable(sweepId, `the evidence of ${row.guaranteeId} does not parse: ${z.prettifyError(checks.error)}`);
    byGuarantee.set(row.guaranteeId, {
      checks: checks.data.map((check) => ({ checkId: check.taskCheckId, outcome: check.outcome, class: check.class })),
      reviewLowers: row.reviewLowers,
    });
  }
  return { kind: "judged", sweep: judged, vision, evidence: { kind: "recorded", byGuarantee } };
}

/**
 * The verdict rows the project's last terminal report carries, by guarantee id, as stored and unparsed: the newest
 * message any guarantee_verdicts row names. None when no report carries any.
 */
export async function lastReportGuaranteeVerdictsOf(db: DbHandle, projectId: string) {
  const [last] = await db
    .select({ reportId: guaranteeVerdicts.reportId })
    .from(guaranteeVerdicts)
    .innerJoin(clientMessages, eq(clientMessages.id, guaranteeVerdicts.reportId))
    .where(eq(guaranteeVerdicts.projectId, projectId))
    .orderBy(desc(clientMessages.createdAt), desc(clientMessages.id))
    .limit(1);
  if (last === undefined) return [];
  return db
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
}

/**
 * The records of a message no sweep is on record for: the project's latest vision version, every
 * guarantee of it judged on no sweep; no version is no contract on record.
 */
async function recordsWithoutSweep(db: DbHandle, projectId: string): Promise<GuaranteeRecords> {
  const [stored] = await db.select().from(visionDocuments).where(eq(visionDocuments.projectId, projectId)).orderBy(desc(visionDocuments.version)).limit(1);
  if (stored === undefined) return { kind: "no-contract", sweep: null };
  return { kind: "judged", sweep: null, vision: readVisionVersion(stored), evidence: { kind: "unrecorded" } };
}

/** Where a message's table is read from: its sweep, or, with none on record for it, its project's vision in force. */
export type TableSource = { readonly kind: "sweep"; readonly sweepId: string } | { readonly kind: "no-sweep"; readonly projectId: string };

/**
 * The table a terminal message carries. Records that do not hold together (evidence that does not
 * match its version, a version that does not read) are the unreadable table, logged at warn with
 * why, so the message still goes out judging nothing; any other failure throws for a retry.
 */
export async function readGuaranteeTable(db: DbHandle, source: TableSource): Promise<GuaranteeTable> {
  try {
    return guaranteeTableOf(source.kind === "sweep" ? await guaranteeRecordsOf(db, source.sweepId) : await recordsWithoutSweep(db, source.projectId));
  } catch (err) {
    if (!(err instanceof GuaranteeRecordsUnreadable) && !(err instanceof GuaranteeEvidenceMismatch) && !(err instanceof VisionUnreadable)) throw err;
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
