import { z } from "zod";
import { ContractOpSchema, opKey, opShape } from "./vision-language/contract-op.js";
import type { ContractOp, Direction, Pushback, PushbackReason, RevisionCause, RevisionOp } from "./vision-language/contract-op.js";
import { NOTHING_VERIFIABLE, OBSERVATION_RULE, declinesUnverifiable, markOf, markWords, verifiableByAshara, verifiableCountLine } from "./vision-language/guarantee.js";
import type { ClassifiedObservation, ContractStanding, VisionGuarantee } from "./vision-language/guarantee.js";
import { WORK_WORDS } from "./vision-language/work-promise.js";
import type { AppliedOp, UnappliedOp, VisionVersion } from "./vision.js";

// A client's correction: a change message read into typed operations on the contract of the version in
// force, each operation's direction checked rather than trusted, the impact of the whole stated from
// records (the guarantees affected, the tasks citing them, a cost band), and the Liaison's pushback
// decided by a mechanical rule. There is no refusal: a correction applies as sent, or waits for the
// client's confirmation when the Liaison pushes back.

/**
 * A reading of a change message: the operations it asks of the contract, and the labels of the
 * pending proposals it confirms.
 */
const CorrectionReadingSchema = z.strictObject({
  ops: z.array(ContractOpSchema),
  confirms: z.array(z.string().min(1)),
});

export type CorrectionReading = z.infer<typeof CorrectionReadingSchema>;

/**
 * The reading as the model returns it: one object holding it, since a provider decoding against the
 * schema takes only an object at its root (model-access schema-acceptance).
 */
export const CorrectionResponseSchema = z.strictObject({ correction: CorrectionReadingSchema });

/** A revision awaiting the client's confirmation, as the reader lists it by its label. */
export interface PendingProposal {
  readonly id: string;
  /** P<n> by its place among the project's pending proposals, oldest first. */
  readonly label: string;
  readonly ops: readonly ContractOp[];
}

/**
 * The problems a reading has against the version it was read against: an operation naming a record the
 * version does not hold, a guarantee observed at an interface entry it does not hold, or a confirmation
 * of a proposal that is not pending. Each is the model's to correct on its next attempt.
 */
export function readingProblems(reading: CorrectionReading, vision: VisionVersion, proposals: readonly PendingProposal[]): string[] {
  const held = {
    guarantee: new Set(vision.guarantees.map((g) => g.id)),
    assumption: new Set(vision.assumptions.map((a) => a.id)),
    exclusion: new Set(vision.exclusions.map((x) => x.id)),
    interface: new Set(vision.interface.map((e) => e.id)),
  };
  const problems: string[] = [];
  reading.ops.forEach((op, i) => {
    const key = opKey(op);
    const { target } = opShape(op);
    if (key !== null && !held[target].has(key)) problems.push(`ops[${i}] (${op.op}) names ${key}, which the contract does not hold`);
    if (op.op === "add-guarantee" || op.op === "amend-guarantee") {
      const unknown = op.interface.filter((id) => !held.interface.has(id));
      if (unknown.length > 0) problems.push(`ops[${i}] (${op.op}) is observed at ${unknown.join(", ")}, which the interface does not hold`);
    }
  });
  const labels = new Set(proposals.map((p) => p.label));
  for (const label of reading.confirms) if (!labels.has(label)) problems.push(`confirms names ${label}, which is not a pending proposal`);
  return problems;
}

/**
 * The direction an operation is recorded with: the reading's label is checked against what the
 * operation does where that can be read off the records (a withdrawn guarantee, a removed interface
 * entry or an added exclusion narrows; an added guarantee widens; an amended guarantee that drops a
 * refuting observation narrows and one that only adds some widens), and a narrowing on either side
 * wins, so a narrowing can be mislabelled only toward "narrows".
 */
export function checkedDirection(op: ContractOp, vision: VisionVersion): Direction {
  const mechanical = mechanicalDirection(op, vision);
  if (op.direction === "narrows" || mechanical === "narrows") return "narrows";
  return mechanical ?? op.direction;
}

