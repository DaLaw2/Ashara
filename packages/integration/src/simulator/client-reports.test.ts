import { describe, expect, it } from "vitest";
import { checkReports } from "./client-reports.js";
import type { ReportRecords } from "./client-reports.js";

const noRecords: ReportRecords = { reports: [], episodes: [], repairs: [], sweeps: [], revisionReports: [], reviewSpec: null, checkAuthors: [] };

function haltWith(kind: string, errorClass: string | null, reason: string | null, body: string): ReportRecords {
  return {
    ...noRecords,
    reports: [{ id: "r1", body, reportsOn: null, inReplyTo: null }],
    episodes: [{ id: "e1", kind, errorClass, reason, spend: null, reportId: "r1", resumedReportId: null, ended: false }],
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

  it("names whose spending limit stopped a budget_cap halt from its recorded error class alone, and states its recorded amounts", () => {
    const unrecorded = "How much had been spent and set aside against that limit when it stopped the work is not on record.";
    const project = `the spending limit set for this project left no room for the next step of the work, so that step was not paid for. ${unrecorded}`;
    const unknown =
      `a spending limit set for this work left no room for the next step of the work, so that step was not paid for; which limit it was is not on record. ${unrecorded}`;
    expect(keysOf(haltWith("budget_cap", "BudgetExceeded", "over", stated(project.slice(0, -1), "e1")), "blocked")).toEqual([]);
    expect(keysOf(haltWith("budget_cap", "SomethingElse", "over", stated(project.slice(0, -1), "e1")), "blocked")).toEqual(["halt-cause:budget_cap"]);
    expect(keysOf(haltWith("budget_cap", "SomethingElse", "over", stated(unknown.slice(0, -1), "e1")), "blocked")).toEqual([]);
    // The amounts on record, not a limit reached.
    const spend = { capUsd: 1, spentUsd: 0.412203, inFlightUsd: 0.29854, nextCallUsd: 0.304642 };
    const amounts =
      "When it stopped the work, $0.412203 had been spent and $0.298540 was set aside for work under way, and the next step needed up to " +
      "$0.304642 set aside, more than the limit had room for; the limit is $1.000000";
    const withSpend = (sentence: string): ReportRecords => {
      const records = haltWith("budget_cap", "BudgetExceeded", "over", stated(sentence, "e1"));
      return { ...records, episodes: records.episodes.map((episode) => ({ ...episode, spend })) };
    };
    const projectWords = "the spending limit set for this project left no room for the next step of the work, so that step was not paid for";
    expect(keysOf(withSpend(`${projectWords}. ${amounts}`), "blocked")).toEqual([]);
    expect(keysOf(withSpend(`${projectWords}. ${unrecorded.slice(0, -1)}`), "blocked")).toEqual(["halt-cause:budget_cap"]);
  });

  it("holds a halt with no cause recorded to saying so, and one with a cause to not saying so", () => {
    expect(keysOf(haltWith("budget_cap", null, null, "Work on this project is paused.\n\nNo cause was recorded for this pause."), "blocked")).toEqual([]);
    expect(keysOf(haltWith("budget_cap", "BudgetExceeded", null, "Work on this project is paused.\n\nNo cause was recorded for this pause."), "blocked")).toEqual(["halt-cause:budget_cap"]);
  });

  it("names a given-up task whose stored reason does not parse, or is absent, instead of judging its line on the title alone", () => {
    const repairing = (blockedReason: unknown): ReportRecords => ({
      ...haltWith("plan_repair", null, null, `Work on this project is paused.\n\n- "Goal": given up.`),
      repairs: [{ episodeId: "e1", workItemId: "w1", title: "Goal", attempts: 3, blockedReason }],
    });
    expect(keysOf(repairing(null), "blocked")).toEqual(["halt-cause-corrupt:plan_repair"]);
    expect(keysOf(repairing({ source: "no-such-source" }), "blocked")).toEqual(["halt-cause-corrupt:plan_repair"]);
  });

  it("holds a given-up task's line to its recorded category and record, never the stored text", () => {
    const told = (line: string): ReportRecords => ({
      ...haltWith("plan_repair", null, null, `Work on this project has stopped.\n\n${line}`),
      repairs: [{ episodeId: "e1", workItemId: "w1", title: "Goal", attempts: 3, blockedReason: { source: "task_failed", reason: "task_failed" } }],
    });
    const category =
      `- "Goal", after 3 attempts counted against it. Ashara recorded why it was given up as this: its attempts at the work did not succeed. ` +
      `Ashara keeps the detail in its own record of that task, record w1.`;
    expect(keysOf(told(category), "blocked")).toEqual([]);
    expect(keysOf(told(`- "Goal", after 3 attempts. As recorded: task_failed`), "blocked")).toEqual(["halt-cause:plan_repair"]);
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
    sweeps: [{ id: "s1", passed: true, uncheckedTasks: [], reportId: "r1", reportFailures: 0 }],
    ...extra,
  });
  const unrecordedTail = "\n\nWhich parts of what you asked for the checks cover is not on record for this plan, so none of it is stated as checked.";

  it("refuses a merged line for a close whose kind is not on record", () => {
    expect(keysOf(delivered(`- "Goal": built and merged, commit c1.`, {}, unrecordedTail), "accepted", [goal])).toEqual(["delivered-close"]);
    expect(keysOf(delivered(`- "Goal": closed on commit c1; whether it was merged or already delivered there is not on record.`, {}, unrecordedTail), "accepted", [goal])).toEqual([]);
  });

  // A goal task a plan revision replaced while it was open is set aside, not given up.
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

  // A report whose records could not be read is replaced by an acceptance notice past its bound of attempts.
  it("holds an acceptance notice to the failed attempts recorded on the sweep", () => {
    const notice = (reportFailures: number): ReportRecords => ({
      ...noRecords,
      reports: [{ id: "r1", body: "Your project is accepted: its acceptance sweep passed on main. Its delivered report could not be written from Ashara's records in 5 attempts. Ashara keeps the error in its record of this delivery, acceptance sweep s1.", reportsOn: null, inReplyTo: null }],
      sweeps: [{ id: "s1", passed: true, uncheckedTasks: [], reportId: "r1", reportFailures }],
    });
    expect(keysOf(notice(4), "accepted", [goal])).toEqual([]);
    expect(keysOf(notice(1), "accepted", [goal])).toEqual(["delivered-notice-unfounded"]);
  });

  it("refuses the unrecorded-kind line for a close recorded as already delivered", () => {
    const already = { ...goal, mergeKind: "already_delivered" };
    expect(keysOf(delivered(`- "Goal": closed on commit c1; whether it was merged or already delivered there is not on record.`, {}, unrecordedTail), "accepted", [already])).toEqual(["delivered-close"]);
  });

  // Coverage comes from the acceptance trace; an out-of-scope line or an internal-design
  // assumption is never listed as not covered, and every uncited asked-for item is.
  describe("coverage from the acceptance trace", () => {
    const merged = `- "Goal": built and merged, commit c1.`;
    const mergedGoal = { ...goal, mergeKind: "merged" };
    const sources = [
      { type: "scope", id: "S1", text: "The product greets.", side: "in" },
      { type: "scope", id: "S2", text: "Any network service.", side: "out" },
      { type: "assumption", id: "A1", text: "Messages are in English.", status: "Inferred", standing: "unrecorded", kind: "client-visible" },
      { type: "assumption", id: "A2", text: "State lives in memory.", status: "Inferred", standing: "unrecorded", kind: "internal-design" },
    ];
    const traced = {
      reviewSpec: { origin: "review", sources },
      checkAuthors: [{ id: "c1", taskSpec: { origin: "check", sources: [sources[0]], acceptance: [{ line: "A user is greeted.", sources: ["S1"] }] } }],
    };
    const section = (lines: readonly string[]): string =>
      `\n\nThese items of what you asked for are named by no acceptance criterion of a task whose stored checks passed on main, so nothing confirms them either way:\n${lines.join("\n")}`;

    it("accepts exactly the uncited asked-for items", () => {
      expect(keysOf(delivered(merged, traced, section(["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English."])), "accepted", [mergedGoal])).toEqual([]);
    });

    it("refuses an out-of-scope line or an internal-design assumption listed as not covered", () => {
      const listed = ["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English.", "- Any network service."];
      expect(keysOf(delivered(merged, traced, section(listed)), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
      const internal = ["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English.", "- Ashara's assumption, which Ashara has no record of showing you: State lives in memory."];
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
