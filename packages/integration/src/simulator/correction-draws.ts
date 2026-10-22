import type { Tape } from "./tape.js";

/**
 * When the client's correction arrives (run.ts), the first the benign draw:
 * - after-merge: once a goal task has merged;
 * - before-review: once the first plan is on record, before any suite review is answered;
 * - in-progress: during an agent turn of a task citing a contract key, while that task is InProgress;
 * - halted: once the project is halted.
 */
const CORRECTION_ARRIVALS = ["after-merge", "before-review", "in-progress", "halted"] as const;
type CorrectionArrival = (typeof CORRECTION_ARRIVALS)[number];

/**
 * What the client's correction asks of the contract, as the scripted Liaison reads it
 * (stand-ins/liaison.ts correction), the first the benign draw:
 * - rewrite-guarantee: a guarantee a goal task not yet started cites, restated whole and widened;
 * - add-exclusion: one more thing left out;
 * - add-guarantee: a new guarantee naming a behaviour, observed where an existing one is;
 * - withdraw-guarantee: the guarantee naming no behaviour withdrawn;
 * - change-assumption: an assumption restated;
 * - change-interface: an interface entry restated.
 */
const CORRECTION_KINDS = [
  "rewrite-guarantee",
  "add-exclusion",
  "add-guarantee",
  "withdraw-guarantee",
  "change-assumption",
  "change-interface",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export interface CorrectionDraw {
  readonly arrival: CorrectionArrival;
  readonly kind: CorrectionKind;
}

/**
 * The arrival a seed draws its correction at, by its last digit, which is the digit profile.ts
 * profileOfSeed draws its profile by (0 benign, 1-4 typical, 5-8 hostile, 9 chaos): each arrival
 * goes to the profiles whose runs reach it and still read a correction there. A benign run merges
 * its goal tasks before any spend-cap halt, which cuts most other runs short of a merge; a halted
 * arrival needs a halt Ashara reads messages under, the client's decision the implementer is made
 * to wait on (run-setup.ts drawRun), which a typical or hostile run reaches; the arrivals before
 * the work's first review or during its first turns come before most spend-cap halts.
 */
const ARRIVAL_OF_DIGIT: readonly CorrectionArrival[] = [
  "after-merge",
  "halted",
  "in-progress",
  "in-progress",
  "in-progress",
  "before-review",
  "before-review",
  "before-review",
  "halted",
  "before-review",
];

/**
 * Why 60: a seed's kind is its tens digit's, modulo the kinds, so each last digit takes every kind in
 * any six consecutive tens.
 */
const KIND_CYCLE_SEEDS = CORRECTION_KINDS.length * 10;

/**
 * The correction a run posts: every seeded run posts one, so a soak judges a correction on every
 * seed whose run reaches its arrival; the zero draw, which replayed and directed runs take unless
 * told otherwise, posts none. Its arrival is its last digit's (ARRIVAL_OF_DIGIT) and its kind its
 * tens digit's (Tape.rotate), so any KIND_CYCLE_SEEDS consecutive seeds draw every kind at every
 * arrival, each on every profile the arrival is drawn for.
 */
export function drawCorrection(tape: Tape): CorrectionDraw | null {
  if (!tape.chance("client.correction", 1)) return null;
  const turn = tape.rotate("correction.pair", KIND_CYCLE_SEEDS);
  const arrival = ARRIVAL_OF_DIGIT[turn % 10];
  const kind = CORRECTION_KINDS[Math.floor(turn / 10)];
  if (arrival === undefined || kind === undefined)
    throw new RangeError(`the correction draw ${turn} fell outside its lists`);
  return { arrival, kind };
}

/** A correction's arrival and kind as the coverage set `corrections` holds them. */
export function correctionPair(draw: CorrectionDraw): string {
  return `${draw.arrival}:${draw.kind}`;
}

/** Every arrival and kind together: what a soak's corrections cover. */
export const CORRECTION_PAIRS: readonly string[] = CORRECTION_ARRIVALS.flatMap((arrival) =>
  CORRECTION_KINDS.map((kind) => correctionPair({ arrival, kind })),
);