function mechanicalDirection(op: ContractOp, vision: VisionVersion): Direction | null {
  switch (op.op) {
    case "add-guarantee":
      return "widens";
    case "withdraw-guarantee":
    case "withdraw-interface":
    case "add-exclusion":
      return "narrows";
    case "amend-guarantee": {
      const old = vision.guarantees.find((g) => g.id === op.id);
      if (old === undefined) return null;
      if (old.refutedBy.some((observation) => !op.refutedBy.includes(observation))) return "narrows";
      if (op.refutedBy.some((observation) => !old.refutedBy.includes(observation))) return "widens";
      return null;
    }
    case "amend-assumption":
    case "withdraw-exclusion":
    case "add-interface":
    case "amend-interface":
      return null;
  }
}

/** An operation with the direction it is recorded with. */
export interface CheckedOp {
  readonly op: ContractOp;
  readonly direction: Direction;
}

/** An operation as the affected-key reading needs it: what it acts on and the record's key, null on an add not applied. */
type AffectingOp = Pick<RevisionOp, "target" | "key">;

/** A guarantee as the affected-key reading needs it: its key, the interface entries it is observed at and its source. */
type ObservedGuarantee = Pick<VisionGuarantee, "id" | "interface" | "source">;

/** An assumption as the affected-key reading needs it: its key and the guarantees it underpins. */
interface UnderpinningAssumption {
  readonly id: string;
  readonly underpins: readonly string[];
}

/** A version as the affected-key reading needs it. */
interface AffectingVersion {
  readonly version: number;
  readonly guarantees: readonly ObservedGuarantee[];
  readonly assumptions: readonly UnderpinningAssumption[];
}

/**
 * A version names, in an assumption's underpins, a guarantee it does not hold: the guarantees resting
 * on that assumption cannot be read, so the work an amendment of it reaches cannot be held.
 * @testseam correction.test.ts asserts the refusal by its class
 */
export class UnderpinnedGuaranteeUnknown extends Error {
  constructor(
    readonly version: number,
    readonly assumption: string,
    readonly unknown: readonly string[],
  ) {
    super(`vision v${version}: assumption ${assumption} underpins ${unknown.join(", ")}, which the version does not hold`);
    this.name = "UnderpinnedGuaranteeUnknown";
  }
}

/**
 * The guarantees of `version` resting on assumption `key`: each it underpins, and each citing it as
 * its source. Throws UnderpinnedGuaranteeUnknown when it underpins a guarantee the version lacks.
 */
function restingOn(key: string, version: AffectingVersion): string[] {
  const held = new Set(version.guarantees.map((guarantee) => guarantee.id));
  const resting = new Set<string>();
  for (const assumption of version.assumptions) {
    if (assumption.id !== key) continue;
    const unknown = assumption.underpins.filter((id) => !held.has(id));
    if (unknown.length > 0) throw new UnderpinnedGuaranteeUnknown(version.version, key, unknown);
    for (const id of assumption.underpins) resting.add(id);
  }
  for (const guarantee of version.guarantees) {
    if (guarantee.source.kind === "assumption" && guarantee.source.id === key) resting.add(guarantee.id);
  }
  return [...resting];
}

/**
 * The guarantee and assumption keys a correction's applied operations affect: the keys a task can
 * cite, which the impact note names and Delivery's hold parks the citing work on, both from this one
 * reading. An operation on a guarantee affects its own key; one on an assumption affects its own key
 * and every guarantee resting on it, since the work citing only such a guarantee is built on the
 * assumption; one on an interface entry affects every guarantee observed at that entry; one on an
 * exclusion affects every guarantee, since no record says which guarantee an exclusion bounds, so none
 * is passed over as untouched. Each is read against both `appliedTo`, the version in force, and
 * `written`, the version the operations write, so a guarantee observed at an entry the correction
 * withdrew, or one an amendment moved off an assumption, is still affected. Throws
 * UnderpinnedGuaranteeUnknown when either version names a guarantee it does not hold under an affected
 * assumption.
 */
