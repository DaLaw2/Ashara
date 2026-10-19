import { describe, expect, it } from "vitest";
import { checkReports, unconfirmedAtPassedSweeps, uncheckedAtPassedSweeps } from "./client-reports.js";
import type { ReportRecords } from "./client-reports.js";

const noRecords: ReportRecords = {
  reports: [],
  episodes: [],
  burnWarnings: [],
  repairs: [],
  sweeps: [],
  revisionReports: [],
  tableSweeps: [],
  evidence: [],
  verdicts: [],
  visions: [],
  passedSweeps: [],
};

/** What a table says of a sweep with no vision before it, in the oracle's own words. */
const noContract = (sweepId: string): string => `\n\nNo contract is on record for this project at sweep ${sweepId}, so no guarantee is judged.`;

/** A halt's report on its episode e1, carrying the table of the episode's terminal sweep t1, which no vision precedes. */
function haltWith(kind: string, errorClass: string | null, reason: string | null, body: string): ReportRecords {
  return {
    ...noRecords,
    reports: [{ id: "r1", body: `${body}${noContract("t1")}`, reportsOn: null, inReplyTo: null }],
    episodes: [{ id: "e1", kind, errorClass, reason, spend: null, work: null, reportId: "r1", resumedReportId: null, ended: false }],
    tableSweeps: [{ id: "t1", blockId: "e1", stopId: null, mainCommit: null, visionAtSweep: null }],
  };
}

const keysOf = (records: ReportRecords, status: string, items: Parameters<typeof checkReports>[2] = []): string[] =>
  checkReports(records, { status }, items, new Set()).map((each) => each.key);

const stated = (sentence: string, record: string): string =>
  `Work on this project is paused.\n\nAshara recorded the cause as this: ${sentence}. Ashara keeps the technical detail in its own record of this pause, record ${record}.`;

