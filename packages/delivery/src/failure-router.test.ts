import { describe, test, expect } from "vitest";
import type { FailureVerdict } from "./acl/quality-acl.js";
import { FailureRouter } from "./failure-router.js";

type FailureRouteInput = Parameters<FailureRouter["route"]>[0];

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

  // Abandoning on the first tree regression would give up work that may be correct and leave
  // the broken merged tree with no repair path.
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

  // The records that rejected a held set decide every later attempt the same way.
  test("a check set given up at the held-set rule's bound is abandoned at once, saying why", () => {
    const verdict: FailureVerdict = { kind: "non-retryable", ground: "held-set-given-up" };
    const decision = new FailureRouter(3).route(makeInput({ priorAttempts: 1, verdict }));
    expect(decision).toMatchObject({ action: "abandon", attempts: 1 });
    if (decision.action === "abandon") expect(decision.reason).toContain("rejected for the same reason and items");
  });
});
