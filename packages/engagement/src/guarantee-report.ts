import type { EvidenceClass, GuaranteeVerdict, JudgedSweep, JudgedVerdicts, ReportVerdicts, UnjudgedReason, Verdict } from "@ashara/quality/published-verdicts";
import { describeErrorChain } from "@ashara/shared";
import type { VisionGuarantee } from "./vision-language/index.js";
import type { Direction, RevisionOp } from "./vision-language/contract-op.js";
import { OBSERVATION_UNDECIDED, verifiableByAshara, verifiableCountLine, whyNotVerifiable } from "./vision-language/guarantee.js";
import type { GuaranteeBasis } from "./vision-language/guarantee.js";
import type { VisionVersion } from "./vision.js";

// The guarantee table every terminal message carries (terminal-report.ts), and its one builder. It
// renders Quality's verdict on each guarantee of the vision version that
// one sweep's evidence was recorded against, each guarantee exactly once, and judges none itself. A
// guarantee passes only on a check deciding it that ran on that commit and passed; a review's
// reading of the checks can only hold one back. A guarantee the contract marks not verifiable by
// Ashara, as the client was told when it was proposed, is listed as not verified, never as passed. A sweep that ran on no commit judges nothing, and
// neither does a message no sweep is on record for (one told before its sweep could be recorded):
// every guarantee of the version in force reads unjudged and names that, so a terminal message is
// never held back for want of evidence. Records that do not hold together judge nothing either: the
// message says its table could not be read rather than give any guarantee a verdict. The punch list
// comes first: every failure, then every unjudged guarantee with why, then every pass that rests on
// an assumption the client has not confirmed. An appendix follows when the contract was revised:
// each guarantee an earlier version held with what replaced it, and each narrowing Ashara proposed
// that the client has not confirmed. A proposal is never in force, so the table renders the
// guarantee it would narrow as the version in force states it.

/**
 * One revision of the project's contract as its record holds it, with the version it revised: applied,
 * with the version it wrote, or proposed and awaiting the client's confirmation, having written none.
 */
export type ContractRevision = {
  readonly author: "client" | "ashara";
  readonly direction: Direction;
  readonly basedOn: VisionVersion;
  readonly ops: readonly RevisionOp[];
} & ({ readonly status: "applied"; readonly wrote: VisionVersion } | { readonly status: "proposed" });

/**
 * What a table is read from: the sweep, null when none is on record for the message, and the vision
 * version in force at it with Quality's verdict on each of its guarantees and every revision record of
 * the project's contract; or no vision then. The appendix lists only what a revision record states, so
 * the records always carry the list read, never an absent one that would read as no revision.
 */
export type GuaranteeRecords =
  | {
      readonly kind: "judged";
      readonly sweep: JudgedSweep | null;
      readonly vision: VisionVersion;
      readonly judged: JudgedVerdicts;
      readonly revisions: readonly ContractRevision[];
    }
  | { readonly kind: "no-contract"; readonly sweep: JudgedSweep | null };

/** A guarantee an earlier version of the contract held, and the one a revision replaced it with; null when it was withdrawn. */
interface SupersededGuarantee {
  readonly prior: VisionGuarantee;
  readonly priorVersion: number;
  readonly replacedBy: VisionGuarantee | null;
  readonly version: number;
  readonly author: ContractRevision["author"];
}

/** One operation of a narrowing Ashara proposed, with the guarantee it acts on as the version in force holds it (null for any other record or an add) and the text it proposes (null when it withdraws). */
interface ProposedOp {
  readonly op: RevisionOp;
  readonly standing: VisionGuarantee | null;
  readonly text: string | null;
}

/** What the table's appendix lists: the guarantees superseded up to the version judged, and Ashara's pending narrowings of it. */
interface Appendix {
  readonly superseded: readonly SupersededGuarantee[];
  readonly proposed: readonly ProposedOp[];
}

