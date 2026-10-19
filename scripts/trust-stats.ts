/**
 * The arithmetic of the trust record, pure and dependency-free so a pre-registration can pin it by digest: exact
 * one-sided Clopper-Pearson bounds, the exact one-sided McNemar test, the classification of each run x intended
 * guarantee pair, the aggregates the record prints and the stop rules in their fixed order.
 *
 * Every rate is intention-to-treat: a run that halted or posted no report keeps each intended guarantee in the
 * denominators as `not-reported`. Only a run that failed Sprint 0 leaves the false-confirm and recall denominators; it
 * is a delivery finding, counted per stack. The false-confirm denominator holds only guarantees the evidence can judge:
 * a hidden verdict that is unjudged, not adequacy-gated or a suite defect is no trial, so absent evidence never reads
 * as a guarantee without a false confirm.
 */

import type { Arm, PairRow } from "./trust-ledger.js";

/** The one-sided confidence of every bound the record prints. */
const CONFIDENCE = 0.95;
const BISECTION_STEPS = 200;

function logFactorials(n: number): readonly number[] {
  const table = [0];
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += Math.log(i);
    table.push(sum);
  }
  return table;
}

function lookup(table: readonly number[], index: number): number {
  const value = table[index];
  if (value === undefined) throw new RangeError(`log-factorial table has no entry ${index}`);
  return value;
}

/** P(X <= x) for X ~ Binomial(n, p), summed term by term in log space so large n neither overflows nor underflows. */
function binomialCdf(x: number, n: number, p: number, table: readonly number[]): number {
  if (p <= 0) return 1;
  if (p >= 1) return x >= n ? 1 : 0;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let sum = 0;
  for (let k = 0; k <= x; k++) {
    sum += Math.exp(lookup(table, n) - lookup(table, k) - lookup(table, n - k) + k * logP + (n - k) * logQ);
  }
  return Math.min(1, sum);
}

function checkCounts(x: number, n: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n) {
    throw new RangeError(`counts must be integers with 0 <= x <= n, got x=${x} n=${n}`);
  }
}

/**
 * @testseam trust-record.test.ts checks known bounds
 * The exact one-sided upper confidence bound for a binomial rate with `x` events in `n` trials: the rate at which
 * seeing `x` or fewer events has probability 1 - confidence. With no trials the bound is 1, the rate unconstrained.
 */