describe("checkReports, a halt's cause", () => {
  // The expected sentences are written here, not taken from Engagement: a test that asks
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

  it("holds a work_budget halt's report to the budget, the requests drawn and the call sites its ledger recorded", () => {
    const work = { scope: "project", budgetRequests: 600, grantedRequests: 0, reserveRequests: 0, reserveProtected: false, spentRequests: 599, inFlightRequests: 1, bySite: [{ callSite: "agent", requests: 600 }] };
    const words = "the budget of model requests set for this project was used up, so the next step of the work was not sent";
    const figures =
      'When it stopped the work, 599 model requests had been sent and 1 more were under way, against a budget of 600 model requests. ' +
      'The requests drawn, by the step of the work that drew them: "agent" 600';
    const withWork = (sentence: string, recorded: unknown): ReportRecords => {
      const records = haltWith("work_budget", "WorkBudgetSpent", "spent", stated(sentence, "e1"));
      return { ...records, episodes: records.episodes.map((episode) => ({ ...episode, work: recorded })) };
    };
    expect(keysOf(withWork(`${words}. ${figures}`, work), "blocked")).toEqual([]);
    // Another call site's count is not the ledger on record.
    expect(keysOf(withWork(`${words}. ${figures.replace('"agent" 600', '"agent" 599')}`, work), "blocked")).toEqual(["halt-cause:work_budget"]);
    expect(keysOf(withWork(`${words}. ${figures}`, { scope: "project" }), "blocked")).toEqual(["halt-spend-corrupt:work_budget"]);
  });

  it("holds a work_budget halt that kept the verification reserve to saying so", () => {
    const work = { scope: "project", budgetRequests: 8, grantedRequests: 0, reserveRequests: 2, reserveProtected: true, spentRequests: 6, inFlightRequests: 0, bySite: [{ callSite: "agent-runner", requests: 6 }] };
    const kept =
      "the budget of model requests set for this project was used up except for the share set aside for checking and accepting the " +
      "finished work, which is kept for that, so the next step of the work, which was not that checking, was not sent";
    const figures =
      "When it stopped the work, 6 model requests had been sent and 0 more were under way, against a budget of 8 model requests. " +
      '2 model requests of the budget are set aside for checking and accepting the finished work. The requests drawn, by the step of the work that drew them: "agent-runner" 6.';
    const withWork = (sentence: string): ReportRecords => {
      const records = haltWith("work_budget", "WorkBudgetSpent", "spent", stated(sentence, "e1"));
      return { ...records, episodes: records.episodes.map((episode) => ({ ...episode, work })) };
    };
    expect(keysOf(withWork(`${kept}. ${figures.slice(0, -1)}`), "blocked")).toEqual([]);
    expect(keysOf(withWork(`the budget of model requests set for this project was used up, so the next step of the work was not sent. ${figures.slice(0, -1)}`), "blocked")).toEqual([
      "halt-cause:work_budget",
    ]);
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

  it("names a halt of a kind no code path writes", () => {
    expect(keysOf(haltWith("check_dispute", "X", "y", "Work on this project is paused."), "blocked")).toEqual(["halt-kind-retired:check_dispute"]);
  });
});

describe("checkReports, a delivered report", () => {
  const goal = { id: "t1", title: "Goal", status: "Completed", level: "Task", workKind: null, origin: "decomposition", mergeCommit: "c1", mergeKind: null, blockedReason: null };
  const delivered = (line: string, extra: Partial<ReportRecords> = {}, tail = ""): ReportRecords => ({
    ...noRecords,
    reports: [{ id: "r1", body: `Your project is delivered.\n\nWhat was delivered:\n${line}${tail}`, reportsOn: null, inReplyTo: null }],
    sweeps: [{ id: "s1", passed: true, uncheckedTasks: [], reportId: "r1", reportFailures: 0 }],
    tableSweeps: [{ id: "s1", blockId: null, stopId: null, mainCommit: "m1", visionAtSweep: null }],
    ...extra,
  });
  const unrecordedTail = noContract("s1");

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

  // Every guarantee in force once, with the verdict its sweep's evidence reads, stored beside the
  // report; the punch list first. The expected wording is the oracle's own.
  describe("the guarantee table", () => {
    const merged = `- "Goal": built and merged, commit c1.`;
    const mergedGoal = { ...goal, mergeKind: "merged" };
    const guarantees = [
      { id: "G1", statement: "A user is greeted.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["no greeting is printed"] },
      { id: "G2", statement: "Greetings survive a restart.", observable: { interface: ["I1"], observation: "stored-data" }, refutedBy: ["a greeting is gone"] },
      { id: "G3", statement: "Names are kept as given.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a name is changed"] },
    ];
    const vision = { version: 1, contractForm: "guarantees", guarantees, inferences: [], scopeBoundaries: [] };
    const ran = (outcome: string, cls = "implementer-visible") => [{ taskCheckId: "k1", outcome, class: cls }];
    const evidence = [
      { sweepId: "s1", guaranteeId: "G1", visionVersion: 1, checks: ran("passed"), reviewLowers: false },
      { sweepId: "s1", guaranteeId: "G2", visionVersion: 1, checks: ran("passed"), reviewLowers: false },
      { sweepId: "s1", guaranteeId: "G3", visionVersion: 1, checks: ran("passed"), reviewLowers: true },
    ];
    const row = (guaranteeId: string, verdict: string, reason: string | null) => ({ reportId: "r1", sweepId: "s1", visionVersion: 1, guaranteeId, verdict, reason, basis: "client-stated" });
    const verdicts = [row("G1", "pass", null), row("G2", "unjudged", "stored-data-unjudged"), row("G3", "unjudged", "lowered-by-review")];
    const punch = "\n\nThe punch list, what is not shown to hold, failures first:\n- G2: unjudged, why\n- G3: unjudged, why";
    const table = (lines: readonly string[]) => `\n\nEach guarantee of your contract (vision v1) is judged on main at commit m1, sweep s1. The rule.\n${lines.join("\n")}`;
    const LINES = ["- G1: A user is greeted. | verdict: pass | basis: b | evidence: e", "- G2: Greetings survive a restart. | verdict: unjudged, why | basis: b | evidence: e", "- G3: Names are kept as given. | verdict: unjudged, why | basis: b | evidence: e"];
    const judged = (tail: string, extra: Partial<ReportRecords> = {}): ReportRecords =>
      delivered(merged, { tableSweeps: [{ id: "s1", blockId: null, stopId: null, mainCommit: "m1", visionAtSweep: 1 }], visions: [vision], evidence, verdicts, ...extra }, tail);
    const keys = (records: ReportRecords): string[] => keysOf(records, "accepted", [mergedGoal]);

    it("accepts a table whose verdicts are those its sweep's evidence reads: a stored-data guarantee and one a review doubts never pass", () => {
      expect(keys(judged(`${punch}${table(LINES)}`))).toEqual([]);
    });

    it("refuses a table that drops or doubles a guarantee, or says a verdict its evidence does not read", () => {
      expect(keys(judged(`${punch}${table(LINES.slice(1))}`))).toEqual(["guarantee-table:delivered"]);
      expect(keys(judged(`${punch}${table([...LINES, LINES[0] ?? ""])}`))).toEqual(["guarantee-table:delivered"]);
      expect(keys(judged(`${punch}${table(LINES.map((line) => line.replace("verdict: unjudged, why", "verdict: pass")))}`))).toEqual(["guarantee-table:delivered", "guarantee-table:delivered"]);
      expect(keys(judged(table(LINES)))).toEqual(["guarantee-table:delivered"]);
      expect(keys(judged(`${punch.replace("\n- G3: unjudged, why", "")}${table(LINES)}`))).toEqual(["guarantee-table:delivered"]);
    });

    it("refuses stored verdicts that miss a guarantee, name another sweep, or pass one on evidence that never reads pass", () => {
      expect(keys(judged(`${punch}${table(LINES)}`, { verdicts: verdicts.slice(1) }))).toEqual(["guarantee-table:delivered"]);
      expect(keys(judged(`${punch}${table(LINES)}`, { verdicts: verdicts.map((each) => ({ ...each, sweepId: "s0" })) }))).toEqual(Array(3).fill("guarantee-table:delivered"));
      const reviewOnly = evidence.map((each) => (each.guaranteeId === "G1" ? { ...each, checks: ran("passed", "review-only") } : each));
      expect(keys(judged(`${punch}${table(LINES)}`, { evidence: reviewOnly }))).toEqual(["guarantee-table:delivered", "guarantee-table:delivered", "guarantee-table:delivered"]);
    });

    it("holds a sweep that ran on no commit to every guarantee unjudged, and a missing table or sweep to being named", () => {
      const off = (lines: readonly string[]) => `\n\nNo check could run on a commit of main for this report; why is in Ashara's record of that attempt, sweep s1.\n${lines.join("\n")}`;
      const unjudged = verdicts.map((each) => ({ ...each, verdict: "unjudged", reason: "no-sweep-on-commit" }));
      const offLines = LINES.map((line) => line.replace("verdict: pass", "verdict: unjudged, why"));
      const offPunch = "\n\nThe punch list, what is not shown to hold, failures first:\n- G1: unjudged, why\n- G2: unjudged, why\n- G3: unjudged, why";
      const offSweep = { tableSweeps: [{ id: "s1", blockId: null, stopId: null, mainCommit: null, visionAtSweep: 1 }] };
      expect(keys(judged(`${offPunch}${off(offLines)}`, { ...offSweep, verdicts: unjudged }))).toEqual([]);
      expect(keys(judged(`${offPunch}${off(offLines)}`, offSweep))).toEqual(Array(3).fill("guarantee-table:delivered"));
      expect(keys(judged(""))).toEqual(["guarantee-table:delivered"]);
      expect(keysOf({ ...haltWith("budget_cap", null, null, "Work on this project is paused.\n\nNo cause was recorded for this pause."), tableSweeps: [] }, "blocked")).toEqual(["guarantee-table:halt:budget_cap"]);
    });
  });
});

// No passed sweep leaves a guarantee of the version in force unchecked; a version written before
// guarantees reads each in-scope line and each assumption a client could observe as one.
describe("uncheckedAtPassedSweeps", () => {
  const visible = { key: "A1", statement: "Messages are in English.", kind: "client-visible" };
  const design = { key: "A2", statement: "State lives in memory.", kind: "internal-design" };
  const undecidedLegacy = { statement: "Empty names are refused." };
  const greets = { text: "The product greets.", side: "in" };
  const counts = { text: "The product counts words.", side: "in" };
  const network = { text: "Any network service.", side: "out" };
  type Cite = { readonly type: "scope" | "assumption"; readonly id: string; readonly text: string };
  const S1: Cite = { type: "scope", id: "S1", text: greets.text };
  const A1: Cite = { type: "assumption", id: "A1", text: visible.statement };
  const spec = (cites: readonly Cite[]) => ({
    origin: "check",
    // A plan made from a version written before guarantees cites a client-visible assumption as the guarantee of its key.
    sources: cites.map((cite) => (cite.type === "scope" ? { ...cite, side: "in" } : { id: cite.id, text: cite.text, type: "guarantee", observation: "unclassified", interface: [], refutedBy: [] })),
    acceptance: [{ line: "A user is greeted.", sources: cites.map((cite) => cite.id) }],
  });
  /**
   * One passed sweep whose one check task cites `cited` and whose one stored check decides `decided`;
   * its version is in the guarantees form when it holds guarantees, else written before guarantees were.
   */
  const sweep = (inferences: unknown, decided: readonly Cite[], scopeBoundaries: unknown = [greets, network], cited: readonly Cite[] = decided, guarantees: unknown = []) => ({
    id: "sweep-1",
    version: 2,
    inferences,
    scopeBoundaries,
    contractForm: Array.isArray(guarantees) && guarantees.length > 0 ? "guarantees" : "scope-lines",
    guarantees,
    storedChecks: decided.length === 0 ? [] : [{ checkTaskId: "c1", taskSpec: spec(cited), name: "greets", decides: decided.map((cite) => cite.id), taskId: "t1", revision: 1 }],
    reportBody: null,
    undecided: [],
    reportVerdicts: [],
  });
  const keysOf = (...sweeps: ReportRecords["passedSweeps"]) => uncheckedAtPassedSweeps({ passedSweeps: sweeps }).map((found) => found.key);

  it("passes when every in-scope line and every assumption not recorded as internal design is decided as the sweep's vision states it", () => {
    expect(keysOf(sweep([visible, design], [S1, A1]))).toEqual([]);
  });

  it("names a client-visible assumption no swept check decides, or decides only as an earlier vision stated it", () => {
    expect(keysOf(sweep([visible, design], [S1]))).toEqual(["A1"]);
    expect(keysOf(sweep([visible], [S1, { ...A1, text: "Messages are in French." }]))).toEqual(["A1"]);
  });

  // A line citing an item is no check of it; only a stored check's decides is.
  it("names an item its check task cites, on an acceptance line too, that no stored check decides", () => {
    expect(keysOf(sweep([visible], [S1], [greets, network], [S1, A1]))).toEqual(["A1"]);
  });

  it("names an in-scope line, or one of no recorded side, no swept check decides; never an out-of-scope one", () => {
    expect(keysOf(sweep([visible], [S1, A1], [greets, counts, network]))).toEqual(["S2"]);
    expect(keysOf(sweep([visible], [A1], ["The product greets."]))).toEqual(["S1"]);
  });

  it("names a guarantee no swept check decides as the sweep's vision states it", () => {
    const g1 = { id: "G1", statement: greets.text, observable: { interface: ["I1"], observation: "output" } };
    const g2 = { id: "G2", statement: counts.text, observable: { interface: ["I1"], observation: "output" } };
    const G1: Cite = { type: "scope", id: "G1", text: greets.text };
    expect(keysOf(sweep([visible], [G1, A1], [], [G1, A1], [g1]))).toEqual([]);
    expect(keysOf(sweep([visible], [G1, A1], [], [G1, A1], [g1, g2]))).toEqual(["G2"]);
    expect(keysOf(sweep([visible], [G1, A1], [], [G1, A1], [{ ...g1, statement: "The product greets twice." }]))).toEqual(["G1"]);
    expect(keysOf(sweep([visible], [A1], [], [A1], [{ id: "G1" }]))).toEqual(["vision-unreadable"]);
  });

  // An assumption underpins guarantees and is reported as an assumption; the checks of what it
  // underpins decide it, so a guarantees-form version never holds one to a check of its own.
  it("never holds an assumption of a guarantees-form version to a check, client-visible or not", () => {
    const g1 = { id: "G1", statement: greets.text, observable: { interface: ["I1"], observation: "output" } };
    const G1: Cite = { type: "scope", id: "G1", text: greets.text };
    expect(keysOf(sweep([visible, design, undecidedLegacy], [G1], [], [G1], [g1]))).toEqual([]);
    expect(keysOf(sweep([visible], [], [], [], [g1]))).toEqual(["G1"]);
  });

  it("holds an assumption of no recorded kind to a check, keyed by its place", () => {
    expect(keysOf(sweep([visible, undecidedLegacy], [S1, A1]))).toEqual(["A2"]);
  });

  it("judges every passed sweep against the vision current when it passed, naming each item once", () => {
    const reworded = { ...visible, statement: "Messages are in French." };
    expect(keysOf(sweep([visible], [S1, A1]), { ...sweep([reworded], [S1, A1]), id: "sweep-2" })).toEqual(["A1"]);
    expect(keysOf(sweep([visible], [S1]), { ...sweep([visible], [S1]), id: "sweep-2" })).toEqual(["A1"]);
  });

  // An item a suite review left undecided reaches I6 as held back, never as passing.
  it("names an item a review left undecided that the sweep's delivered report stores as pass", () => {
    const left = (verdict: string) => ({
      ...sweep([visible], [S1, A1]),
      reportBody: "Delivered.",
      undecided: [{ id: "S1", text: greets.text, reason: "unsettled" as const }],
      reportVerdicts: [{ guaranteeId: "S1", verdict }],
    });
    expect(keysOf(left("unjudged"))).toEqual([]);
    expect(keysOf(left("pass"))).toEqual(["undecided-passed:S1"]);
    expect(keysOf({ ...left("pass"), reportBody: null })).toEqual([]);
  });

  it("fails closed when the vision or the trace cannot be read", () => {
    expect(keysOf({ ...sweep([], []), version: null })).toEqual(["no-vision"]);
    expect(keysOf(sweep({ planning: "a map" }, []))).toEqual(["vision-unreadable"]);
    expect(keysOf(sweep([visible], [S1], [{ text: "" }]))).toEqual(["vision-unreadable"]);
    expect(keysOf({ ...sweep([visible], [S1, A1]), contractForm: "prose" })).toEqual(["vision-unreadable"]);
    const check = { checkTaskId: "c1", taskSpec: spec([S1]), name: "greets", decides: ["S1"], taskId: "t1", revision: 1 };
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, taskSpec: { origin: "check" } }] })).toEqual(["coverage-unreadable"]);
    // A check stored with no record of what it decides decides nothing on record.
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, decides: null }] })).toEqual(["coverage-unreadable"]);
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, decides: ["A1"] }] })).toEqual(["coverage-unreadable"]);
  });

  // An item reads as decided only on a
  // clean review a second opinion confirmed, judged from the stand-ins' answers, never from production's claim.
  describe("unconfirmedAtPassedSweeps", () => {
    const delivered = { ...sweep([visible], [S1, A1]), reportBody: "Delivered." };
    const review = (provider: string, problems: readonly unknown[] = [], checks: readonly string[] = ["t1@1"], blindSpots = false) => ({ reviewTaskId: "r1", checks, provider, blindSpots, problems });
    const unconfirmed = (reviews: ReadonlyArray<ReturnType<typeof review>>, ...sweeps: ReportRecords["passedSweeps"]) =>
      unconfirmedAtPassedSweeps({ passedSweeps: sweeps.length === 0 ? [delivered] : sweeps }, reviews).map((found) => found.key);

    it("names every item a delivered report calls decided on one family's clean review alone", () => {
      expect(unconfirmed([review("deepseek")])).toEqual(["S1", "A1"]);
      expect(unconfirmed([review("deepseek"), review("deepseek")])).toEqual(["S1", "A1"]);
    });

    it("passes an item another family's review of the same revision also found clean", () => {
      expect(unconfirmed([review("deepseek"), review("anthropic")])).toEqual([]);
    });

    it("passes an item a second opinion within the family, asked from what each check cannot observe, found clean", () => {
      expect(unconfirmed([review("deepseek"), review("deepseek", [], ["t1@1"], true)])).toEqual([]);
    });

    it("names an item the other family's review said something about, and only that one", () => {
      const doubt = { kind: "undecided-item", checkTasks: ["c1"], item: "A1", problem: "p", evidence: "e" };
      expect(unconfirmed([review("deepseek"), review("anthropic", [doubt])])).toEqual(["A1"]);
      const conflict = { kind: "contradiction", checkTasks: ["c1", "c2"], conflict: { first: { checkTask: "c1" }, second: { checkTask: "c2" } }, problem: "p", evidence: "e" };
      expect(unconfirmed([review("deepseek"), review("anthropic", [conflict])])).toEqual(["S1", "A1"]);
    });

    it("judges only the revision the sweep ran, and never an item reported unverified, a report not posted, or a suite no review read", () => {
      expect(unconfirmed([review("deepseek"), review("anthropic", [], ["t1@2"]), review("deepseek", [], ["t1@2"])])).toEqual(["S1", "A1"]);
      expect(unconfirmed([review("deepseek")], { ...delivered, undecided: [{ id: "S1", text: greets.text, reason: "clean-unconfirmed" }] })).toEqual(["A1"]);
      expect(unconfirmed([review("deepseek")], { ...delivered, reportBody: null })).toEqual([]);
      expect(unconfirmed([])).toEqual([]);
    });
  });
});

