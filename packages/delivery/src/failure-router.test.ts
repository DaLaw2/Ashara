import { describe, test, expect } from "vitest";
import type { FailureVerdict } from "./acl/quality-acl.js";
import { FailureRouter } from "./failure-router.js";
import type { FailureRouteInput } from "./failure-router.js";

const WORK: FailureVerdict = { kind: "retryable", ground: "work" };

function makeInput(overrides: Partial<FailureRouteInput> = {}): FailureRouteInput {
  return {
    item: { id: "task-1" },
    failure: { detail: "something failed", raw: {} },
    priorAttempts: 1,
    verdict: WORK,
    ...overrides,
  };
}

describe("FailureRouter", () => {
  test("a retryable failure replans under the bound, carrying the failure forward, and abandons at it", () => {
    const failure = { detail: "check exited 1", raw: {} };
    const router = new FailureRouter(2);
    expect(router.route(makeInput({ priorAttempts: 1, failure }))).toEqual({ action: "replan", attempt: 2, failure });
    expect(router.route(makeInput({ priorAttempts: 2 }))).toMatchObject({ action: "abandon", attempts: 2 });
  });

  // Lessons digest P6: abandoning on the first tree regression gave up work that may have been
  // correct and left the broken merged tree with no repair path.
  test("a tree regression is retried on the merged tree, and its abandon at the bound names it", () => {
    const verdict: FailureVerdict = { kind: "retryable", ground: "tree-regression" };
    expect(new FailureRouter(2).route(makeInput({ priorAttempts: 1, verdict })).action).toBe("replan");
    const atBound = new FailureRouter(2).route(makeInput({ priorAttempts: 2, verdict }));
    if (atBound.action !== "abandon") throw new Error("expected an abandon at the bound");
    expect(atBound.reason).toContain("tree regression");
  });

  test("a merge conflict replans under the bound and abandons at it, for plan repair", () => {
    const verdict: FailureVerdict = { kind: "retryable", ground: "merge-conflict" };
    const router = new FailureRouter(3);
    expect(router.route(makeInput({ priorAttempts: 1, verdict }))).toMatchObject({ action: "replan", attempt: 2 });
    const atBound = router.route(makeInput({ priorAttempts: 3, verdict }));
    if (atBound.action !== "abandon") throw new Error("expected an abandon at the bound");
    expect(atBound.reason).toContain("conflicts with main");
  });

  test("a non-retryable verdict is abandoned at once and consumes no retry, whatever budget remains", () => {
    const verdict: FailureVerdict = { kind: "non-retryable", ground: "conflict-markers-left" };
    const decision = new FailureRouter(3).route(makeInput({ priorAttempts: 1, verdict }));
    expect(decision).toMatchObject({ action: "abandon", attempts: 1 });
    if (decision.action === "abandon") expect(decision.reason).toContain("left conflict markers");
  });
});