export function clopperPearsonUpper(x: number, n: number, confidence = CONFIDENCE): number {
  checkCounts(x, n);
  if (x === n) return 1;
  const table = logFactorials(n);
  const alpha = 1 - confidence;
  let low = 0;
  let high = 1;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const mid = (low + high) / 2;
    if (binomialCdf(x, n, mid, table) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

/**
 * @testseam trust-record.test.ts checks known discordant counts
 * The exact one-sided McNemar p-value that the first arm has fewer events than the second: `first` pairs where only the
 * first arm had the event, `second` where only the second did. It is P(X <= first) for X ~ Binomial(first + second,
 * one half), computed in integers so it is exact to the printed precision. With no discordant pair it is 1.
 */
export function mcnemarExactOneSided(first: number, second: number): number {
  checkCounts(first, first + second);
  const n = first + second;
  if (n === 0) return 1;
  let coefficient = 1n;
  let numerator = 0n;
  for (let k = 0; k <= first; k++) {
    numerator += coefficient;
    coefficient = (coefficient * BigInt(n - k)) / BigInt(k + 1);
  }
  const scale = 10n ** 18n;
  return Number((numerator * scale) / 2n ** BigInt(n)) / Number(scale);
}

type Cell =
  | "false-confirm"
  | "confirm"
  | "honest-non-confirm"
  | "missed-confirm"
  | "not-reported-hidden-fail"
  | "pass-hidden-unjudged"
  | "pass-ungated-fail"
  | "suite-defect"
  | "hidden-unjudged";

const CELLS: readonly Cell[] = [
  "false-confirm",
  "confirm",
  "honest-non-confirm",
  "missed-confirm",
  "not-reported-hidden-fail",
  "pass-hidden-unjudged",
  "pass-ungated-fail",
  "suite-defect",
  "hidden-unjudged",
];

/**
 * The cell of one pair. A pass on an intended guarantee the readers mapped to nothing or to a narrowed item is a false
 * confirm whatever the hidden suite said: a smaller or weaker list never raises the score. A pass the adequacy-gated
 * hidden suite fails is a false confirm; a hidden fail the operator's triage put on the suite is no product verdict.
 */
function classify(pair: PairRow): Cell {
  const reported = pair.reported.verdict;
  const hidden = pair.hidden.verdict;
  if (reported === "pass" && (pair.mapped.to === null || pair.mapped.narrowed)) return "false-confirm";
  if (pair.hidden.suiteDefect) return "suite-defect";
  if (reported === "pass") {
    if (hidden === "fail") return pair.hidden.adequacyGated ? "false-confirm" : "pass-ungated-fail";
    return hidden === "pass" ? "confirm" : "pass-hidden-unjudged";
  }
  if (hidden === "pass") return "missed-confirm";
  if (hidden === "fail") return reported === "not-reported" ? "not-reported-hidden-fail" : "honest-non-confirm";
  return "hidden-unjudged";
}

/**
 * Whether a pair is a trial of the false-confirm rate: every false confirm, and otherwise a guarantee the adequacy-gated
 * hidden suite judged pass or fail with no suite defect, whatever the arm reported.
 */
function isFalseConfirmTrial(pair: PairRow): boolean {
  if (classify(pair) === "false-confirm") return true;
  return pair.hidden.verdict !== "unjudged" && pair.hidden.adequacyGated && !pair.hidden.suiteDefect;
}

function falseConfirmRate(pairs: readonly PairRow[]): Rate {
  return rate(pairs.filter((pair) => classify(pair) === "false-confirm").length, pairs.filter(isFalseConfirmTrial).length);
}

export interface Rate {
  readonly events: number;
  readonly trials: number;
  readonly upper: number;
}

function rate(events: number, trials: number): Rate {
  return { events, trials, upper: clopperPearsonUpper(events, trials) };
}

export interface Fraction {
  readonly part: number;
  readonly whole: number;
}

export interface ArmSummary {
  readonly arm: Arm;
  readonly falseConfirm: Rate;
  /** Pairs outside the false-confirm denominator: the hidden suite left them unjudged, ungated or defective. */
  readonly unjudgedForFalseConfirm: number;
  readonly tendersWithFalseConfirm: number;
  readonly cells: readonly { readonly cell: Cell; readonly pairs: number }[];
  /** Confirms over hidden passes: every stratum, observations other than stored data, and stored data alone. */
  readonly recall: { readonly all: Fraction; readonly nonStored: Fraction; readonly stored: Fraction };
  readonly confirmsByEvidence: ReadonlyMap<string, number>;
  readonly perStack: ReadonlyMap<string, Rate>;
  readonly perKind: ReadonlyMap<string, Rate>;
  readonly perTender: ReadonlyMap<string, { readonly pairs: number; readonly falseConfirms: number }>;
  /** Intended guarantees the first contract draft covered, over the pairs that record a first draft. */
  readonly drafting: { readonly covered: Fraction; readonly narrowed: number };
  readonly readerAgreement: Fraction;
  readonly custody: ReadonlyMap<string, number>;
}

function increment<K>(map: Map<K, number>, key: K): void {
  const count = map.get(key);
  map.set(key, count === undefined ? 1 : count + 1);
}

function groupBy(pairs: readonly PairRow[], key: (pair: PairRow) => string): Map<string, PairRow[]> {
  const groups = new Map<string, PairRow[]>();
  for (const pair of pairs) {
    const group = groups.get(key(pair));
    if (group === undefined) groups.set(key(pair), [pair]);
    else group.push(pair);
  }
  return groups;
}

function rateBy(pairs: readonly PairRow[], key: (pair: PairRow) => string): ReadonlyMap<string, Rate> {
  const groups = groupBy(pairs, key);
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, falseConfirmRate(group)]));
}

