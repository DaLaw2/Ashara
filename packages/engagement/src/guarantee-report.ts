import { verdictOf } from "./vision-language/index.js";
import type { Evidence, EvidenceClass, FaultSet, UnjudgedReason, Verdict, VisionGuarantee } from "./vision-language/index.js";
import type { GuaranteeBasis } from "./vision-language/guarantee.js";
import type { VisionVersion } from "./vision.js";

// The guarantee table every terminal message carries: the delivered report, a halt's report and the
// client's stop report. It is judged from one sweep's evidence on main, one verdict per guarantee of
// the vision version that evidence was recorded against, each guarantee exactly once. A guarantee
// passes only on a check deciding it that ran on that commit and passed; a review's reading of the
// checks can only hold one back. A sweep that ran on no commit judges nothing, and neither does a
// message no sweep is on record for (one told before its sweep could be recorded): every guarantee of
// the version in force reads unjudged and names that, so a terminal message is never held back for
// want of evidence. Records that do not hold together judge nothing either: the message says its
// table could not be read rather than give any guarantee a verdict. The punch list comes first: every failure, then every unjudged
// guarantee with why, then every pass that rests on an assumption the client has not confirmed.

/**
 * The fault set that exercises stored data is deferred: no check of a stored-data guarantee can
 * show that stored data survives a fault, so such a guarantee reads unjudged.
 */
const FAULT_SET: FaultSet = "deferred";

/** The sweep a table is judged from: its record, and the commit of main it ran on, null when it ran on none. */
interface JudgedSweep {
  readonly id: string;
  readonly mainCommit: string | null;
}

/**
 * Each guarantee's evidence on the sweep, by guarantee id: recorded, or not on record at all (a
 * sweep recorded before evidence per guarantee was), which judges every guarantee on no evidence.
 */
type SweepEvidence = { readonly kind: "recorded"; readonly byGuarantee: ReadonlyMap<string, Evidence> } | { readonly kind: "unrecorded" };

/**
 * What a table is read from: the sweep, null when none is on record for the message, and the vision
 * version in force at it with each guarantee's evidence; or no vision then.
 */
export type GuaranteeRecords =
  | { readonly kind: "judged"; readonly sweep: JudgedSweep | null; readonly vision: VisionVersion; readonly evidence: SweepEvidence }
  | { readonly kind: "no-contract"; readonly sweep: JudgedSweep | null };

/** One guarantee's line of the table. */
interface GuaranteeLine {
  readonly guarantee: VisionGuarantee;
  readonly verdict: Verdict;
  /** The strongest class of evidence seen for it; a pass names the weakest it rests on instead. */
  readonly evidenceClass: EvidenceClass;
}

/**
 * The table a terminal message carries; or that no contract was on record at its sweep; or that its
 * records did not read as a table, on the sweep named (null when none was on record).
 */
export type GuaranteeTable =
  | {
      readonly kind: "table";
      readonly sweep: JudgedSweep | null;
      readonly vision: VisionVersion;
      readonly evidence: SweepEvidence["kind"];
      readonly lines: readonly GuaranteeLine[];
    }
  | { readonly kind: "no-contract"; readonly sweep: JudgedSweep | null }
  | { readonly kind: "unreadable"; readonly sweepId: string | null };

/** One verdict as guarantee_verdicts stores it beside the message that carries it. */
interface StoredGuaranteeVerdict {
  readonly guaranteeId: string;
  readonly visionVersion: number;
  readonly verdict: Verdict["kind"];
  readonly reason: UnjudgedReason | null;
  readonly basis: GuaranteeBasis;
  readonly evidenceClass: EvidenceClass;
}

/**
 * The verdicts a message's table persists, with the sweep they were judged on (null when none was on
 * record); none when no contract was on record or the table could not be read.
 */
export interface TableVerdicts {
  readonly sweepId: string | null;
  readonly verdicts: readonly StoredGuaranteeVerdict[];
}

/** A sweep's evidence names a guarantee the vision version it was recorded against does not hold, or misses one it holds. */
export class GuaranteeEvidenceMismatch extends Error {
  constructor(
    readonly sweepId: string,
    readonly visionVersion: number,
    readonly guaranteeId: string,
    readonly detail: "missing" | "unmatched",
  ) {
    super(
      detail === "missing"
        ? `sweep ${sweepId} records evidence for some guarantees of vision v${visionVersion} but none for ${guaranteeId}: its table cannot be judged`
        : `sweep ${sweepId} records evidence for ${guaranteeId}, which vision v${visionVersion} does not hold: its table cannot be judged`,
    );
    this.name = "GuaranteeEvidenceMismatch";
  }
}

const NO_EVIDENCE: Evidence = { checks: [], reviewLowers: false };

const CLASS_RANK: readonly EvidenceClass[] = ["witness", "implementer-visible", "review-only"];