describe("checkReports, a burn warning", () => {
  // A warning states the figures it recorded, its zone held on them,
  // and each zone is told once per plan revision.
  const yellow = {
    planRevision: 1,
    zone: "yellow",
    drawnRequests: 230,
    budgetRequests: 600,
    reserveRequests: 150,
    upstreamRequests: 450,
    plannedTasks: 4,
    completedTasks: 1,
    reportId: "w1",
    operatorReport: null,
    ledgerRequests: 240,
  };
  const body =
    "This project has used more of its budget of model requests than its finished work accounts for.\n\n" +
    "So far 230 model requests have been sent, of the 450 model requests this project's work may use before it pauses. A further 150 model " +
    "requests of its budget are set aside for checking and accepting the finished work, and only that checking may use them. 1 of the 4 " +
    "building tasks of the current plan are finished.";
  const warned = (warnings: ReportRecords["burnWarnings"], text = body): ReportRecords => ({
    ...noRecords,
    reports: warnings.map((warning) => ({ id: warning.reportId, body: text, reportsOn: null, inReplyTo: null })),
    burnWarnings: warnings,
  });

  it("holds a warning to the figures and zone it recorded, and to its one report", () => {
    expect(keysOf(warned([yellow]), "active")).toEqual([]);
    expect(keysOf(warned([yellow], body.replace("230 model", "200 model")), "active")).toEqual(["burn-warning"]);
    expect(keysOf(warned([{ ...yellow, completedTasks: 2 }]), "active")).toEqual(["burn-warning-zone", "burn-warning"]);
    expect(keysOf(warned([{ ...yellow, ledgerRequests: 229 }]), "active")).toEqual(["burn-warning-figures"]);
    // A warning's report is on its record, so it is not an unrecorded report.
    expect(keysOf({ ...warned([yellow]), burnWarnings: [] }, "active")).toEqual(["unrecorded-report"]);
  });

  it("holds each zone to once per plan revision, never yellow after red, and red to the operator's report", () => {
    const operatorReport = "work_burn red: project p (plan revision 1) has drawn 400 of the 450 model requests its upstream work may draw (budget 600)";
    const red = { ...yellow, zone: "red", drawnRequests: 400, reportId: "w2", operatorReport, ledgerRequests: 400 };
    const redBody = body.replace("230 model", "400 model");
    const reports = [
      { id: "w2", body: redBody, reportsOn: null, inReplyTo: null },
      { id: "w3", body: redBody, reportsOn: null, inReplyTo: null },
    ];
    const records: ReportRecords = { ...noRecords, reports, burnWarnings: [red, { ...red, zone: "yellow", reportId: "w3", operatorReport: null }] };
    expect(keysOf(records, "active")).toEqual(["burn-warning-repeated"]);
    expect(keysOf({ ...noRecords, reports: reports.slice(0, 1), burnWarnings: [{ ...red, operatorReport: null }] }, "active")).toEqual(["burn-warning-operator"]);
  });
});