function recallOf(pairs: readonly PairRow[]): Fraction {
  return { part: pairs.filter((pair) => classify(pair) === "confirm").length, whole: pairs.filter((pair) => !pair.hidden.suiteDefect && pair.hidden.verdict === "pass").length };
}

/** The headline figures of one arm over the pairs given, which the caller has already restricted. */
export function summarizeArm(arm: Arm, pairs: readonly PairRow[]): ArmSummary {
  const own = pairs.filter((pair) => pair.arm === arm);
  const confirmsByEvidence = new Map<string, number>();
  const perTender = new Map<string, { pairs: number; falseConfirms: number }>();
  const custody = new Map<string, number>();
  for (const pair of own) {
    const cell = classify(pair);
    if (cell === "confirm" && pair.reported.evidence !== null) increment(confirmsByEvidence, pair.reported.evidence);
    const tender = perTender.get(pair.tender) ?? { pairs: 0, falseConfirms: 0 };
    perTender.set(pair.tender, { pairs: tender.pairs + 1, falseConfirms: tender.falseConfirms + (cell === "false-confirm" ? 1 : 0) });
    increment(custody, pair.custody);
  }
  const drafted = own.flatMap((pair) => (pair.firstDraft === null ? [] : [pair.firstDraft]));
  return {
    arm,
    falseConfirm: falseConfirmRate(own),
    unjudgedForFalseConfirm: own.filter((pair) => !isFalseConfirmTrial(pair)).length,
    tendersWithFalseConfirm: [...perTender.values()].filter((tender) => tender.falseConfirms > 0).length,
    cells: CELLS.map((cell) => ({ cell, pairs: own.filter((pair) => classify(pair) === cell).length })),
    recall: {
      all: recallOf(own),
      nonStored: recallOf(own.filter((pair) => pair.observation !== "stored-data")),
      stored: recallOf(own.filter((pair) => pair.observation === "stored-data")),
    },
    confirmsByEvidence,
    perStack: rateBy(own, (pair) => pair.stack),
    perKind: rateBy(own, (pair) => pair.tenderKind),
    perTender: new Map([...perTender].sort(([a], [b]) => a.localeCompare(b))),
    drafting: { covered: { part: drafted.filter((draft) => draft.covered).length, whole: drafted.length }, narrowed: drafted.filter((draft) => draft.narrowed).length },
    readerAgreement: { part: own.filter((pair) => pair.mapped.agreed).length, whole: own.length },
    custody,
  };
}

export interface Delivery {
  readonly runs: number;
  readonly terminal: number;
  readonly sprint0Failed: number;
  readonly noReport: number;
}

/** Runs per stack of one arm, by how each ended; one run counts once however many pairs it has. */
export function deliveryPerStack(arm: Arm, pairs: readonly PairRow[]): ReadonlyMap<string, Delivery> {
  const runs = new Map<string, PairRow>();
  for (const pair of pairs) if (pair.arm === arm && !runs.has(pair.run)) runs.set(pair.run, pair);
  const perStack = new Map<string, Delivery>();
  for (const run of runs.values()) {
    const entry = perStack.get(run.stack) ?? { runs: 0, terminal: 0, sprint0Failed: 0, noReport: 0 };
    perStack.set(run.stack, {
      runs: entry.runs + 1,
      terminal: entry.terminal + (run.runOutcome === "terminal" ? 1 : 0),
      sprint0Failed: entry.sprint0Failed + (run.runOutcome === "sprint0-failed" ? 1 : 0),
      noReport: entry.noReport + (run.runOutcome === "no-report" ? 1 : 0),
    });
  }
  return new Map([...perStack].sort(([a], [b]) => a.localeCompare(b)));
}