/** One guarantee's line of the table: the guarantee, and Quality's verdict on it with the class of evidence it names. */
type GuaranteeLine = Omit<GuaranteeVerdict, "guaranteeId"> & { readonly guarantee: VisionGuarantee };

/** Records that did not hold together as a table, on the sweep named (null when none was on record for the message). */
interface UnreadableRecords {
  readonly kind: "unreadable";
  readonly sweepId: string | null;
}

/** Where a terminal message's table is read from: its sweep, or, with none on record for it, its project's vision in force. */
export type TableSource = { readonly kind: "sweep"; readonly sweepId: string } | { readonly kind: "no-sweep"; readonly projectId: string };

/** Marks a table readGuaranteeTable built; no other module can name it, so no other module can make a table. */
const BUILT = Symbol("guarantee-table");

/**
 * The table a terminal message carries; or that no contract was on record at its sweep; or that its
 * records did not read as a table, on the sweep named (null when none was on record). Only
 * readGuaranteeTable builds one, from records it read, so a message that requires a table carries the one its records judge.
 */
export type GuaranteeTable = ShownTable & { readonly [BUILT]: true };

/** What a table shows, before readGuaranteeTable marks it built. */
type ShownTable =
  | {
      readonly kind: "table";
      readonly sweep: JudgedSweep | null;
      readonly vision: VisionVersion;
      readonly evidence: JudgedVerdicts["evidence"];
      readonly lines: readonly GuaranteeLine[];
      readonly appendix: Appendix;
    }
  | { readonly kind: "no-contract"; readonly sweep: JudgedSweep | null }
  | UnreadableRecords;

/**
 * The verdicts a message's table persists through Quality, with the sweep they were judged on (null
 * when none was on record); none when no contract was on record or the table could not be read.
 */
export type TableVerdicts = ReportVerdicts;

/** `shown` as a built table. The mark is not enumerable, so two tables of the same records compare equal field by field. */
function built(shown: ShownTable): GuaranteeTable {
  const table = Object.assign({ ...shown }, { [BUILT]: true as const });
  Object.defineProperty(table, BUILT, { enumerable: false });
  return table;
}

/** Quality's verdicts do not name each guarantee of the version they were judged on exactly once, in its order. */
class GuaranteeVerdictsMismatch extends Error {
  constructor(
    readonly visionVersion: number,
    readonly judged: readonly string[],
    readonly held: readonly string[],
  ) {
    super(`the verdicts judged on vision v${visionVersion} name [${judged.join(", ")}], but it holds [${held.join(", ")}]: its table cannot be rendered`);
    this.name = "GuaranteeVerdictsMismatch";
  }
}

/** A revision's record names a guarantee that the version it revised, or the version it wrote, does not hold. */
class ContractRevisionMismatch extends Error {
  constructor(
    readonly projectId: string,
    readonly visionVersion: number,
    readonly guaranteeId: string,
    readonly detail: string,
  ) {
    super(`project ${projectId}: a revision ${detail} ${guaranteeId}, which vision v${visionVersion} does not hold: its appendix cannot be read`);
    this.name = "ContractRevisionMismatch";
  }
}

function heldGuarantee(version: VisionVersion, id: string, detail: string): VisionGuarantee {
  const held = version.guarantees.find((guarantee) => guarantee.id === id);
  if (held === undefined) throw new ContractRevisionMismatch(version.projectId, version.version, id, detail);
  return held;
}

/** The text an operation proposes, as the client's message or Ashara's own record states it; null when it withdraws. */
function proposedText(op: RevisionOp): string | null {
  if (op.read === null) return op.statement;
  switch (op.read.op) {
    case "add-guarantee":
    case "amend-guarantee":
    case "amend-assumption":
      return op.read.statement;
    case "add-exclusion":
    case "add-interface":
    case "amend-interface":
      return op.read.text;
    case "withdraw-guarantee":
    case "withdraw-exclusion":
    case "withdraw-interface":
      return null;
  }
}

