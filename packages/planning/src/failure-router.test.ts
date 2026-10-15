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
  // Lessons digest P6: abandoning on the first tree regression gave up work that may have been
  // correct and left the broken merged tree with no repair path. The next attempt starts on main
  // merged into its branch, where it can attribute and repair the failure; the replan bound holds.
  describe("TREE_REGRESSION — repaired on the merged tree, bounded", () => {
    test("a first tree regression is replanned, carrying the failure forward", () => {
      const failure = { detail: "Post-merge verify failed: test exited 1", raw: {} };
      const decision = new FailureRouter(2).route(makeInput({ priorAttempts: 1, category: "TREE_REGRESSION", failure }));
      expect(decision).toEqual({ action: "replan", attempt: 2, failure });
    });

    test("at the replan bound it abandons, naming the tree regression", () => {
      const decision = new FailureRouter(2).route(makeInput({ priorAttempts: 2, category: "TREE_REGRESSION" }));
      expect(decision).toMatchObject({ action: "abandon", attempts: 2 });
      if (decision.action === "abandon") expect(decision.reason).toContain("tree regression");
    });

    test("a zero bound abandons the first tree regression", () => {
      expect(new FailureRouter(0).route(makeInput({ priorAttempts: 0, category: "TREE_REGRESSION" })).action).toBe("abandon");
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

  // w12b D2: a conflict was re-dispatched on an unchanged branch until the generic bound ran out.
  describe("merge conflicts have a route of their own", () => {
    test("MERGE_CONFLICT replans under the bound and abandons at it, for plan repair", () => {
      const router = new FailureRouter(3);
      expect(router.route(makeInput({ priorAttempts: 1, category: "MERGE_CONFLICT" }))).toMatchObject({ action: "replan", attempt: 2 });
      const atBound = router.route(makeInput({ priorAttempts: 3, category: "MERGE_CONFLICT" }));
      expect(atBound).toMatchObject({ action: "abandon", attempts: 3 });
      if (atBound.action === "abandon") expect(atBound.reason).toContain("conflicts with main");
    });

    test("MERGE_CONFLICT_PERSISTS abandons at once, whatever budget remains", () => {
      const router = new FailureRouter(3);
      const decision = router.route(makeInput({ priorAttempts: 1, category: "MERGE_CONFLICT_PERSISTS" }));
      expect(decision).toMatchObject({ action: "abandon", attempts: 1 });
      if (decision.action === "abandon") expect(decision.reason).toContain("the plan is repaired around it");
    });
  });
});
