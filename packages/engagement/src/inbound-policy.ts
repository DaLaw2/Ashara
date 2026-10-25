import type { PROJECT_LIFECYCLES } from "@ashara/db";
import type { HaltKind } from "@ashara/delivery/predicates";

// Engagement's one decision about an inbound client message: in each state its project can be in
// (Engagement's lifecycle, and while active Delivery's open halt by its kind and whether the tender's
// reading has written the project's first vision) and for each kind of
// message the client can send, whether the message is read now, once the halt ends, or never;
// whether the halt's end sets its count of failed readings back to none (nothing else ever does); whether
// its writer may still commit under the project's standing read under the row lock; and what the client
// is told of it. The readers admit a message by the SQL derived from it (predicates.ts), the writers
// re-read it under the lock (LockedStanding), the receipt and the halt report
// word it from it, and the halt's end resets the counts it names. The halt table is keyed
// on Delivery's whole halt vocabulary with no default, so a halt kind added there does not compile
// until it is decided here.

/** What the client can send. */
export const INBOUND_KINDS = ["tender", "answer", "change", "stop"] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

/** A lifecycle Engagement holds a project in. */
export type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];
/** A lifecycle in which the project is closed: nothing works on it again. */
export type ClosedLifecycle = Exclude<ProjectLifecycle, "active">;
export const CLOSED_LIFECYCLES = ["stopped", "accepted"] as const satisfies readonly ClosedLifecycle[];

/**
 * The project's state as the decision reads it: active, at work or under an open halt of its kind,
 * with or without the first vision its tender's reading writes; or closed.
 */
export type InboundState =
  | { readonly lifecycle: "active"; readonly halt: HaltKind | null; readonly visionWritten: boolean }
  | { readonly lifecycle: ClosedLifecycle };

/**
 * When the message is read: in this or the next round of work, once its project's tender is read,
 * once its project's halt ends, or never.
 */
type Reading = "now" | "after-tender" | "after-halt" | "never";

/** Why a reading waits out a halt it cannot get past. */
export type HaltWait = "budget" | "model-work";

/**
 * What the client is told of the message, before it is read: read at work, read once the project's
 * tender is read, read during the pause, read once the pause ends (for no reason beyond the pause, or
 * for the budget or the model work that holds the reading), recorded and not acted on (a closed
 * project), or the stop's own account.
 */
export type Told = "read-at-work" | "waits-for-tender" | "read-during-pause" | "waits-for-pause" | `waits-for-${HaltWait}` | "closed" | "stop";

export interface InboundDecision {
  readonly reading: Reading;
  /** A message at its cap of failed readings: read now, its reading halting the project as blamed, or after the halt. */
  readonly atCap: Reading;
  /** The end of the halt this state is under sets the message's count of failed readings back to none. */
  readonly resetOnHaltEnd: boolean;
  readonly told: Told;
}

/** What a halt does to the reading of the client's answers and changes. */
type HaltReading = { readonly reads: true } | { readonly reads: false; readonly because: HaltWait };

const READ: HaltReading = { reads: true };

/**
 * A halt pauses the work, never the reading of what the client said, except a halt the reading's own
 * model call cannot get past: a budget halt refuses it, and a halt on a model's or its provider's
 * failure, the plan revision's among them, would charge it an attempt for meeting that failure again.
 */
const HALT_READING = {
  budget_cap: { reads: false, because: "budget" },
  work_budget: { reads: false, because: "budget" },
  model_failed: { reads: false, because: "model-work" },
  provider_failed: { reads: false, because: "model-work" },
  replan_stopped: { reads: false, because: "model-work" },
  replan_provider_failed: { reads: false, because: "model-work" },
  configuration: READ,
  fault: READ,
  planning_stopped: READ,
  check_dispute: READ,
  replan_bound: READ,
  suite_review: READ,
  plan_repair: READ,
  infrastructure: READ,
  acceptance_uncovered: READ,
  // The answer the halt waits for is read during it: reading it is what ends the halt.
  client_wait: READ,
} as const satisfies Record<HaltKind, HaltReading>;

const STOP: InboundDecision = { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "stop" };

/**
 * At work every message is read, and one at its cap is read to halt the project as its failures
 * blame; except a change sent before the tender's reading wrote the first vision, which has nothing
 * to correct yet and waits for that reading.
 */
function atWork(visionWritten: boolean): Readonly<Record<InboundKind, InboundDecision>> {
  return {
    tender: { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "read-at-work" },
    answer: { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "read-at-work" },
    change: visionWritten
      ? { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "read-at-work" }
      : { reading: "after-tender", atCap: "after-tender", resetOnHaltEnd: false, told: "waits-for-tender" },
    stop: STOP,
  };
}

/**
 * A closed project's tender, answer and change are recorded and never read; its stop is the stop
 * step's, which tells the client it changed nothing.
 */
const CLOSED: Readonly<Record<InboundKind, InboundDecision>> = {
  tender: { reading: "never", atCap: "never", resetOnHaltEnd: false, told: "closed" },
  answer: { reading: "never", atCap: "never", resetOnHaltEnd: false, told: "closed" },
  change: { reading: "never", atCap: "never", resetOnHaltEnd: false, told: "closed" },
  stop: STOP,
};

/**
 * Under a halt: a tender waits for its end, since its reading starts the work the halt pauses. An
 * answer or a change is read during it unless HALT_READING says the halt holds the reading; one at its
 * cap waits for the halt's end either way, since its reading would only halt the project again. A
 * change sent before the first vision waits for the tender's reading, which waits for the halt's end,
 * whatever the halt. Every exit of the halt sets the count of failed readings of each message it held
 * back to none, so that it is read afresh: the opening of a halt sets back nothing, so a tender whose
 * failed readings opened the halt keeps its count, and its last error, for the operator until the
 * halt ends. A stop is read.
 */
function underHalt(halt: HaltKind, visionWritten: boolean): Readonly<Record<InboundKind, InboundDecision>> {
  const held = HALT_READING[halt];
  const input: InboundDecision = held.reads
    ? { reading: "now", atCap: "after-halt", resetOnHaltEnd: true, told: "read-during-pause" }
    : { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: `waits-for-${held.because}` };
  return {
    tender: { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-pause" },
    answer: input,
    change: visionWritten ? input : { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-pause" },
    stop: STOP,
  };
}

/** The decision for a message of `kind` sent to a project in `state`. */
export function inboundDecision(state: InboundState, kind: InboundKind): InboundDecision {
  if (state.lifecycle !== "active") return CLOSED[kind];
  return state.halt === null ? atWork(state.visionWritten)[kind] : underHalt(state.halt, state.visionWritten)[kind];
}

/** Why a message waits out a halt that holds its reading, in the client's words. */
export const WAITS_FOR_HALT_END: Readonly<Record<HaltWait, string>> = {
  budget: "Reading it takes model work, which the budget that paused this project does not allow, so Ashara reads it once the pause ends.",
  "model-work":
    "Reading it takes model work, and what paused this project is model work failing, so Ashara reads it once the pause ends rather than while it lasts.",
};