/**
 * The appendix of the table judged at `vision`: every guarantee an applied revision up to that version
 * amended or withdrew, with what replaced it, in the order the revisions were made; and every
 * narrowing operation of a revision Ashara proposed against that version that the client has not
 * confirmed (an operation of it that widens or is neutral narrows nothing, so it is not listed there). A
 * revision naming a guarantee its versions do not hold throws, never reads as no change.
 */
function appendixOf(vision: VisionVersion, revisions: readonly ContractRevision[]): Appendix {
  const superseded: SupersededGuarantee[] = [];
  const proposed: ProposedOp[] = [];
  for (const revision of revisions) {
    if (revision.status === "applied") {
      if (revision.wrote.version > vision.version) continue;
      for (const op of revision.ops) {
        if (op.target !== "guarantee" || op.action === "add" || op.key === null) continue;
        superseded.push({
          prior: heldGuarantee(revision.basedOn, op.key, `${op.action}s`),
          priorVersion: revision.basedOn.version,
          replacedBy: op.action === "amend" ? heldGuarantee(revision.wrote, op.key, "writes an amended") : null,
          version: revision.wrote.version,
          author: revision.author,
        });
      }
    } else if (revision.author === "ashara" && revision.direction === "narrows" && revision.basedOn.version === vision.version) {
      for (const op of revision.ops.filter((each) => each.direction === "narrows")) {
        const standing = op.target === "guarantee" && op.key !== null ? heldGuarantee(vision, op.key, `proposes to ${op.action}`) : null;
        proposed.push({ op, standing, text: proposedText(op) });
      }
    }
  }
  return { superseded, proposed };
}

/**
 * A table built from records: every guarantee of the version in force at the sweep, each exactly
 * once, in the version's order, with Quality's verdict on it and the appendix of the contract's
 * revisions; or that no contract was on record. Verdicts that do not name each guarantee once, in
 * order, throw, never render as a guarantee unjudged; so does a revision naming a guarantee its
 * versions do not hold.
 */
function tableOf(records: GuaranteeRecords): GuaranteeTable {
  if (records.kind === "no-contract") return built(records);
  const { sweep, vision, judged } = records;
  const appendix = appendixOf(vision, records.revisions);
  const held = vision.guarantees.map((guarantee) => guarantee.id);
  const named = judged.verdicts.map((each) => each.guaranteeId);
  if (JSON.stringify(named) !== JSON.stringify(held)) throw new GuaranteeVerdictsMismatch(vision.version, named, held);
  const lines = judged.verdicts.flatMap((each, i): GuaranteeLine[] => {
    const guarantee = vision.guarantees[i];
    return guarantee === undefined ? [] : [{ guarantee, verdict: each.verdict, evidenceClass: each.evidenceClass }];
  });
  return built({ kind: "table", sweep, vision, evidence: judged.evidence, lines, appendix });
}

/** Where a table's records are read from: Engagement's store over the database, or a test's fixtures. */
export interface GuaranteeRecordsReader {
  /** The records a table of `source` is judged from. */
  records(source: TableSource): Promise<GuaranteeRecords>;
  /** Whether a read threw because the records do not hold together, which a retry reads the same. */
  unreadable(err: unknown): boolean;
}

/**
 * The one builder of a guarantee table, from the records `reader` reads for `source`. Records that do
 * not hold together (a read that throws what `reader` names unreadable, verdicts that do not name the
 * version's guarantees, a revision naming a guarantee its versions do not hold) are the unreadable
 * table, logged at warn with why, so the message still goes out judging nothing; any other failure
 * throws for a retry. Nothing else makes a table, so every table a message carries is one its records
 * judge, or one that says they did not read.
 */
