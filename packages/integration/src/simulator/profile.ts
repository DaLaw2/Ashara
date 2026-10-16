import type { Tape } from "./tape.js";

/**
 * The adversary and fault profiles of design §4.7 and §4.9: each seed draws one, then every
 * event is drawn independently with the profile's probability. `adversarial` is chosen by name
 * only (`--profile adversarial`, never profileOfSeed): the models misbehave at the response level
 * at high rates and no seam fault is injected, so what fails is the code's answer to the model.
 */
export const PROFILES = ["benign", "typical", "hostile", "chaos", "adversarial"] as const;
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
  /** The check author also writes product files. */
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
  /** The suite review rejects a correct check as outside the vision, its missing clause one its cited item states. */
  readonly reviewMisread: number;
  /** Sprint 0 writes a recipe defect (a cache dir owned by root). */
  readonly recipeDefect: number;
  /** An implementation leaves the public interface file as the scaffold wrote it. */
  readonly interfaceLeftStale: number;
  /** The client answers a question by changing its assumption after the first merge. */
  readonly lateChange: number;
  /** The client stops the project at a random step. */
  readonly clientStop: number;
  /** The spend cap is set below what the plan needs. */
  readonly lowBudget: number;
  /*
   * Response-level misbehaviour (docs/investigations/test-retro-2026-10-15/, pattern 2). Each reaches production as a
   * provider's response would: through the gateway, the attempt loop and the routers.
   */
  /** An implementation also writes the product's shared index, which a batch partner may write too. */
  readonly sharedFileEdit: number;
  /** An implementer handed its conflict with main leaves the conflict markers in. */
  readonly conflictMarkersLeft: number;
  /** An agent turn is cut at the output limit in the middle of a tool call (finish reason length). */
  readonly truncatedTurn: number;
  /** An agent turn answers with no content at all. */
  readonly emptyTurn: number;
  /** A call spends its whole output bound on reasoning and returns no answer. */
  readonly reasoningExhausted: number;
  /** The attempt runs out of turns after some of its edits and before the rest, leaving that work uncommitted. */
  readonly turnCapMidEdit: number;
  /** A structured answer is cut at the output limit in the middle of its object. */
  readonly truncatedStructured: number;
  /** A structured call answers with no content at all. */
  readonly emptyStructured: number;
}

export interface FaultRates {
  /** Probability that one seam call carries a fault, while the budget lasts. */
  readonly perSeamCall: number;
  /** Faults a run may carry at most (design §4.9), so liveness stays meaningful. */
  readonly budget: number;
}

/** No response-level misbehaviour: the profiles the stand-ins cooperate under at the response level. */
const COOPERATIVE_RESPONSES = {
  sharedFileEdit: 0, conflictMarkersLeft: 0, truncatedTurn: 0, emptyTurn: 0, reasoningExhausted: 0, turnCapMidEdit: 0,
  truncatedStructured: 0, emptyStructured: 0,
} as const;