export function affectedKeys(ops: readonly AffectingOp[], appliedTo: AffectingVersion, written: AffectingVersion): string[] {
  const guarantees: readonly ObservedGuarantee[] = [...appliedTo.guarantees, ...written.guarantees];
  const keys = new Set<string>();
  for (const { target, key } of ops) {
    switch (target) {
      case "guarantee":
        if (key !== null) keys.add(key);
        break;
      case "assumption":
        if (key === null) break;
        keys.add(key);
        for (const id of [...restingOn(key, appliedTo), ...restingOn(key, written)]) keys.add(id);
        break;
      case "interface":
        for (const guarantee of guarantees) if (key !== null && guarantee.interface.includes(key)) keys.add(guarantee.id);
        break;
      case "exclusion":
        for (const guarantee of guarantees) keys.add(guarantee.id);
        break;
    }
  }
  return [...keys];
}


/** A task of the project's current plan citing an affected key, with where it stands. */
export interface CitingTask {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in progress" | "blocked" | "merged";
  /** The affected keys it cites. */
  readonly cites: readonly string[];
}

/** What the records say a correction touches: the tasks citing its keys and the project's work ledger. */
export interface ChangeImpact {
  readonly tasks: readonly CitingTask[];
  /** The model requests each completed implementation task of the project drew. */
  readonly completedTaskRequests: readonly number[];
  /** The requests the project's work budget has left: its budget less every request drawn. */
  readonly budgetLeftRequests: number;
}

/**
 * What a correction may cost, in model requests: the tasks it affects (those citing an affected key,
 * and one per added guarantee) times the fewest and the most requests a completed task of this project
 * drew. With fewer than two completed tasks there is no measured basis, never a zero.
 */
export type CostBand =
  | { readonly kind: "measured"; readonly tasks: number; readonly lowRequests: number; readonly highRequests: number }
  | { readonly kind: "no-basis"; readonly completedTasks: number };

export function costBandOf(ops: readonly ContractOp[], impact: ChangeImpact): CostBand {
  const { completedTaskRequests: drawn } = impact;
  if (drawn.length < 2) return { kind: "no-basis", completedTasks: drawn.length };
  const tasks = impact.tasks.length + ops.filter((op) => op.op === "add-guarantee").length;
  return { kind: "measured", tasks, lowRequests: tasks * Math.min(...drawn), highRequests: tasks * Math.max(...drawn) };
}

/** How many guarantees of a version Ashara can verify, of how many it holds. */
export interface VerifiableCount {
  readonly verifiable: number;
  readonly total: number;
}

export function verifiableCountOf(vision: Pick<VisionVersion, "guarantees">): VerifiableCount {
  return { verifiable: vision.guarantees.filter(verifiableByAshara).length, total: vision.guarantees.length };
}

/**
 * Whether a correction that changes the guarantees is declined: the version it would write is one
 * Ashara declines (declinesUnverifiable), so it is not made, and no confirmation makes it. A
 * correction that changes no guarantee is never declined for this: it leaves the guarantees as the
 * version in force holds them.
 */
export function declinedCorrection(applied: readonly AppliedOp[], rewritten: Pick<VisionVersion, "guarantees">): boolean {
  return applied.some((done) => opShape(done.op).target === "guarantee") && declinesUnverifiable(rewritten.guarantees);
}

/**
 * Whether the Liaison holds the correction for the client's confirmation: when it
 * withdraws or narrows a guarantee a merged task delivers, or the upper end of its cost band exceeds
 * what the work budget has left. Never on a model's judgement; null when neither holds.
 */
export function pushbackOf(ops: readonly CheckedOp[], impact: ChangeImpact, band: CostBand): Pushback | null {
  const reasons: PushbackReason[] = [];
  const merged = new Set(impact.tasks.filter((t) => t.status === "merged").flatMap((t) => t.cites));
  const narrowed = ops.flatMap(({ op, direction }) =>
    (op.op === "withdraw-guarantee" || (op.op === "amend-guarantee" && direction === "narrows")) && merged.has(op.id) ? [op.id] : [],
  );
  const [first, ...rest] = narrowed;
  if (first !== undefined) reasons.push({ kind: "merged-guarantee", guarantees: [first, ...rest] });
  if (band.kind === "measured" && band.highRequests > impact.budgetLeftRequests) {
    reasons.push({ kind: "over-budget", highRequests: band.highRequests, budgetLeftRequests: impact.budgetLeftRequests });
  }
  const [reason, ...more] = reasons;
  return reason === undefined ? null : { reasons: [reason, ...more] };
}

