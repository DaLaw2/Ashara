import { describe, expect, it } from "vitest";
import { emptyCoverage, modelPathOf, sample } from "./coverage.js";
import type { Snapshot } from "./invariants.js";

function snapshotWith(events: Snapshot["events"]): Snapshot {
  return {
    project: { status: "active", blockedCategory: null, blockedReason: null, planStopped: false, workspacePath: null, deliveredReported: false },
    items: [],
    episodes: [],
    checks: [],
    spendUsd: 0,
    unrecordedCalls: 0,
    events,
    main: [],
    reports: { reports: [], episodes: [], repairs: [], sweeps: [], revisionReports: [], reviewSpec: null, checkAuthors: [] },
    textFacts: {
      visions: [],
      briefs: [],
      questions: [],
      answerReplies: [],
      tenderReports: [],
      delivered: [],
      sweepReplies: [],
      reviewSpec: null,
      firstPlan: { report: null, items: [], revisions: [] },
    },
  };
}

describe("sample", () => {
  it("counts the transitions the events record, each item starting at Pending", () => {
    const coverage = emptyCoverage();
    sample(coverage, snapshotWith([
      { seq: 1, eventType: "work_item.created", workItemId: "a" },
      { seq: 2, eventType: "work_item.started", workItemId: "a" },
      { seq: 3, eventType: "work_item.completed", workItemId: "a" },
    ]), [], []);
    expect([...coverage.transitions].sort()).toEqual(["InProgress->Completed", "Pending->InProgress"]);
  });

  // The L2 review: an unknown event was collected, never reported, and its item's later "from" went wrong.
  it("refuses an event kind it does not model instead of skipping it", () => {
    const events = [{ seq: 1, eventType: "work_item.teleported", workItemId: "a" }];
    expect(() => sample(emptyCoverage(), snapshotWith(events), [], [])).toThrow(/work_item\.teleported .* not in EVENT_TARGET/);
  });
});

describe("modelPathOf", () => {
  const row = (callSite: string, finishReason: string | null, outcome: string | null, outputTokens: number | null, reasoningTokens: number | null) =>
    modelPathOf({ callSite, finishReason, outcome, outputTokens, reasoningTokens });

  it("names each misbehaviour by what the llm_calls row recorded, agent turn or structured call", () => {
    expect(row("agent-runner", "length", "ok", 16384, null)).toBe("turn:truncated");
    expect(row("agent-runner", "length", "ok", 16384, 16384)).toBe("turn:reasoning-exhausted");
    expect(row("agent-runner", "stop", "error", 0, null)).toBe("turn:empty");
    expect(row("decomposition", "length", "error", 8000, 0)).toBe("structured:truncated");
    expect(row("suite-review", "length", "error", 8000, 8000)).toBe("structured:reasoning-exhausted");
    expect(row("roster", "stop", "error", 0, null)).toBe("structured:empty");
    expect(row("decomposition", "stop", "error", 200, null)).toBe("structured:invalid");
  });

  it("names nothing for a call answered as asked", () => {
    expect(row("agent-runner", "tool-calls", "ok", 200, null)).toBeNull();
    expect(row("decomposition", "stop", "ok", 200, null)).toBeNull();
    // A turn that stopped with output but no tool call is a refusal or a plain stop, not one of these.
    expect(row("agent-runner", "stop", "ok", 200, null)).toBeNull();
  });
});
