import { describe, test, expect } from "vitest";
import { FailureRouter } from "./failure-router.js";
import type { FailureRouteInput } from "./failure-router.js";

function makeInput(overrides: Partial<FailureRouteInput> = {}): FailureRouteInput {
  return {
    item: { id: "task-1" },
    failure: { detail: "something failed", raw: {} },
    priorAttempts: 1,
    category: "VERIFICATION_GAP",
    ...overrides,
  };
}

describe("FailureRouter", () => {
  describe("TREE_REGRESSION — zero-replan bound", () => {
    test("terminates on first occurrence regardless of remaining replan budget", () => {
      const router = new FailureRouter(3);
      // priorAttempts=1, maxReplan=3 — normally this would replan
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "TREE_REGRESSION",
      }));
      expect(decision.action).toBe("abandon");
      expect(decision).toMatchObject({
        action: "abandon",
        attempts: 1,
      });
    });

    test("terminates even with zero prior attempts", () => {
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 0,
        category: "TREE_REGRESSION",
      }));
      // Must not replan — the tree is broken, not the task
      expect(decision.action).toBe("abandon");
    });

    test("abandon reason mentions tree regression", () => {
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "TREE_REGRESSION",
      }));
      expect(decision.action).toBe("abandon");
      if (decision.action === "abandon") {
        expect(decision.reason).toContain("tree regression");
      }
    });
  });

  describe("non-TREE_REGRESSION categories replan normally", () => {
    test("VERIFICATION_GAP replans when attempts remain", () => {
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "VERIFICATION_GAP",
      }));
      expect(decision.action).toBe("replan");
    });

    test("COMPILATION_ERROR replans when attempts remain", () => {
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "COMPILATION_ERROR",
      }));
      expect(decision.action).toBe("replan");
    });

    test("AGENT_STUCK replans when attempts remain", () => {
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "AGENT_STUCK",
      }));
      expect(decision.action).toBe("replan");
    });

    test("VERIFICATION_GAP (fail-closed default for unparseable envelopes) replans normally", () => {
      // When classifyFromRaw cannot parse the envelope, it returns VERIFICATION_GAP.
      // The router must replan normally for this category — not terminate early.
      const router = new FailureRouter(2);
      const decision = router.route(makeInput({
        priorAttempts: 1,
        category: "VERIFICATION_GAP",
      }));
      expect(decision.action).toBe("replan");
    });
  });
});
