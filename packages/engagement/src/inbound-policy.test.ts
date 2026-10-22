import { describe, expect, test } from "vitest";
import { PROJECT_LIFECYCLES } from "@ashara/db";
import { HALT_KINDS } from "@ashara/delivery/predicates";
import { CLOSED_LIFECYCLES, INBOUND_KINDS, inboundDecision } from "./inbound-policy.js";
import type { InboundDecision, InboundKind, InboundState } from "./inbound-policy.js";

// Every cell of the inbound-message decision, project state (each lifecycle, and while active no halt
// or each of Delivery's halt kinds, each with and without the first vision) by message kind, held to
// the decided behaviour spelled here on its own: budget halts hold the reading and say so, model-work
// halts hold it and say so, every other halt reads answers and changes during it, a closed project
// records and never reads, a tender waits out any halt, a change before the first vision waits for
// the tender's reading, a stop is always read, and every halt's end resets the counts of tenders,
// answers and changes.

const BUDGET_HALTS: readonly string[] = ["budget_cap", "work_budget"];
const MODEL_WORK_HALTS: readonly string[] = ["model_failed", "provider_failed", "replan_stopped", "replan_provider_failed"];

const VISION_STATES = [true, false] as const;

function expectedUnderHalt(halt: string, kind: InboundKind, visionWritten: boolean): InboundDecision {
  if (kind === "stop") return { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "stop" };
  if (kind === "tender") return { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-pause" };
  if (kind === "change" && !visionWritten) return { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-pause" };
  if (BUDGET_HALTS.includes(halt)) return { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-budget" };
  if (MODEL_WORK_HALTS.includes(halt)) return { reading: "after-halt", atCap: "after-halt", resetOnHaltEnd: true, told: "waits-for-model-work" };
  return { reading: "now", atCap: "after-halt", resetOnHaltEnd: true, told: "read-during-pause" };
}

const HALT_CELLS = HALT_KINDS.flatMap((halt) => VISION_STATES.flatMap((visionWritten) => INBOUND_KINDS.map((kind) => [halt, visionWritten, kind] as const)));

describe("the inbound-message decision, cell by cell", () => {
  test("its states are every lifecycle, the active one at work and under each halt kind", () => {
    expect(["active", ...CLOSED_LIFECYCLES].sort()).toEqual([...PROJECT_LIFECYCLES].sort());
  });

  test.each(INBOUND_KINDS)("at work, a %s is read now, and one at its cap is read to halt the project", (kind) => {
    expect(inboundDecision({ lifecycle: "active", halt: null, visionWritten: true }, kind)).toEqual({
      reading: "now",
      atCap: "now",
      resetOnHaltEnd: false,
      told: kind === "stop" ? "stop" : "read-at-work",
    });
  });

  test.each(INBOUND_KINDS)("at work before the first vision, a %s is read now unless it is a change, which waits for the tender", (kind) => {
    expect(inboundDecision({ lifecycle: "active", halt: null, visionWritten: false }, kind)).toEqual(
      kind === "change"
        ? { reading: "after-tender", atCap: "after-tender", resetOnHaltEnd: false, told: "waits-for-tender" }
        : { reading: "now", atCap: "now", resetOnHaltEnd: false, told: kind === "stop" ? "stop" : "read-at-work" },
    );
  });

  test.each(HALT_CELLS)("under a %s halt, the vision written %s, a %s is decided as the halt's group decides", (halt, visionWritten, kind) => {
    expect(inboundDecision({ lifecycle: "active", halt, visionWritten }, kind)).toEqual(expectedUnderHalt(halt, kind, visionWritten));
  });

  test.each(CLOSED_LIFECYCLES.flatMap((lifecycle) => INBOUND_KINDS.map((kind) => [lifecycle, kind] as const)))(
    "%s, a %s is recorded and never read, a stop excepted",
    (lifecycle, kind) => {
      expect(inboundDecision({ lifecycle }, kind)).toEqual(
        kind === "stop"
          ? { reading: "now", atCap: "now", resetOnHaltEnd: false, told: "stop" }
          : { reading: "never", atCap: "never", resetOnHaltEnd: false, told: "closed" },
      );
    },
  );

  test("no cell reads a message at its cap where it does not read it, and only a halt's cell resets a count", () => {
    const states: InboundState[] = [
      ...VISION_STATES.map((visionWritten): InboundState => ({ lifecycle: "active", halt: null, visionWritten })),
      ...HALT_KINDS.flatMap((halt) => VISION_STATES.map((visionWritten): InboundState => ({ lifecycle: "active", halt, visionWritten }))),
      ...CLOSED_LIFECYCLES.map((lifecycle): InboundState => ({ lifecycle })),
    ];
    for (const state of states) {
      for (const kind of INBOUND_KINDS) {
        const decision = inboundDecision(state, kind);
        if (decision.reading !== "now") expect({ state, kind, atCap: decision.atCap }).toEqual({ state, kind, atCap: decision.reading });
        if (state.lifecycle !== "active" || state.halt === null) expect(decision.resetOnHaltEnd).toBe(false);
      }
    }
  });
});
