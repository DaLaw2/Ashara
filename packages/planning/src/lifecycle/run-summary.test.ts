import { describe, expect, test } from "vitest";
import { RUN_SCOPE_PRE_SCOPING, RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { AcceptanceVerdict } from "../acceptance.js";
import type { TerminationPlanExhausted, TerminationStop } from "../termination.js";
import { buildRunSummary } from "./run-summary.js";
import type { RunSummaryItem } from "./run-summary.js";

// ---------------------------------------------------------------------------
// The one line an owner reads. Run 39's said "vision acceptance check confirmed
// all requirements are met" in the same sentence as the requirements it had not
// met, so the tests here are about the STRING, not the enum.
// ---------------------------------------------------------------------------

const THIS_RUN = "run-42";

const PLAN_EXHAUSTED: TerminationPlanExhausted = {
  decision: "plan_exhausted",
  trigger: "completeness",
  counts: {
    total: 10, pending: 0, inProgress: 0, completed: 3, blocked: 0,
    failed: 0, abandoned: 2, nonTerminal: 5, dispatchable: 0, inFlight: 0,
  },
  stalled: [],
};

const COMPLETENESS_STOP: TerminationStop = {
  decision: "stop",
  reason: "completeness",
  counts: {
    total: 4, pending: 0, inProgress: 0, completed: 4, blocked: 0,
    failed: 0, abandoned: 0, nonTerminal: 0, dispatchable: 0, inFlight: 0,
  },
  stalled: [],
  abandonedRoots: [],
};

function item(overrides: Partial<RunSummaryItem> & { id: string }): RunSummaryItem {
  return {
    parentId: undefined,
    status: "Completed",
    level: "Task",
    resolution: "met",
    blockedBy: [],
    title: `Item ${overrides.id}`,
    runScope: THIS_RUN,
    ...overrides,
  };
}

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

    const { narrative, stopReason } = buildRunSummary({ items: [], currentRunScope: THIS_RUN, acceptance }, PLAN_EXHAUSTED);

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

    const { narrative } = buildRunSummary({ items: [], currentRunScope: THIS_RUN, acceptance }, PLAN_EXHAUSTED);

    expect(narrative).toContain("Acceptance found 1 unmet vision requirement(s)");
    expect(narrative).toContain("Implement 'jot search'");
  });

  test("an accepted verdict still reads as accepted", () => {
    const acceptance: AcceptanceVerdict = { outcome: "accepted", gaps: [], attempt: 1, maxAttempts: 2 };

    const { stopReason, narrative } = buildRunSummary({ items: [], currentRunScope: THIS_RUN, acceptance }, PLAN_EXHAUSTED);

    expect(stopReason).toBe("accepted");
    expect(narrative).toContain("confirmed all requirements are met");
  });
});

// ---------------------------------------------------------------------------
// Run-scoped counts — the Run 42 regression: the terminal summary reported
// "4 item(s) shipped" when the run shipped 1 and the other 3 were left on
// the board by Runs 39-41. The narrative must attribute counts to THIS run
// and report out-of-scope items separately.
// ---------------------------------------------------------------------------