/** The operations of a revision as recorded: applied ones with the key each acted on, proposed ones as read. */
export function revisionOpsOf(ops: readonly CheckedOp[], applied: readonly AppliedOp[] | null): RevisionOp[] {
  return ops.flatMap(({ op, direction }) => {
    const shape = opShape(op);
    const record = { ...shape, direction, labelled: op.direction, read: op, statement: null };
    if (applied === null) return [{ ...record, key: opKey(op) }];
    const done = applied.find((a) => a.op === op);
    return done === undefined ? [] : [{ ...record, key: done.key }];
  });
}

/** A revision's cause: Ashara's misreading when every operation applied restored the tender's own words. */
export function causeOf(applied: readonly AppliedOp[]): RevisionCause {
  return applied.length > 0 && applied.every((a) => a.cause === "misread") ? "misread" : "client-change";
}


/** What one correction message did, as its impact note tells it. */
export interface CorrectionNote {
  /** The version the operations were read against, for naming the records they act on. */
  readonly vision: VisionVersion;
  readonly confirmed: ReadonlyArray<{ readonly label: string; readonly version: number; readonly verifiable: VerifiableCount; readonly unapplied: readonly UnappliedOp[] }>;
  /** The labels of the held changes the message confirmed that are declined (declinedCorrection), so not made. */
  readonly declinedConfirmations: readonly string[];
  readonly ops: readonly CheckedOp[];
  /** The keys the operations affect, as the hold reads them when they apply (affectedKeys). */
  readonly affected: readonly string[];
  readonly outcome:
    | {
        readonly status: "applied";
        readonly version: number;
        readonly direction: Direction;
        readonly applied: readonly AppliedOp[];
        readonly unapplied: readonly UnappliedOp[];
        readonly verifiable: VerifiableCount;
      }
    | { readonly status: "proposed"; readonly direction: Direction; readonly pushback: Pushback; readonly unapplied: readonly UnappliedOp[]; readonly verifiable: VerifiableCount }
    | { readonly status: "declined"; readonly unapplied: readonly UnappliedOp[]; readonly verifiable: VerifiableCount }
    | { readonly status: "unchanged"; readonly unapplied: readonly UnappliedOp[] };
  /**
   * The standing of the contract in force once the message is taken in: what the note says of the work
   * follows it (WORK_WORDS), and on a held one the note ends with the decline.
   */
  readonly contract: Exclude<ContractStanding, "unread">;
  readonly impact: ChangeImpact | null;
  readonly band: CostBand | null;
  /** Whether the project was halted when the correction was read: the contract changes, the work waits for the halt to end. */
  readonly paused: boolean;
}

const DIRECTION_WORDS: Readonly<Record<Direction, string>> = {
  widens: "widens what Ashara promises",
  narrows: "narrows what Ashara promises",
  neutral: "leaves what Ashara promises as wide as it was",
};

/** Why a declined correction is not made, and what would be: a restatement, never the same change confirmed or sent again. */
const CORRECTION_DECLINED =
  "it would leave your contract with no guarantee Ashara can verify as written, so the finished work could not be shown to hold and the project could not be accepted. " +
  "Send the guarantees it changes again, restated so that at least one is seen through what the product shows when it is used: what it outputs, how it reports an error or the status it ends with; " +
  "confirming this change or sending it again as it is does not make it.";

/**
 * What the client is told of a guarantee its change proposes that Ashara cannot verify with the checks
 * it can run, with the reason, and of one whose reading could not tell where it is observed.
 */
function unverifiable(observation: ClassifiedObservation): string {
  const told = markWords(markOf(observation));
  return told === null ? "" : ` (${told})`;
}

