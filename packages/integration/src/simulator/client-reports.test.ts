import { describe, expect, it } from "vitest";
import { recordedKind } from "@ashara/engagement";
import { checkReports } from "./client-reports.js";
import type { ReportRecords } from "./client-reports.js";

const noRecords: ReportRecords = { reports: [], episodes: [], repairs: [], sweeps: [], revisionReports: [], reviewSpec: null, checkAuthors: [] };

function haltWith(kind: string, errorClass: string | null, reason: string | null, body: string): ReportRecords {
  return {
    ...noRecords,
    reports: [{ id: "r1", body, reportsOn: null, inReplyTo: null }],
    episodes: [{ id: "e1", kind, errorClass, reason, reportId: "r1", resumedReportId: null, ended: false }],
  };
}

const keysOf = (records: ReportRecords, status: string, items: Parameters<typeof checkReports>[2] = []): string[] =>
  checkReports(records, { status }, items, new Set()).map((each) => each.key);

const stated = (sentence: string, record: string): string =>
  `Work on this project is paused.\n\nAshara recorded the cause as this: ${sentence}. Ashara keeps the technical detail in its own record of this pause, record ${record}.`;

describe("checkReports, a halt's cause", () => {
  it("holds a report to its episode's recorded kind and its episode's record", () => {
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(recordedKind("fault"), "e1")), "blocked")).toEqual([]);
    // Another kind's sentence, or another record's id, is not the cause on record.
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(recordedKind("infrastructure"), "e1")), "blocked")).toEqual(["halt-cause:fault"]);
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(recordedKind("fault"), "e2")), "blocked")).toEqual(["halt-cause:fault"]);
  });

  it("holds a halt with no cause recorded to saying so, and one with a cause to not saying so", () => {
    expect(keysOf(haltWith("budget_cap", null, null, "Work on this project is paused.\n\nNo cause was recorded for this pause."), "blocked")).toEqual([]);
    expect(keysOf(haltWith("budget_cap", "BudgetExceeded", null, "Work on this project is paused.\n\nNo cause was recorded for this pause."), "blocked")).toEqual(["halt-cause:budget_cap"]);
  });

  it("names a given-up task whose stored reason does not parse instead of judging its line on the title alone", () => {
    const repairing = (blockedReason: unknown): ReportRecords => ({
      ...haltWith("plan_repair", null, null, `Work on this project is paused.\n\n- "Goal": given up.`),
      repairs: [{ episodeId: "e1", title: "Goal", attempts: 3, blockedReason }],
    });
    expect(keysOf(repairing(null), "blocked")).toEqual([]);
    expect(keysOf(repairing({ source: "no-such-source" }), "blocked")).toEqual(["halt-cause-corrupt:plan_repair"]);
  });

  it("names a halt of a kind no code path writes since migration 048", () => {
    expect(keysOf(haltWith("check_dispute", "X", "y", "Work on this project is paused."), "blocked")).toEqual(["halt-kind-retired:check_dispute"]);
  });
});

describe("checkReports, a delivered report", () => {
  const goal = { id: "t1", title: "Goal", status: "Completed", level: "Task", workKind: null, origin: "decomposition", mergeCommit: "c1", mergeKind: null };
  const delivered = (line: string, extra: Partial<ReportRecords> = {}, tail = ""): ReportRecords => ({
    ...noRecords,
    reports: [{ id: "r1", body: `Your project is delivered.\n\nWhat was delivered:\n${line}${tail}`, reportsOn: null, inReplyTo: null }],
    sweeps: [{ id: "s1", passed: true, uncheckedTasks: [], reportId: "r1" }],
    ...extra,
  });
  const unrecordedTail = "\n\nWhich parts of what you asked for the checks cover is not on record for this plan, so none of it is stated as checked.";

  it("refuses a merged line for a close whose kind is not on record", () => {
    expect(keysOf(delivered(`- "Goal": built and merged, commit c1.`, {}, unrecordedTail), "accepted", [goal])).toEqual(["delivered-close"]);
    expect(keysOf(delivered(`- "Goal": closed on commit c1; whether it was merged or already delivered there is not on record.`, {}, unrecordedTail), "accepted", [goal])).toEqual([]);
  });

  it("refuses the unrecorded-kind line for a close recorded as already delivered", () => {
    const already = { ...goal, mergeKind: "already_delivered" };
    expect(keysOf(delivered(`- "Goal": closed on commit c1; whether it was merged or already delivered there is not on record.`, {}, unrecordedTail), "accepted", [already])).toEqual(["delivered-close"]);
  });

  // W11c D3: coverage comes from the acceptance trace; an out-of-scope line or an internal-design
  // assumption is never listed as not covered, and every uncited asked-for item is.
  describe("coverage from the acceptance trace", () => {
    const merged = `- "Goal": built and merged, commit c1.`;
    const mergedGoal = { ...goal, mergeKind: "merged" };
    const sources = [
      { type: "scope", id: "S1", text: "The product greets.", side: "in" },
      { type: "scope", id: "S2", text: "Any network service.", side: "out" },
      { type: "assumption", id: "A1", text: "Messages are in English.", status: "Inferred", standing: "not-shown", kind: "client-visible" },
      { type: "assumption", id: "A2", text: "State lives in memory.", status: "Inferred", standing: "not-shown", kind: "internal-design" },
    ];
    const traced = {
      reviewSpec: { origin: "review", sources },
      checkAuthors: [{ id: "c1", taskSpec: { origin: "check", sources: [sources[0]], acceptance: [{ line: "A user is greeted.", sources: ["S1"] }] } }],
    };
    const section = (lines: readonly string[]): string =>
      `\n\nThese items of what you asked for are named by no acceptance criterion of a task whose stored checks passed on main, so nothing confirms them either way:\n${lines.join("\n")}`;

    it("accepts exactly the uncited asked-for items", () => {
      expect(keysOf(delivered(merged, traced, section(["- Ashara's assumption, which was never shown to you: Messages are in English."])), "accepted", [mergedGoal])).toEqual([]);
    });

    it("refuses an out-of-scope line or an internal-design assumption listed as not covered", () => {
      const listed = ["- Ashara's assumption, which was never shown to you: Messages are in English.", "- Any network service."];
      expect(keysOf(delivered(merged, traced, section(listed)), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
      const internal = ["- Ashara's assumption, which was never shown to you: Messages are in English.", "- Ashara's assumption, which was never shown to you: State lives in memory."];
      expect(keysOf(delivered(merged, traced, section(internal)), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });

    it("refuses a report that leaves an uncited asked-for item out, or claims coverage the trace does not hold", () => {
      // Each names the item left out and the count that differs.
      const allCovered = "\n\nEvery item of what you asked for is named by an acceptance criterion of a task whose stored checks passed on main.";
      expect(keysOf(delivered(merged, traced, allCovered), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
      expect(keysOf(delivered(merged, traced, unrecordedTail), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });

    it("holds a report to saying coverage is not on record when a swept check task records no trace", () => {
      const untraced = { ...traced, checkAuthors: [{ id: "c1", taskSpec: { origin: "check" } }] };
      expect(keysOf(delivered(merged, untraced, unrecordedTail), "accepted", [mergedGoal])).toEqual([]);
      expect(keysOf(delivered(merged, untraced, section(["- Messages are in English."])), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });
  });
});
