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
 * The correction a run posts: every seeded run posts one, so a soak judges a correction on every
 * seed whose run reaches its arrival; the zero draw, which replayed and directed runs take unless
 * told otherwise, posts none. Its arrival and kind are one pair of CORRECTION_PAIRS, the seed's own
 * (Tape.rotate), so any CORRECTION_PAIRS.length consecutive seeds draw every pair. The arrival
 * varies fastest: whether a run reaches an arrival depends on the run, so each arrival is tried on
 * every fourth seed, across the profiles of profileOfSeed, rather than on a block of neighbours.
 */
export function drawCorrection(tape: Tape): CorrectionDraw | null {
  if (!tape.chance("client.correction", 1)) return null;
  const pair = tape.rotate("correction.pair", CORRECTION_ARRIVALS.length * CORRECTION_KINDS.length);
  const arrival = CORRECTION_ARRIVALS[pair % CORRECTION_ARRIVALS.length];
  const kind = CORRECTION_KINDS[Math.floor(pair / CORRECTION_ARRIVALS.length)];
  if (arrival === undefined || kind === undefined)
    throw new RangeError(`the correction draw ${pair} fell outside its lists`);
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