const ADVERSARY: Readonly<Record<Profile, AdversaryRates>> = {
  benign: {
    overDelivery: 0, underDelivery: 0, regression: 0, wrongCheck: 0, contradictoryCheck: 0, vacuousCheck: 0,
    allGuardSet: 0, outOfVisionCheck: 0, flakyCheck: 0, unrunnableCheck: 0, authorWritesProduct: 0, refusal: 0,
    timeout: 0, invalidOutput: 0, disputeRight: 0, disputeWrong: 0, reviewCatch: 1, reviewMisread: 0, recipeDefect: 0, interfaceLeftStale: 0, lateChange: 0,
    clientStop: 0, lowBudget: 0, ...COOPERATIVE_RESPONSES,
  },
  typical: {
    overDelivery: 0.3, underDelivery: 0.15, regression: 0.05, wrongCheck: 0.05, contradictoryCheck: 0.05, vacuousCheck: 0.05,
    allGuardSet: 0.02, outOfVisionCheck: 0.1, flakyCheck: 0.03, unrunnableCheck: 0.05, authorWritesProduct: 0.4, refusal: 0.02,
    timeout: 0.05, invalidOutput: 0.1, disputeRight: 0.8, disputeWrong: 0.05, reviewCatch: 0.9, reviewMisread: 0.05, recipeDefect: 0.05,
    interfaceLeftStale: 0.3, lateChange: 0.1, clientStop: 0.02, lowBudget: 0.05, ...COOPERATIVE_RESPONSES,
  },
  hostile: {
    overDelivery: 0.6, underDelivery: 0.35, regression: 0.15, wrongCheck: 0.2, contradictoryCheck: 0.15, vacuousCheck: 0.15,
    allGuardSet: 0.1, outOfVisionCheck: 0.2, flakyCheck: 0.1, unrunnableCheck: 0.1, authorWritesProduct: 0.4, refusal: 0.05,
    timeout: 0.1, invalidOutput: 0.2, disputeRight: 0.9, disputeWrong: 0.2, reviewCatch: 0.7, reviewMisread: 0.1, recipeDefect: 0.15,
    interfaceLeftStale: 0.5, lateChange: 0.2, clientStop: 0.05, lowBudget: 0.1,
    sharedFileEdit: 0.15, conflictMarkersLeft: 0.2, truncatedTurn: 0.02, emptyTurn: 0.02, reasoningExhausted: 0.02, turnCapMidEdit: 0.05,
    truncatedStructured: 0.02, emptyStructured: 0.02,
  },
  chaos: {
    overDelivery: 0.8, underDelivery: 0.5, regression: 0.3, wrongCheck: 0.3, contradictoryCheck: 0.3, vacuousCheck: 0.3,
    allGuardSet: 0.2, outOfVisionCheck: 0.3, flakyCheck: 0.2, unrunnableCheck: 0.2, authorWritesProduct: 0.6, refusal: 0.1,
    timeout: 0.2, invalidOutput: 0.3, disputeRight: 0.9, disputeWrong: 0.4, reviewCatch: 0.5, reviewMisread: 0.2, recipeDefect: 0.3,
    interfaceLeftStale: 0.6, lateChange: 0.3, clientStop: 0.1, lowBudget: 0.2,
    sharedFileEdit: 0.3, conflictMarkersLeft: 0.3, truncatedTurn: 0.04, emptyTurn: 0.04, reasoningExhausted: 0.04, turnCapMidEdit: 0.1,
    truncatedStructured: 0.04, emptyStructured: 0.04,
  },
  adversarial: {
    overDelivery: 0.3, underDelivery: 0.15, regression: 0.05, wrongCheck: 0.1, contradictoryCheck: 0.1, vacuousCheck: 0.05,
    allGuardSet: 0.02, outOfVisionCheck: 0.1, flakyCheck: 0.03, unrunnableCheck: 0.05, authorWritesProduct: 0.4, refusal: 0.02,
    timeout: 0.02, invalidOutput: 0.05, disputeRight: 0.8, disputeWrong: 0.05, reviewCatch: 0.9, reviewMisread: 0.3, recipeDefect: 0.05,
    interfaceLeftStale: 0.3, lateChange: 0.1, clientStop: 0.02, lowBudget: 0,
    // A stalled attempt spends its whole turn cap; each unpriced stand-in call counts at its worst-case estimate.
    sharedFileEdit: 0.7, conflictMarkersLeft: 0.3, truncatedTurn: 0.06, emptyTurn: 0.06, reasoningExhausted: 0.05, turnCapMidEdit: 0.08,
    truncatedStructured: 0.05, emptyStructured: 0.05,
  },
};

export const FAULTS: Readonly<Record<Profile, FaultRates>> = {
  benign: { perSeamCall: 0, budget: 0 },
  typical: { perSeamCall: 0.002, budget: 3 },
  hostile: { perSeamCall: 0.005, budget: 10 },
  chaos: { perSeamCall: 0.01, budget: 30 },
  adversarial: { perSeamCall: 0, budget: 0 },
};

/** A rate drawn once per seed, from its benign end (decision value 0) toward its worst end. */
interface RateSpread {
  readonly benign: number;
  readonly worst: number;
}

/**
 * The rates a profile draws per seed instead of fixing them: a suite review that catches at one
 * fixed rate says nothing of a review that misses more.
 */
const VARIED_RATES = ["reviewCatch", "disputeRight", "disputeWrong"] as const;
type VariedRate = (typeof VARIED_RATES)[number];
/** Steps of a varied rate's draw between its two ends. */
const SPREAD_STEPS = 10;

/** The profiles whose review and dispute rates are drawn per seed; benign and typical keep ADVERSARY's. */
const SPREADS: Readonly<Record<Profile, Readonly<Partial<Record<VariedRate, RateSpread>>>>> = {
  benign: {},
  typical: {},
  hostile: { reviewCatch: { benign: 0.95, worst: 0.2 }, disputeRight: { benign: 0.95, worst: 0.3 }, disputeWrong: { benign: 0.05, worst: 0.5 } },
  chaos: { reviewCatch: { benign: 0.9, worst: 0 }, disputeRight: { benign: 0.95, worst: 0.2 }, disputeWrong: { benign: 0.1, worst: 0.7 } },
  adversarial: { reviewCatch: { benign: 1, worst: 0 }, disputeRight: { benign: 1, worst: 0 }, disputeWrong: { benign: 0, worst: 0.8 } },
};

/**
 * The seed's adversary rates: the profile's, with each rate SPREADS varies drawn once from the tape
 * (`rates.<name>`), so a seed's review misses and its implementers dispute at its own rates, the
 * same on every replay and in every process.
 */
export function drawRates(profile: Profile, tape: Tape): AdversaryRates {
  let rates: AdversaryRates = ADVERSARY[profile];
  for (const name of VARIED_RATES) {
    const spread = SPREADS[profile][name];
    if (spread === undefined) continue;
    const step = tape.pick(`rates.${name}`, SPREAD_STEPS + 1);
    rates = { ...rates, [name]: spread.benign + ((spread.worst - spread.benign) * step) / SPREAD_STEPS };
  }
  return rates;
}

/** The profile a seed draws when none is given: 10% benign, 40% typical, 40% hostile, 10% chaos. */
export function profileOfSeed(seed: number): Profile {
  const bucket = Math.abs(seed) % 10;
  if (bucket === 0) return "benign";
  if (bucket <= 4) return "typical";
  if (bucket <= 8) return "hostile";
  return "chaos";
}