/** One operation in plain words, naming the record it acts on as the version in force holds it. */
function opLine(op: ContractOp, vision: VisionVersion): string {
  const named = (id: string, text: string | undefined) => (text === undefined ? id : `${id} ("${text}")`);
  switch (op.op) {
    case "add-guarantee":
      return `Add a guarantee: ${op.statement}${unverifiable(op.observation)}`;
    case "amend-guarantee":
      return `Change ${named(op.id, vision.guarantees.find((g) => g.id === op.id)?.statement)} to: ${op.statement}${unverifiable(op.observation)}`;
    case "withdraw-guarantee":
      return `Withdraw ${named(op.id, vision.guarantees.find((g) => g.id === op.id)?.statement)}`;
    case "amend-assumption":
      return `Change assumption ${named(op.id, vision.assumptions.find((a) => a.id === op.id)?.statement)} to: ${op.statement}`;
    case "add-exclusion":
      return `Leave out: ${op.text}`;
    case "withdraw-exclusion":
      return `No longer leave out ${named(op.id, vision.exclusions.find((x) => x.id === op.id)?.text)}`;
    case "add-interface":
      return `Add to the interface: ${op.text}`;
    case "amend-interface":
      return `Change interface entry ${named(op.id, vision.interface.find((e) => e.id === op.id)?.text)} to: ${op.text}`;
    case "withdraw-interface":
      return `Remove interface entry ${named(op.id, vision.interface.find((e) => e.id === op.id)?.text)}`;
  }
}

function unappliedLines(unapplied: readonly UnappliedOp[], vision: VisionVersion): string[] {
  if (unapplied.length === 0) return [];
  return [
    `These parts could not be made as read, because the contract would no longer hold together; send them again in other words if they are what you meant:\n` +
      unapplied.map(({ op, reason }) => `- ${opLine(op, vision)}: ${reason}`).join("\n"),
  ];
}

function list(ids: readonly string[]): string {
  return ids.length === 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.slice(-1).join("")}`;
}

function pushbackLine(reason: PushbackReason): string {
  if (reason.kind === "merged-guarantee") {
    const ids = list(reason.guarantees);
    const one = reason.guarantees.length === 1;
    return (
      `${ids} ${one ? "is" : "are"} already delivered: the work that delivers ${one ? "it" : "them"} is merged. Withdrawing or narrowing ` +
      `${one ? "it" : "them"} only stops checking what was promised; the code stays. Recommended instead: keep ${ids} as ${one ? "it is" : "they are"}, ` +
      `and if you want the behaviour gone, ask for a guarantee that the product does not do it.`
    );
  }
  return (
    `Its estimated cost, up to ${reason.highRequests} model requests, is more than the ${reason.budgetLeftRequests} this project's ` +
    `work budget has left. Recommended instead: send first the part of the change you need most.`
  );
}

function impactLines(note: CorrectionNote): string[] {
  const { impact, band } = note;
  if (impact === null || band === null) return [];
  const ids = note.affected;
  const cited =
    ids.length === 0
      ? ["No guarantee or assumption a task cites is affected."]
      : [
          `Affected: ${list(ids)}. Work citing ${ids.length === 1 ? "it" : "them"}:\n` +
            ids
              .map((id) => {
                const tasks = impact.tasks.filter((t) => t.cites.includes(id));
                return tasks.length === 0 ? `- ${id}: no planned task cites it yet` : `- ${id}: ${tasks.map((t) => `${t.title} (${t.status})`).join("; ")}`;
              })
              .join("\n"),
        ];
  const cost =
    band.kind === "measured"
      ? `Estimated cost: between ${band.lowRequests} and ${band.highRequests} model requests: ${band.tasks} affected task(s) times the fewest ` +
        `and the most requests a completed task of this project drew.`
      : `Estimated cost: no measured basis yet, since ${band.completedTasks === 0 ? "no task" : "only one task"} of this project has completed.`;
  return [...cited, cost];
}

