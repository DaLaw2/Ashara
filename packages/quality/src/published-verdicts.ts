import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { guaranteeEvidence, guaranteeVerdicts } from "@ashara/db/schema/quality";
import type { DbHandle } from "@ashara/db";
import type { VisionGuarantee } from "./acl/engagement-acl.js";
import { CheckEvidenceSchema, judgeGuarantees } from "./guarantee-verdict.js";
import type { Evidence, GuaranteeVerdict, JudgedGuarantee, JudgedSweep } from "./guarantee-verdict.js";

// Quality's published guarantee verdicts, for the context that tells the client of them: the verdict
// on every guarantee of a terminal message's table, judged here from the evidence a sweep recorded,
// and the verdicts each message carries, persisted beside it in the transaction that posts it
// (guarantee_verdicts), and whether Ashara can verify a guarantee at all, which the contract records
// when the guarantee is proposed. A reader renders these and never judges a guarantee itself. This module
// imports nothing of Quality that reads another context at run time, so a context Quality reads can
// import it without a cycle at load time.

export type { EvidenceClass, GuaranteeVerdict, JudgedSweep, UnjudgedReason, Verdict } from "./guarantee-verdict.js";
export { GuaranteeEvidenceMismatch, verificationOf } from "./guarantee-verdict.js";

/** guarantee_evidence.checks as stored: each stored check deciding the guarantee, its outcome and class, and whether a standing review finding lowers it. */
const StoredChecksSchema = z.array(
  z.strictObject({
    taskCheckId: z.string().min(1),
    outcome: CheckEvidenceSchema.shape.outcome,
    class: CheckEvidenceSchema.shape.class,
    lowered: CheckEvidenceSchema.shape.lowered,
  }),
);

/** A sweep's recorded evidence does not read as the evidence of one vision version; a retry reads the same. */
export class GuaranteeEvidenceUnreadable extends Error {
  constructor(
    readonly sweepId: string,
    readonly detail: string,
  ) {
    super(`sweep ${sweepId}: its guarantee evidence cannot be read: ${detail}`);
    this.name = "GuaranteeEvidenceUnreadable";
  }
}

async function evidenceRows(db: DbHandle, sweepId: string) {
  return db
    .select({ guaranteeId: guaranteeEvidence.guaranteeId, visionVersion: guaranteeEvidence.visionVersion, checks: guaranteeEvidence.checks })
    .from(guaranteeEvidence)
    .where(eq(guaranteeEvidence.sweepId, sweepId));
}

function versionOf(sweepId: string, rows: ReadonlyArray<{ readonly visionVersion: number }>): number | null {
  const versions = [...new Set(rows.map((row) => row.visionVersion))];
  if (versions.length > 1) throw new GuaranteeEvidenceUnreadable(sweepId, `its evidence names vision versions ${versions.join(", ")}, not one`);
  const [version] = versions;
  return version === undefined ? null : version;
}

/**
 * The vision version the sweep's evidence was recorded against; null for a sweep with no evidence row
 * (recorded before evidence per guarantee was, or with no contract in force). Evidence naming more
 * than one version throws GuaranteeEvidenceUnreadable.
 */
export async function sweepEvidenceVersion(db: DbHandle, sweepId: string): Promise<number | null> {
  return versionOf(sweepId, await evidenceRows(db, sweepId));
}

/** What a message's verdicts are judged on: a recorded sweep, or none on record for the message. */
export type VerdictSource = { readonly kind: "sweep"; readonly sweep: JudgedSweep } | { readonly kind: "no-sweep" };

/** A message's verdicts, with whether its sweep's evidence per guarantee was on record. */
export interface JudgedVerdicts {
  readonly evidence: "recorded" | "unrecorded";
  readonly verdicts: readonly GuaranteeVerdict[];
}

/**
 * The verdict on every guarantee of vision version `visionVersion` (its `guarantees`, in order), judged
 * on the source's evidence: none on record judges each on no evidence, and no sweep or one that ran on no
 * commit judges each unjudged for want of a sweep on a commit. Evidence that does not parse, names
 * another version or does not match the guarantees throws (GuaranteeEvidenceUnreadable,
 * GuaranteeEvidenceMismatch), never reads as no evidence.
 */
export async function guaranteeVerdictsOf(db: DbHandle, source: VerdictSource, visionVersion: number, guarantees: readonly JudgedGuarantee[]): Promise<JudgedVerdicts> {
  if (source.kind === "no-sweep") return { evidence: "unrecorded", verdicts: judgeGuarantees(guarantees, visionVersion, null, { kind: "unrecorded" }) };
  const { sweep } = source;
  const rows = await evidenceRows(db, sweep.id);
  const recorded = versionOf(sweep.id, rows);
  if (recorded === null) return { evidence: "unrecorded", verdicts: judgeGuarantees(guarantees, visionVersion, sweep, { kind: "unrecorded" }) };
  if (recorded !== visionVersion) throw new GuaranteeEvidenceUnreadable(sweep.id, `its evidence names vision v${recorded}, not v${visionVersion}`);
  const byGuarantee = new Map<string, Evidence>();
  for (const row of rows) {
    const checks = StoredChecksSchema.safeParse(row.checks);
    if (!checks.success) throw new GuaranteeEvidenceUnreadable(sweep.id, `the evidence of ${row.guaranteeId} does not parse: ${z.prettifyError(checks.error)}`);
    byGuarantee.set(row.guaranteeId, {
      checks: checks.data.map((check) => ({ checkId: check.taskCheckId, outcome: check.outcome, class: check.class, lowered: check.lowered })),
    });
  }
  return { evidence: "recorded", verdicts: judgeGuarantees(guarantees, visionVersion, sweep, { kind: "recorded", byGuarantee }) };
}

/** One verdict a message carries: Quality's verdict, the vision version it was judged on and the guarantee's basis there. */
interface ReportVerdict {
  readonly visionVersion: number;
  readonly basis: VisionGuarantee["basis"];
  readonly judged: GuaranteeVerdict;
}

/** The verdicts a message carries, with the sweep they were judged on (null when none was on record); none when its table judged nothing. */
export interface ReportVerdicts {
  readonly sweepId: string | null;
  readonly verdicts: readonly ReportVerdict[];
}

/** Persists a message's verdicts beside it (guarantee_verdicts), inside the transaction that posts it. */
export async function recordReportVerdicts(tx: DbHandle, projectId: string, reportId: string, table: ReportVerdicts): Promise<void> {
  if (table.verdicts.length === 0) return;
  await tx.insert(guaranteeVerdicts).values(
    table.verdicts.map(({ visionVersion, basis, judged }) => ({
      projectId,
      reportId,
      sweepId: table.sweepId,
      visionVersion,
      guaranteeId: judged.guaranteeId,
      verdict: judged.verdict.kind,
      reason: judged.verdict.kind === "unjudged" ? judged.verdict.reason : null,
      basis,
      evidenceClass: judged.evidenceClass,
    })),
  );
}

/** The verdict rows the message `reportId` carries, as stored and unparsed, by guarantee id; none when its table judged nothing. */
export async function reportVerdicts(db: DbHandle, reportId: string) {
  return db
    .select({
      reportId: guaranteeVerdicts.reportId,
      guaranteeId: guaranteeVerdicts.guaranteeId,
      verdict: guaranteeVerdicts.verdict,
      reason: guaranteeVerdicts.reason,
      evidenceClass: guaranteeVerdicts.evidenceClass,
    })
    .from(guaranteeVerdicts)
    .where(eq(guaranteeVerdicts.reportId, reportId))
    .orderBy(asc(guaranteeVerdicts.guaranteeId));
}