/** The strongest class among the checks seen for a guarantee: an executed one only when it ran. */
function strongestClass(evidence: Evidence): EvidenceClass {
  const seen = evidence.checks.filter((check) => check.class === "review-only" || check.outcome !== "not-run").map((check) => check.class);
  return CLASS_RANK.find((cls) => seen.includes(cls)) ?? "none";
}

function lineOf(guarantee: VisionGuarantee, evidence: Evidence, onCommit: boolean): GuaranteeLine {
  if (!onCommit) return { guarantee, verdict: { kind: "unjudged", reason: "no-sweep-on-commit" }, evidenceClass: "none" };
  const verdict = verdictOf(guarantee, evidence, FAULT_SET);
  return { guarantee, verdict, evidenceClass: verdict.kind === "pass" ? verdict.evidence : strongestClass(evidence) };
}

/**
 * The table of every guarantee of the version in force at the sweep, each exactly once, in the
 * version's order. Evidence that misses a guarantee or names one the version does not hold is a
 * record that does not hold together: it throws, never reads as no evidence.
 */
export function guaranteeTableOf(records: GuaranteeRecords): GuaranteeTable {
  if (records.kind === "no-contract") return records;
  const { sweep, vision, evidence } = records;
  const onCommit = sweep !== null && sweep.mainCommit !== null;
  if (sweep === null || evidence.kind === "unrecorded") {
    return { kind: "table", sweep, vision, evidence: "unrecorded", lines: vision.guarantees.map((guarantee) => lineOf(guarantee, NO_EVIDENCE, onCommit)) };
  }
  const ids = new Set(vision.guarantees.map((guarantee) => guarantee.id));
  for (const id of evidence.byGuarantee.keys()) {
    if (!ids.has(id)) throw new GuaranteeEvidenceMismatch(sweep.id, vision.version, id, "unmatched");
  }
  const lines = vision.guarantees.map((guarantee) => {
    const seen = evidence.byGuarantee.get(guarantee.id);
    if (seen === undefined) throw new GuaranteeEvidenceMismatch(sweep.id, vision.version, guarantee.id, "missing");
    return lineOf(guarantee, seen, onCommit);
  });
  return { kind: "table", sweep, vision, evidence: evidence.kind, lines };
}

/** The verdicts the table persists beside its message. */
export function tableVerdicts(table: GuaranteeTable): TableVerdicts {
  if (table.kind === "unreadable") return { sweepId: table.sweepId, verdicts: [] };
  const sweepId = table.sweep === null ? null : table.sweep.id;
  if (table.kind === "no-contract") return { sweepId, verdicts: [] };
  return {
    sweepId,
    verdicts: table.lines.map((line) => ({
      guaranteeId: line.guarantee.id,
      visionVersion: table.vision.version,
      verdict: line.verdict.kind,
      reason: line.verdict.kind === "unjudged" ? line.verdict.reason : null,
      basis: line.guarantee.basis,
      evidenceClass: line.evidenceClass,
    })),
  };
}

/** Why a guarantee is unjudged, in the client's words. */
const UNJUDGED_BECAUSE: Readonly<Record<UnjudgedReason, string>> = {
  "no-executed-evidence": "no check deciding it ran and passed",
  "review-only": "only a review of the checks speaks for it, and a review never makes a guarantee pass",
  "stored-data-unjudged": "it is about stored data, and the faults that would show stored data surviving them are not run",
  "not-checkable-as-written": "as written it names nothing that would show it broken, so no check can decide it",
  "lowered-by-review": "a review of the checks found they may not decide it",
  "out-of-scope-of-run": "it is outside what this run checked",
  "no-sweep-on-commit": "no check could run on a commit of main for this report",
};

/** What a guarantee's footing is, in the client's words; one resting on an unconfirmed assumption is at risk. */
const BASIS_WORDS: Readonly<Record<GuaranteeBasis, string>> = {
  "client-stated": "what your tender states",
  "assumed-unconfirmed": "an assumption you have not confirmed, so it is at risk",
  derived: "our reading of your tender",
};

/** What kind of evidence stands behind a guarantee, in the client's words. */
const EVIDENCE_WORDS: Readonly<Record<EvidenceClass, string>> = {
  witness: "checked by a check written after the work by someone other than its implementer",
  "implementer-visible": "checked by a check its implementer could see",
  "review-only": "a review of the checks only",
  none: "no check ran",
};

function verdictWords(verdict: Verdict): string {
  switch (verdict.kind) {
    case "pass":
      return "pass";
    case "fail":
      return "fail, a check deciding it failed on this commit";
    case "unjudged":
      return `unjudged, ${UNJUDGED_BECAUSE[verdict.reason]}`;
  }
}

