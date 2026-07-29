import { describe, expect, test } from "vitest";
import { evaluate } from "./termination.js";
import type { TerminationSnapshot, TerminationItemSnapshot } from "./termination.js";

function mkItem(overrides: Partial<TerminationItemSnapshot> & { id: string }): TerminationItemSnapshot {
  return {
    status: "Pending",
    level: "Task",
    resolution: "met",
    blockedBy: [],
    ...overrides,
  };
}

function mkSnapshot(overrides: Partial<TerminationSnapshot> = {}): TerminationSnapshot {
  return {
    items: [],
    budgetExhausted: false,
    openCoverageGaps: 0,
    ...overrides,
  };
}

describe("openCoverageGaps is required and gates completeness", () => {
  test("zero gaps allows completeness when all items are terminal", () => {
    const decision = evaluate(mkSnapshot({
      items: [mkItem({ id: "a", status: "Completed" })],
      openCoverageGaps: 0,
    }));
    expect(decision.decision).toBe("plan_exhausted");
    if (decision.decision === "plan_exhausted") {
      expect(decision.trigger).toBe("completeness");
    }
  });

  test("nonzero gaps block completeness even when all items are terminal", () => {
    const decision = evaluate(mkSnapshot({
      items: [mkItem({ id: "a", status: "Completed" })],
      openCoverageGaps: 3,
    }));
    // All items terminal + budget not exhausted + gaps open = continue
    // (no non-terminal items to trigger liveness, gaps prevent completeness)
    expect(decision.decision).toBe("continue");
  });

  test("nonzero gaps with budget exhaustion still stops on economy", () => {
    const decision = evaluate(mkSnapshot({
      items: [mkItem({ id: "a", status: "Pending" })],
      openCoverageGaps: 2,
      budgetExhausted: true,
    }));
    expect(decision.decision).toBe("stop");
    if (decision.decision === "stop") {
      expect(decision.reason).toBe("economy");
    }
  });
});

describe("resolution affects advanceability", () => {
  test("pending task with 'met' resolution is advanceable — loop continues", () => {
    const decision = evaluate(mkSnapshot({
      items: [
        mkItem({ id: "done", status: "Completed" }),
        mkItem({ id: "next", status: "Pending", resolution: "met" }),
      ],
    }));
    expect(decision.decision).toBe("continue");
  });

  test("pending task with 'waiting' resolution is not advanceable — liveness fires", () => {
    const decision = evaluate(mkSnapshot({
      items: [
        mkItem({ id: "done", status: "Completed" }),
        mkItem({ id: "stuck", status: "Pending", resolution: "waiting" }),
      ],
    }));
    expect(decision.decision).toBe("plan_exhausted");
    if (decision.decision === "plan_exhausted") {
      expect(decision.trigger).toBe("liveness");
    }
  });

  test("pending task with 'blocked' resolution is not advanceable — liveness fires", () => {
    const decision = evaluate(mkSnapshot({
      items: [
        mkItem({ id: "done", status: "Completed" }),
        mkItem({ id: "stuck", status: "Pending", resolution: "blocked", blockedBy: ["x"] }),
      ],
    }));
    expect(decision.decision).toBe("plan_exhausted");
    if (decision.decision === "plan_exhausted") {
      expect(decision.trigger).toBe("liveness");
    }
  });
});

describe("completeness requires all terminal AND zero gaps", () => {
  test("all terminal + zero gaps = completeness", () => {
    const decision = evaluate(mkSnapshot({
      items: [
        mkItem({ id: "a", status: "Completed" }),
        mkItem({ id: "b", status: "Abandoned" }),
      ],
      openCoverageGaps: 0,
    }));
    expect(decision.decision).toBe("plan_exhausted");
    if (decision.decision === "plan_exhausted") {
      expect(decision.trigger).toBe("completeness");
    }
  });

  test("empty plan does not trigger completeness", () => {
    const decision = evaluate(mkSnapshot({ items: [], openCoverageGaps: 0 }));
    expect(decision.decision).toBe("continue");
  });
});