/** The Liaison's one note on a correction message, posted in reply to it in the cycle it is read. Every sentence is from a record. */
export function correctionReport(note: CorrectionNote): string {
  const { vision, outcome } = note;
  const words = WORK_WORDS[note.contract];
  const confirmed = [
    ...note.confirmed.flatMap((c) => [
      `You confirmed the change held as ${c.label}; it is now part of the contract as version ${c.version}. ${verifiableCountLine(c.verifiable.verifiable, c.verifiable.total)}`,
      ...unappliedLines(c.unapplied, vision),
    ]),
    ...note.declinedConfirmations.map((label) => `You confirmed the change held as ${label}, but it is not made: ${CORRECTION_DECLINED}`),
  ];
  const read =
    note.ops.length === 0
      ? note.confirmed.length === 0 && note.declinedConfirmations.length === 0
        ? ["Your message was read as asking for no change to the contract, so nothing in it changed."]
        : []
      : [`Your change was read as:\n${note.ops.map(({ op, direction }) => `- ${opLine(op, vision)} (${DIRECTION_WORDS[direction]})`).join("\n")}`];
  const close = (() => {
    switch (outcome.status) {
      case "applied":
        return [
          ...unappliedLines(outcome.unapplied, vision),
          `The contract is now version ${outcome.version}; this revision ${DIRECTION_WORDS[outcome.direction]}.${note.paused ? "" : words.plannedContinues}`,
          verifiableCountLine(outcome.verifiable.verifiable, outcome.verifiable.total),
        ];
      case "proposed":
        return [
          ...outcome.pushback.reasons.map(pushbackLine),
          ...unappliedLines(outcome.unapplied, vision),
          `As this change would leave it: ${verifiableCountLine(outcome.verifiable.verifiable, outcome.verifiable.total)}`,
          words.confirmClose,
        ];
      case "declined":
        return [
          `This change is not made: ${CORRECTION_DECLINED}`,
          ...unappliedLines(outcome.unapplied, vision),
          `As this change would have left it: ${verifiableCountLine(outcome.verifiable.verifiable, outcome.verifiable.total)}`,
        ];
      case "unchanged":
        return note.ops.length === 0 ? [] : [...unappliedLines(outcome.unapplied, vision), "Nothing in the contract changed."];
    }
  })();
  return [...confirmed, ...read, ...impactLines(note), ...close, ...(note.paused ? [words.correctionPaused] : []), ...(note.contract === "held" ? [NOTHING_VERIFIABLE] : [])].join("\n\n");
}

/** The prompt that reads a change message against the contract in force and the proposals awaiting confirmation. */
export function correctionPrompt(vision: VisionVersion, body: string, proposals: readonly PendingProposal[]): string {
  const guarantees = vision.guarantees.map(
    (g) => `- ${g.id}: ${g.statement} (observed in its ${g.verification === "undecided" ? "undecided" : g.observation} at ${g.interface.join(", ") || "no entry"}; refuted by: ${g.refutedBy.join("; ") || "nothing recorded"})`,
  );
  return [
    `You are the Liaison of a software contractor. The client sent a message changing what they want built.`,
    `Read it into operations on the contract below. The client may change anything at any time; read what`,
    `they ask, never judge whether they should.`,
    ``,
    `Interface:`,
    ...vision.interface.map((e) => `- ${e.id}: ${e.text}`),
    ``,
    `Guarantees:`,
    ...guarantees,
    ``,
    `Assumptions:`,
    ...vision.assumptions.map((a) => `- ${a.id}: ${a.statement}`),
    ``,
    `Exclusions:`,
    ...(vision.exclusions.length === 0 ? ["- none"] : vision.exclusions.map((x) => `- ${x.id}: ${x.text}`)),
    ``,
    `Changes awaiting the client's confirmation:`,
    ...(proposals.length === 0 ? ["- none"] : proposals.map((p) => `- ${p.label}: ${JSON.stringify(p.ops)}`)),
    ``,
    `The client's message:`,
    JSON.stringify(body),
    ``,
    `Return {"correction": {"ops": [...], "confirms": [...]}}.`,
    `"ops" lists each change in the order the message asks, each one of:`,
    `- {"op": "add-guarantee", "statement", "interface": [interface ids], "observation", "refutedBy": [...], "direction"}`,
    `- {"op": "amend-guarantee", "id", "statement", "interface", "observation", "refutedBy", "direction"}: the guarantee restated whole`,
    `- {"op": "withdraw-guarantee", "id", "direction"}`,
    `- {"op": "amend-assumption", "id", "statement", "direction"}`,
    `- {"op": "add-exclusion", "text", "direction"} or {"op": "withdraw-exclusion", "id", "direction"}`,
    `- {"op": "add-interface", "text", "direction"}, {"op": "amend-interface", "id", "text", "direction"} or {"op": "withdraw-interface", "id", "direction"}`,
    ...OBSERVATION_RULE,
    `"direction" is "widens" when the change promises more, "narrows" when it promises less, "neutral" otherwise.`,
    `"confirms" lists the labels of the changes awaiting confirmation that the message explicitly confirms; silence confirms nothing.`,
    `A message that asks for no change and confirms nothing returns empty lists.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
  ].join("\n");
}