/** The punch list: every failure, then every unjudged guarantee, then every pass at risk; or that it is empty. */
function punchList(lines: readonly GuaranteeLine[]): string {
  const failed = lines.filter((line) => line.verdict.kind === "fail").map((line) => `- ${line.guarantee.id}: fail, a check deciding it failed on this commit`);
  const unjudged = lines.flatMap((line) => (line.verdict.kind === "unjudged" ? [`- ${line.guarantee.id}: unjudged, ${UNJUDGED_BECAUSE[line.verdict.reason]}`] : []));
  const atRisk = lines
    .filter((line) => line.verdict.kind === "pass" && line.guarantee.basis === "assumed-unconfirmed")
    .map((line) => `- ${line.guarantee.id}: pass, but it rests on an assumption you have not confirmed`);
  const listed = [...failed, ...unjudged, ...atRisk];
  if (listed.length === 0) return "The punch list is empty: every guarantee passed on a check that ran, and none rests on an assumption you have not confirmed.";
  return [`The punch list, what is not shown to hold, failures first:`, ...listed].join("\n");
}

/** Where the table was judged, and on what. */
function judgedOn(table: Extract<GuaranteeTable, { readonly kind: "table" }>): string {
  const { sweep } = table;
  const where =
    sweep === null
      ? `No check could run on a commit of main for this report: no sweep of main is on record for it, so each guarantee of your contract (vision v${table.vision.version}) is unjudged.`
      : sweep.mainCommit === null
        ? `No check could run on a commit of main for this report; why is in Ashara's record of that attempt, sweep ${sweep.id}.`
        : `Each guarantee of your contract (vision v${table.vision.version}) is judged on main at commit ${sweep.mainCommit}, sweep ${sweep.id}.`;
  const unrecorded =
    sweep !== null && table.evidence === "unrecorded" ? " Which checks decided each guarantee is not on record for that sweep, so none is judged as holding." : "";
  return (
    `${where}${unrecorded} A guarantee passes only when a check deciding it ran on that commit and passed; a review of the checks ` +
    `can only hold one back, never pass it.`
  );
}

function tableLine(line: GuaranteeLine): string {
  return `- ${line.guarantee.id}: ${line.guarantee.statement} | verdict: ${verdictWords(line.verdict)} | basis: ${BASIS_WORDS[line.guarantee.basis]} | evidence: ${EVIDENCE_WORDS[line.evidenceClass]}`;
}

/** The assumptions the guarantees rest on, each with the guarantees it underpins and whether the client stated it. */
function assumptionsPart(vision: VisionVersion): string[] {
  const visible = vision.assumptions.filter((assumption) => assumption.kind !== "internal-design");
  if (visible.length === 0) return [];
  return [
    [
      `The assumptions the guarantees rest on:`,
      ...visible.map((assumption) => {
        const underpins = assumption.underpins.length === 0 ? "" : `underpins ${assumption.underpins.join(", ")}; `;
        return `- ${assumption.id}: ${assumption.statement} (${underpins}${assumption.status === "Stated" ? "stated by you" : "not confirmed by you"})`;
      }),
    ].join("\n"),
  ];
}

function exclusionsPart(vision: VisionVersion): string {
  if (vision.exclusions.length === 0) return `What is left out: nothing is excluded on record.`;
  return [`What is left out, so that silence is never read as a promise:`, ...vision.exclusions.map((exclusion) => `- ${exclusion.id}: ${exclusion.text}`)].join("\n");
}

/** The team's own design choices: named, never judged. */
function basisOfDesignPart(vision: VisionVersion): string[] {
  const design = vision.assumptions.filter((assumption) => assumption.kind === "internal-design");
  if (design.length === 0) return [];
  return [
    [
      `Basis of Design, the team's own design choices, which are not judged here and which your acceptance does not depend on:`,
      ...design.map((assumption) => `- ${assumption.id}: ${assumption.statement}`),
    ].join("\n"),
  ];
}

/**
 * The table's paragraphs as the client reads them: the punch list, where and on what it was judged,
 * every guarantee once with its verdict, basis and evidence, then the assumptions, the exclusions
 * and the Basis of Design. A project with no contract at the sweep is told so.
 */
export function guaranteeSection(table: GuaranteeTable): string {
  if (table.kind === "unreadable") {
    const where = table.sweepId === null ? "" : ` at sweep ${table.sweepId}`;
    return `Ashara's records of this project's guarantees${where} do not hold together, so no guarantee is judged in this message: none is told as holding, and none as failing. Its operator is told why.`;
  }
  if (table.kind === "no-contract") {
    return table.sweep === null
      ? `No contract is on record for this project, so no guarantee is judged.`
      : `No contract is on record for this project at sweep ${table.sweep.id}, so no guarantee is judged.`;
  }
  return [
    punchList(table.lines),
    [judgedOn(table), ...table.lines.map(tableLine)].join("\n"),
    ...assumptionsPart(table.vision),
    exclusionsPart(table.vision),
    ...basisOfDesignPart(table.vision),
  ].join("\n\n");
}
