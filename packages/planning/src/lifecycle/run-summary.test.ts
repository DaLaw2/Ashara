import { describe, expect, test } from "vitest";

import type { AcceptanceVerdict } from "../acceptance.js";
import type { TerminationPlanExhausted } from "../termination.js";

import { buildRunSummary } from "./run-summary.js";

// ---------------------------------------------------------------------------
// The one line an owner reads. Run 39's said "vision acceptance check confirmed
// all requirements are met" in the same sentence as the requirements it had not
// met, so the tests here are about the STRING, not the enum.
// ---------------------------------------------------------------------------

const PLAN_EXHAUSTED: TerminationPlanExhausted = {
  decision: "plan_exhausted",
  trigger: "completeness",
  counts: {
    total: 10, pending: 0, inProgress: 0, completed: 3, blocked: 0,
    failed: 0, abandoned: 2, nonTerminal: 5, dispatchable: 0, inFlight: 0,
  },
  stalled: [],
};

const SEARCH_GAP = {
  ref: "jot-search",
  kind: "missing-feature" as const,
  expected: "Implement 'jot search'",
  observed: "not addressed",
};

describe("the owner-facing headline", () => {
  test("an unverified verdict never says the requirements were met", () => {
    const acceptance: AcceptanceVerdict = {
      outcome: "unverified",
      gaps: [SEARCH_GAP],
      attempt: 2,
      maxAttempts: 2,
      unverifiedReason: "attempts-exhausted: the acceptance check had already run 2 time(s) against a cap of 2",
    };

    const { narrative, stopReason } = buildRunSummary({ items: [], acceptance }, PLAN_EXHAUSTED);

    expect(stopReason).toBe("unverified");
    expect(narrative).not.toContain("confirmed all requirements are met");
    expect(narrative).toContain("Run stopped UNVERIFIED");
    expect(narrative).toContain("Cause: attempts-exhausted");
  });

  test("gaps the acceptance check found are named in the narrative, not only in the payload", () => {
    const acceptance: AcceptanceVerdict = {
      outcome: "unverified",
      gaps: [SEARCH_GAP],
      attempt: 2,
      maxAttempts: 2,
      unverifiedReason: "attempts-exhausted: nothing re-checked this termination",
    };

    const { narrative } = buildRunSummary({ items: [], acceptance }, PLAN_EXHAUSTED);

    expect(narrative).toContain("Acceptance found 1 unmet vision requirement(s)");
    expect(narrative).toContain("Implement 'jot search'");
  });

  test("an accepted verdict still reads as accepted", () => {
    const acceptance: AcceptanceVerdict = { outcome: "accepted", gaps: [], attempt: 1, maxAttempts: 2 };

    const { stopReason, narrative } = buildRunSummary({ items: [], acceptance }, PLAN_EXHAUSTED);

    expect(stopReason).toBe("accepted");
    expect(narrative).toContain("confirmed all requirements are met");
  });
});