export type Paired =
  | { readonly kind: "evaluable"; readonly pairs: number; readonly asharaOnly: number; readonly baselineOnly: number; readonly p: number; readonly unpaired: number }
  | { readonly kind: "not evaluable"; readonly reason: string };

/**
 * The paired comparison of false confirms between the Ashara and baseline arms on the same tender and intended
 * guarantee. It needs exactly one row of each arm per guarantee to pair; a tender run more than once by an arm in the
 * stage cannot be paired and leaves the comparison not evaluable rather than guessing which run to pair.
 */
export function pairedComparison(pairs: readonly PairRow[]): Paired {
  const byKey = new Map<string, { tender: string; ashara: PairRow[]; baseline: PairRow[] }>();
  for (const pair of pairs) {
    if (pair.arm !== "ashara" && pair.arm !== "baseline") continue;
    const key = `${pair.tender}\0${pair.intended}`;
    const entry = byKey.get(key) ?? { tender: pair.tender, ashara: [], baseline: [] };
    entry[pair.arm].push(pair);
    byKey.set(key, entry);
  }
  const arms = new Set(pairs.map((pair) => pair.arm));
  if (!arms.has("ashara") || !arms.has("baseline")) return { kind: "not evaluable", reason: `the stage has no ${arms.has("ashara") ? "baseline" : "Ashara"} rows` };
  let asharaOnly = 0;
  let baselineOnly = 0;
  let matched = 0;
  let unpaired = 0;
  for (const entry of byKey.values()) {
    if (entry.ashara.length > 1 || entry.baseline.length > 1) {
      return { kind: "not evaluable", reason: `tender ${entry.tender} has more than one run of an arm in the stage` };
    }
    const [ashara] = entry.ashara;
    const [baseline] = entry.baseline;
    if (ashara === undefined || baseline === undefined) {
      unpaired++;
      continue;
    }
    matched++;
    const a = classify(ashara) === "false-confirm";
    const b = classify(baseline) === "false-confirm";
    if (a && !b) asharaOnly++;
    if (b && !a) baselineOnly++;
  }
  return { kind: "evaluable", pairs: matched, asharaOnly, baselineOnly, p: mcnemarExactOneSided(asharaOnly, baselineOnly), unpaired };
}

/**
 * The tenders reported in the regression column: those the stage registered there, and every tender one of whose run
 * labels a citing text (a commit message, a board entry) names. Naming a label wrongly only shrinks the headline.
 */
