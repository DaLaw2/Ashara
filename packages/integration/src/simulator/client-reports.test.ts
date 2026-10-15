import { describe, expect, it } from "vitest";
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
  // The expected sentences are written here, not taken from Engagement (ADR-081): a test that asks
  // the composer what to expect pins whatever it says.
  const FAULT = "a step of Ashara's own work on this project failed, or Ashara's own record of the project did not hold together";
  const INFRASTRUCTURE = "the machines Ashara runs the work on kept failing while they ran this project's work";

  it("holds a report to its episode's recorded kind and its episode's record", () => {
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(FAULT, "e1")), "blocked")).toEqual([]);
    // Another kind's sentence, or another record's id, is not the cause on record.
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(INFRASTRUCTURE, "e1")), "blocked")).toEqual(["halt-cause:fault"]);
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(FAULT, "e2")), "blocked")).toEqual(["halt-cause:fault"]);
    // A sentence reworded by one word is not the oracle's own.
    expect(keysOf(haltWith("fault", "MergeFailed", "git exited 1", stated(FAULT.replace("failed", "stopped"), "e1")), "blocked")).toEqual(["halt-cause:fault"]);
  });

  it("names whose spending limit a budget_cap halt reached from its recorded error class alone", () => {
    const project = "the spending limit set for this project was reached, so the next step of the work was not paid for";
    const unknown = "a spending limit set for this work was reached, so the next step of the work was not paid for; which limit it was is not on record";
    expect(keysOf(haltWith("budget_cap", "BudgetExceeded", "over", stated(project, "e1")), "blocked")).toEqual([]);
    expect(keysOf(haltWith("budget_cap", "SomethingElse", "over", stated(project, "e1")), "blocked")).toEqual(["halt-cause:budget_cap"]);
    expect(keysOf(haltWith("budget_cap", "SomethingElse", "over", stated(unknown, "e1")), "blocked")).toEqual([]);
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
  const goal = { id: "t1", title: "Goal", status: "Completed", level: "Task", workKind: null, origin: "decomposition", mergeCommit: "c1", mergeKind: null, blockedReason: null };
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

  // w12b D4: a goal task a plan revision replaced while it was open was set aside, not given up.
  it("holds the given-up list to the goal tasks given up, never one a plan revision set aside", () => {
    const merged = { ...goal, mergeKind: "merged" };
    const close = `- "Goal": built and merged, commit c1.`;
    const abandoned = (title: string, blockedReason: unknown) => ({ ...goal, id: title, title, status: "Abandoned", mergeCommit: null, blockedReason });
    const gaveUp = abandoned("Hard", { source: "failure_given_up", reason: "exhausted 2 replan attempt(s) without success" });
    const setAside = abandoned("Old", { source: "superseded", planRevision: 2, requestedBy: null, reason: "replaced" });
    const givenUp = (titles: readonly string[]) => `\n\nThese tasks were given up, and the plan was revised around them:\n${titles.map((title) => `- "${title}"`).join("\n")}${unrecordedTail}`;
    expect(keysOf(delivered(close, {}, givenUp(["Hard"])), "accepted", [merged, gaveUp, setAside])).toEqual([]);
    expect(keysOf(delivered(close, {}, givenUp(["Hard", "Old"])), "accepted", [merged, gaveUp, setAside])).toEqual(["delivered-given-up"]);
    expect(keysOf(delivered(close, {}, givenUp(["Hard"])), "accepted", [merged, gaveUp, abandoned("Odd", { source: "no-such-source" })])).toEqual(["delivered-given-up-corrupt"]);
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