describe("run-scoped narrative counts", () => {
  test("counts only this run's completed items as shipped", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Completed" }),
      item({ id: "b", runScope: "run-39", status: "Completed" }),
      item({ id: "c", runScope: "run-40", status: "Completed" }),
      item({ id: "d", runScope: "run-41", status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 4, completed: 4 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    // The Run 42 regression: "4 item(s) shipped" was true of the board, false
    // of the run. The narrative must say "This run shipped 1" not "4".
    expect(narrative).toContain("This run shipped 1 item(s).");
    expect(narrative).not.toContain("shipped 4");
  });

  test("a run that shipped zero says so explicitly — it does not vanish into silence", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: "run-39", status: "Completed" }),
      item({ id: "b", runScope: "run-40", status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 2, completed: 2 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("This run shipped 0 item(s).");
  });

  test("out-of-scope items are reported, not silently dropped", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Completed" }),
      item({ id: "b", runScope: RUN_SCOPE_PRE_SCOPING, status: "Completed" }),
      item({ id: "c", runScope: RUN_SCOPE_PRE_SCOPING, status: "Completed" }),
      item({ id: "d", runScope: RUN_SCOPE_PRE_SCOPING, status: "Abandoned" }),
      item({ id: "e", runScope: RUN_SCOPE_AD_HOC, status: "Pending" }),
      item({ id: "f", runScope: RUN_SCOPE_AD_HOC, status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 6, completed: 4, nonTerminal: 1 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("This run shipped 1 item(s).");
    expect(narrative).toContain("5 item(s) on the board were created outside this run");
    expect(narrative).toContain("3 pre-scoping");
    expect(narrative).toContain("2 ad-hoc");
  });

  test("items from other runs are counted separately from pre-scoping and ad-hoc", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Completed" }),
      item({ id: "b", runScope: RUN_SCOPE_PRE_SCOPING, status: "Completed" }),
      item({ id: "c", runScope: RUN_SCOPE_AD_HOC, status: "Completed" }),
      item({ id: "d", runScope: "run-39", status: "Completed" }),
      item({ id: "e", runScope: "run-41", status: "Abandoned" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 5, completed: 4, abandoned: 1, nonTerminal: 0 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("4 item(s) on the board were created outside this run");
    expect(narrative).toContain("1 pre-scoping");
    expect(narrative).toContain("1 ad-hoc");
    expect(narrative).toContain("2 from other runs");
  });

  test("no out-of-scope note when all items belong to this run", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Completed" }),
      item({ id: "b", runScope: THIS_RUN, status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 2, completed: 2 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("This run shipped 2 item(s).");
    expect(narrative).not.toContain("outside this run");
  });

  test("run-scoped abandoned items report their kinds", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Abandoned", blockedReason: { source: "failure_router", reason: "retries exhausted" } }),
      item({ id: "b", runScope: THIS_RUN, status: "Abandoned", blockedReason: { source: "failure_router", reason: "duplicate", substitutedBy: "c" } }),
      item({ id: "c", runScope: THIS_RUN, status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 3, completed: 1, abandoned: 2 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("This run abandoned 2 item(s)");
    expect(narrative).toContain("1 exhausted");
    expect(narrative).toContain("1 substituted");
  });

  test("failure_router abandoned item carries attempts and lastFailure through the typed seam", () => {
    const items: RunSummaryItem[] = [
      item({
        id: "f1",
        runScope: THIS_RUN,
        status: "Abandoned",
        blockedReason: {
          source: "failure_router",
          reason: "retries exhausted",
          attempts: 3,
          lastFailure: { detail: "gate check timed out" },
        },
      }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 1, completed: 0, abandoned: 1 },
    };

    const { abandoned } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].kind).toBe("exhausted-abandon");
    expect(abandoned[0].attempts).toBe(3);
    expect(abandoned[0].lastFailureDetail).toBe("gate check timed out");
    expect(abandoned[0].reason).toContain("3 attempt(s)");
  });

  test("task_failed variant without attempts classifies correctly — absence is represented", () => {
    const items: RunSummaryItem[] = [
      item({
        id: "tf1",
        runScope: THIS_RUN,
        status: "Abandoned",
        blockedReason: {
          source: "task_failed",
          reason: "compilation error in generated code",
        },
      }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 1, completed: 0, abandoned: 1 },
    };

    const { abandoned } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].kind).toBe("exhausted-abandon");
    expect(abandoned[0].attempts).toBeUndefined();
    expect(abandoned[0].reason).toContain("compilation error");
  });

  test("abandoned item with no blockedReason gets unspecified-abandon", () => {
    const items: RunSummaryItem[] = [
      item({ id: "no-br", runScope: THIS_RUN, status: "Abandoned" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 1, completed: 0, abandoned: 1 },
    };

    const { abandoned } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].kind).toBe("unspecified-abandon");
    expect(abandoned[0].reason).toContain("no recorded reason");
  });

  test("board-wide counts use 'board total' to prevent confusion with run-scoped counts", () => {
    const items: RunSummaryItem[] = [
      item({ id: "a", runScope: THIS_RUN, status: "Completed" }),
    ];

    const decision: TerminationStop = {
      ...COMPLETENESS_STOP,
      counts: { ...COMPLETENESS_STOP.counts, total: 5, nonTerminal: 2 },
    };

    const { narrative } = buildRunSummary(
      { items, currentRunScope: THIS_RUN },
      decision,
    );

    expect(narrative).toContain("board total=5");
    expect(narrative).toContain("nonTerminal=2");
  });
});