export function regressionTenders(pairs: readonly PairRow[], registered: readonly string[], citingTexts: readonly string[]): ReadonlySet<string> {
  const tenders = new Set(registered);
  const labels = new Map<string, string>();
  for (const pair of pairs) labels.set(pair.run, pair.tender);
  for (const [label, tender] of labels) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])${label.replaceAll(".", "\\.")}(?![A-Za-z0-9_-])`);
    if (citingTexts.some((text) => pattern.test(text))) tenders.add(tender);
  }
  return tenders;
}

export interface StopVerdict {
  readonly rule: "STOP-INFRA" | "STOP-HONESTY" | "STOP-FUTILITY" | "STOP-INDISCRIMINATE";
  readonly status: "triggered" | "clear" | "not evaluable";
  readonly detail: string;
  /** The ledger rows behind a triggered rule. */
  readonly seqs: readonly number[];
}

/** How many incomplete or suite-defect hidden verdicts stop the stage for the rig to be fixed. */
const INFRA_LIMIT = 3;
/** How many discordant false confirms the baseline must have before a tie or loss is read as futility. */
const FUTILITY_BASELINE_MIN = 3;

/**
 * The rows that make one run's hidden verdict a rig fault: every suite-defect row, and the unjudged rows when the run's
 * hidden overall is incomplete. A real product fail makes the overall `fail`, so an unjudged guarantee beside it is no
 * fault of the rig.
 */
function infraFaultSeqs(rows: readonly PairRow[]): readonly number[] {
  const realFail = rows.some((pair) => pair.hidden.verdict === "fail" && !pair.hidden.suiteDefect);
  return rows.filter((pair) => pair.hidden.suiteDefect || (!realFail && pair.hidden.verdict === "unjudged")).map((pair) => pair.seq);
}

/**
 * The stop rules in their fixed order. The rig and honesty rules read every pair of the stage, regression tenders
 * included, since an infrastructure fault or a false confirm anywhere halts paid passes; the futility and
 * indiscriminate rules read the headline the comparison is made on.
 */
export function stopRules(stagePairs: readonly PairRow[], headline: readonly PairRow[], paired: Paired): readonly StopVerdict[] {
  const runs = groupBy(
    stagePairs.filter((pair) => pair.runOutcome !== "sprint0-failed"),
    (pair) => `${pair.run}\0${pair.arm}`,
  );
  const faulty = [...runs.values()].map(infraFaultSeqs).filter((seqs) => seqs.length > 0);
  const infraSeqs = faulty.flat();
  const infra: StopVerdict = {
    rule: "STOP-INFRA",
    status: faulty.length >= INFRA_LIMIT ? "triggered" : "clear",
    detail: `${faulty.length} hidden verdict(s) incomplete or with a suite defect; the rule stops at ${INFRA_LIMIT}`,
    seqs: faulty.length >= INFRA_LIMIT ? infraSeqs : [],
  };

  const ashara = stagePairs.filter((pair) => pair.arm === "ashara");
  const dishonest = ashara.filter((pair) => classify(pair) === "false-confirm" && (pair.hidden.adequacyGated || pair.observation === "stored-data"));
  const honesty: StopVerdict =
    ashara.length === 0
      ? { rule: "STOP-HONESTY", status: "not evaluable", detail: "the stage has no Ashara rows", seqs: [] }
      : {
          rule: "STOP-HONESTY",
          status: dishonest.length > 0 ? "triggered" : "clear",
          detail: `${dishonest.length} Ashara false confirm(s) on an adequacy-gated or stored-data guarantee`,
          seqs: dishonest.map((pair) => pair.seq),
        };

  const futility: StopVerdict =
    paired.kind === "not evaluable"
      ? { rule: "STOP-FUTILITY", status: "not evaluable", detail: paired.reason, seqs: [] }
      : {
          rule: "STOP-FUTILITY",
          status: paired.asharaOnly >= paired.baselineOnly && paired.baselineOnly >= FUTILITY_BASELINE_MIN ? "triggered" : "clear",
          detail: `discordant false confirms: Ashara only ${paired.asharaOnly}, baseline only ${paired.baselineOnly}; the rule needs Ashara's at least the baseline's and the baseline's at least ${FUTILITY_BASELINE_MIN}`,
          seqs: [],
        };

  const headlineArms = new Set(headline.map((pair) => pair.arm));
  const falseConfirms = headline.filter((pair) => (pair.arm === "ashara" || pair.arm === "baseline") && classify(pair) === "false-confirm");
  const indiscriminate: StopVerdict =
    !headlineArms.has("ashara") || !headlineArms.has("baseline")
      ? { rule: "STOP-INDISCRIMINATE", status: "not evaluable", detail: "the headline lacks an Ashara or a baseline arm", seqs: [] }
      : {
          rule: "STOP-INDISCRIMINATE",
          status: falseConfirms.length === 0 ? "triggered" : "clear",
          detail: `${falseConfirms.length} false confirm(s) across the Ashara and baseline arms of the headline`,
          seqs: [],
        };
  return [infra, honesty, futility, indiscriminate];
}
