import { describe, expect, it } from "vitest";
import { emptyCoverage, sample } from "./coverage.js";
import type { Snapshot } from "./invariants.js";

function snapshotWith(events: Snapshot["events"]): Snapshot {
  return {
    project: { status: "active", blockedCategory: null, blockedReason: null, planStopped: false, workspacePath: null },
    items: [],
    episodes: [],
    taskReports: [],
    checks: [],
    spendUsd: 0,
    unrecordedCalls: 0,
    events,
    main: [],
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
