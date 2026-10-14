/**
 * The adversary and fault profiles of design §4.7 and §4.9: each seed draws one, then every
 * event is drawn independently with the profile's probability.
 */
export const PROFILES = ["benign", "typical", "hostile", "chaos"] as const;
export type Profile = (typeof PROFILES)[number];

/** Each event of design §4.7 the simulator models, with where it acts. */
export interface AdversaryRates {
  /** An implementation also writes behaviours of later tasks. */
  readonly overDelivery: number;
  /** An implementation omits one of its behaviours and finishes done. */
  readonly underDelivery: number;
  /** An implementation deletes a delivered behaviour. */
  readonly regression: number;
  /** A check requires a behaviour no correct product has. */
  readonly wrongCheck: number;
  /** A check forbids a behaviour another task's check requires. */
  readonly contradictoryCheck: number;
  /** A check that always passes. */
  readonly vacuousCheck: number;
  /** Every check of a set passes on the foundation. */
  readonly allGuardSet: number;
  /** A check requires a behaviour no vision item names. */
  readonly outOfVisionCheck: number;
  /** A check that fails at random on correct work. */
  readonly flakyCheck: number;
  /** A check whose command cannot run, or runs past its limit. */
  readonly unrunnableCheck: number;
  /** The check author also writes product files (run 8 E1, E2). */
  readonly authorWritesProduct: number;
  /** The model ends a turn with no tool call (a refusal). */
  readonly refusal: number;
  /** The attempt runs out of turns. */
  readonly timeout: number;
  /** A structured call answers with output that does not validate. */
  readonly invalidOutput: number;
  /** An implementer facing a wrong or contradictory check disputes it. */
  readonly disputeRight: number;
  /** An implementer facing a correct failing check disputes it. */
  readonly disputeWrong: number;
  /** The suite review catches a wrong, contradictory or out-of-vision check. */
  readonly reviewCatch: number;
  /** Sprint 0 writes a recipe defect (run 6: a cache dir owned by root). */
  readonly recipeDefect: number;
  /** The client answers a question by changing its assumption after the first merge. */
  readonly lateChange: number;
  /** The client stops the project at a random step. */
  readonly clientStop: number;
  /** The spend cap is set below what the plan needs. */
  readonly lowBudget: number;
}

export interface FaultRates {
  /** Probability that one seam call carries a fault, while the budget lasts. */
  readonly perSeamCall: number;
  /** Faults a run may carry at most (design §4.9), so liveness stays meaningful. */
  readonly budget: number;
}

export const ADVERSARY: Readonly<Record<Profile, AdversaryRates>> = {
  benign: {
    overDelivery: 0, underDelivery: 0, regression: 0, wrongCheck: 0, contradictoryCheck: 0, vacuousCheck: 0,
    allGuardSet: 0, outOfVisionCheck: 0, flakyCheck: 0, unrunnableCheck: 0, authorWritesProduct: 0, refusal: 0,
    timeout: 0, invalidOutput: 0, disputeRight: 0, disputeWrong: 0, reviewCatch: 1, recipeDefect: 0, lateChange: 0,
    clientStop: 0, lowBudget: 0,
  },
  typical: {
    overDelivery: 0.3, underDelivery: 0.15, regression: 0.05, wrongCheck: 0.05, contradictoryCheck: 0.05, vacuousCheck: 0.05,
    allGuardSet: 0.02, outOfVisionCheck: 0.1, flakyCheck: 0.03, unrunnableCheck: 0.05, authorWritesProduct: 0.4, refusal: 0.02,
    timeout: 0.05, invalidOutput: 0.1, disputeRight: 0.8, disputeWrong: 0.05, reviewCatch: 0.9, recipeDefect: 0.05,
    lateChange: 0.1, clientStop: 0.02, lowBudget: 0.05,
  },
  hostile: {
    overDelivery: 0.6, underDelivery: 0.35, regression: 0.15, wrongCheck: 0.2, contradictoryCheck: 0.15, vacuousCheck: 0.15,
    allGuardSet: 0.1, outOfVisionCheck: 0.2, flakyCheck: 0.1, unrunnableCheck: 0.1, authorWritesProduct: 0.4, refusal: 0.05,
    timeout: 0.1, invalidOutput: 0.2, disputeRight: 0.9, disputeWrong: 0.2, reviewCatch: 0.7, recipeDefect: 0.15,
    lateChange: 0.2, clientStop: 0.05, lowBudget: 0.1,
  },
  chaos: {
    overDelivery: 0.8, underDelivery: 0.5, regression: 0.3, wrongCheck: 0.3, contradictoryCheck: 0.3, vacuousCheck: 0.3,
    allGuardSet: 0.2, outOfVisionCheck: 0.3, flakyCheck: 0.2, unrunnableCheck: 0.2, authorWritesProduct: 0.6, refusal: 0.1,
    timeout: 0.2, invalidOutput: 0.3, disputeRight: 0.9, disputeWrong: 0.4, reviewCatch: 0.5, recipeDefect: 0.3,
    lateChange: 0.3, clientStop: 0.1, lowBudget: 0.2,
  },
};

export const FAULTS: Readonly<Record<Profile, FaultRates>> = {
  benign: { perSeamCall: 0, budget: 0 },
  typical: { perSeamCall: 0.002, budget: 3 },
  hostile: { perSeamCall: 0.005, budget: 10 },
  chaos: { perSeamCall: 0.01, budget: 30 },
};

/** The profile a seed draws when none is given: 10% benign, 40% typical, 40% hostile, 10% chaos. */
export function profileOfSeed(seed: number): Profile {
  const bucket = Math.abs(seed) % 10;
  if (bucket === 0) return "benign";
  if (bucket <= 4) return "typical";
  if (bucket <= 8) return "hostile";
  return "chaos";
}