export async function readGuaranteeTable(reader: GuaranteeRecordsReader, source: TableSource): Promise<GuaranteeTable> {
  try {
    return tableOf(await reader.records(source));
  } catch (err) {
    if (!(err instanceof GuaranteeVerdictsMismatch || err instanceof ContractRevisionMismatch || reader.unreadable(err))) throw err;
    const where = source.kind === "sweep" ? `sweep ${source.sweepId}` : `project ${source.projectId}`;
    console.warn(`[terminal-report] ${where}: its guarantee table cannot be read, so its message judges no guarantee: ${describeErrorChain(err)}`);
    return built({ kind: "unreadable", sweepId: source.kind === "sweep" ? source.sweepId : null });
  }
}

/** Why a guarantee the contract marks not verifiable by Ashara is not verified, as the client was told when it was proposed. */
const NOT_VERIFIABLE = "Ashara cannot verify it with the checks it can run, as your contract said when it was proposed";

/** Why a guarantee is unjudged, in the client's words. */
const UNJUDGED_BECAUSE: Readonly<Record<UnjudgedReason, string>> = {
  "not-verifiable-by-ashara": NOT_VERIFIABLE,
  "no-executed-evidence": "no check deciding it ran and passed",
  "review-only": "only a review of the checks speaks for it, and a review never makes a guarantee pass",
  "stored-data-unjudged": "it is seen only outside what the product's interface shows, and no check Ashara runs reads stored data directly or injects the faults that would show it",
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

function verdictWords(verdict: Verdict, guarantee: VisionGuarantee): string {
  switch (verdict.kind) {
    case "pass":
      return "pass";
    case "fail":
      return "fail, a check deciding it failed on this commit";
    case "unjudged":
      return unjudgedWords(verdict.reason, guarantee);
  }
}

/**
 * An unjudged verdict in the client's words: one outside what Ashara can verify reads not verified,
 * never unjudged work, with the reason the contract records for it; one whose drafter could not tell
 * where it is seen says so.
 */
function unjudgedWords(reason: UnjudgedReason, guarantee: VisionGuarantee): string {
  const undecided = guarantee.verification === "undecided" ? `; ${OBSERVATION_UNDECIDED}` : "";
  if (reason !== "not-verifiable-by-ashara") return `unjudged, ${UNJUDGED_BECAUSE[reason]}${undecided}`;
  return guarantee.verification === "not-by-ashara" ? `not verified, ${NOT_VERIFIABLE}: ${whyNotVerifiable(guarantee.unverifiableBecause)}` : `not verified, ${NOT_VERIFIABLE}`;
}

/**
 * Who can settle an unjudged guarantee: the client, when Ashara cannot verify it as written, since
 * only a restatement or its removal changes that; the team, when a check could decide it and none did.
 */
const SETTLED_BY: Readonly<Record<UnjudgedReason, "client" | "team">> = {
  "not-verifiable-by-ashara": "client",
  "stored-data-unjudged": "client",
  "not-checkable-as-written": "client",
  "no-executed-evidence": "team",
  "review-only": "team",
  "lowered-by-review": "team",
  "out-of-scope-of-run": "team",
  "no-sweep-on-commit": "team",
};

const SETTLED_WORDS: Readonly<Record<"client" | "team", string>> = {
  client: "Ashara cannot verify it as written, so only you can settle it, by restating it or removing it",
  team: "a check could decide it, so the team looks into it",
};

/**
 * Why acceptance could not rest on the table's guarantees, in the client's words: each guarantee not
 * judged pass, with its statement, why, and who can settle it, one whose drafter could not tell where
 * it is observed saying so, then how many of the version's guarantees Ashara can verify. A table that
 * is no table says it names none, never that every guarantee held.
 */
export function unverifiedGuarantees(table: GuaranteeTable): string {
  if (table.kind !== "table") return "Which guarantees could not be shown to hold is not on record for this pause.";
  const lines = table.lines.flatMap((line) => {
    if (line.verdict.kind === "pass") return [];
    const why = line.verdict.kind === "fail" ? "fail, a check deciding it failed on this commit" : unjudgedWords(line.verdict.reason, line.guarantee);
    const settled = SETTLED_WORDS[line.verdict.kind === "fail" ? "team" : SETTLED_BY[line.verdict.reason]];
    return [`- ${line.guarantee.id} (${line.guarantee.statement}): ${why}; ${settled}`];
  });
  const count = verifiableCountLine(table.vision.guarantees.filter(verifiableByAshara).length, table.vision.guarantees.length);
  if (lines.length === 0) return `Every guarantee of your contract (vision v${table.vision.version}) is judged pass on record. ${count}`;
  return [`The guarantees of your contract (vision v${table.vision.version}) that Ashara could not show to hold, and why:`, ...lines, count].join("\n");
}

/** The punch list: every failure, then every unjudged guarantee, then every pass at risk; or that it is empty. */
function punchList(lines: readonly GuaranteeLine[]): string {
  const failed = lines.filter((line) => line.verdict.kind === "fail").map((line) => `- ${line.guarantee.id}: fail, a check deciding it failed on this commit`);
  const unjudged = lines.flatMap((line) => (line.verdict.kind === "unjudged" ? [`- ${line.guarantee.id}: ${unjudgedWords(line.verdict.reason, line.guarantee)}`] : []));
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
  return `- ${line.guarantee.id}: ${line.guarantee.statement} | verdict: ${verdictWords(line.verdict, line.guarantee)} | basis: ${BASIS_WORDS[line.guarantee.basis]} | evidence: ${EVIDENCE_WORDS[line.evidenceClass]}`;
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

const REVISED_BY: Readonly<Record<ContractRevision["author"], string>> = { client: "by your change", ashara: "by Ashara" };

function supersededLine(each: SupersededGuarantee): string {
  const was = `- ${each.prior.id} (vision v${each.priorVersion}): ${each.prior.statement}`;
  if (each.replacedBy === null) return `${was} | withdrawn in vision v${each.version} ${REVISED_BY[each.author]}; nothing replaces it`;
  return `${was} | replaced in vision v${each.version} ${REVISED_BY[each.author]} with ${each.replacedBy.id}: ${each.replacedBy.statement}`;
}

function proposedLine({ op, standing, text }: ProposedOp): string {
  const subject = op.key ?? `a new ${op.target}`;
  const now = standing === null ? "" : ` (as it stands: ${standing.statement})`;
  const unrecorded = "its text is not on record";
  const would = op.action === "withdraw" ? "withdraw it" : `${op.action === "add" ? "add it" : "amend it to"}: ${text ?? unrecorded}`;
  return `- ${subject}${now} | Ashara proposes to ${would}`;
}

const APPENDIX_HEAD = "Appendix, how your contract has been revised:";

/**
 * The appendix: the guarantees earlier versions held, each with what replaced it, then the narrowings
 * Ashara proposed that the client has not confirmed; none, not even its heading, when there are neither.
 */
function appendixPart(appendix: Appendix): string[] {
  if (appendix.superseded.length === 0 && appendix.proposed.length === 0) return [];
  const superseded =
    appendix.superseded.length === 0 ? [] : [`Guarantees an earlier version of your contract held, each with what replaced it:`, ...appendix.superseded.map(supersededLine)];
  const proposed =
    appendix.proposed.length === 0
      ? []
      : [
          `Narrowings Ashara has proposed that you have not confirmed: none is in force, so the table above judges each guarantee as your contract states it now.`,
          ...appendix.proposed.map(proposedLine),
        ];
  return [[APPENDIX_HEAD, ...superseded, ...proposed].join("\n")];
}

/**
 * The table's paragraphs as the client reads them: the punch list, where and on what it was judged,
 * every guarantee once with its verdict, basis and evidence, then the assumptions, the exclusions,
 * the Basis of Design and the appendix of the contract's revisions. A project with no contract at the
 * sweep is told so.
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
    ...appendixPart(table.appendix),
  ].join("\n\n");
}
