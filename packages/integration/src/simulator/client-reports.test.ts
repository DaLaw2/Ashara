import { describe, expect, it } from "vitest";
import { checkReports, uncheckedAtPassedSweeps } from "./client-reports.js";
import type { ReportRecords } from "./client-reports.js";

const noRecords: ReportRecords = { reports: [], episodes: [], burnWarnings: [], repairs: [], sweeps: [], revisionReports: [], reviewSpec: null, goalChecks: [], goalUndecided: [], passedSweeps: [] };

function haltWith(kind: string, errorClass: string | null, reason: string | null, body: string): ReportRecords {
  return {
    ...noRecords,
    reports: [{ id: "r1", body, reportsOn: null, inReplyTo: null }],
    episodes: [{ id: "e1", kind, errorClass, reason, spend: null, work: null, reportId: "r1", resumedReportId: null, ended: false }],
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

  // Coverage comes from what the stored checks decide (ADR-083); an out-of-scope line or an
  // internal-design assumption is never listed as not covered, and every undecided asked-for item is.
  describe("coverage from the stored checks", () => {
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
      goalChecks: [{ checkTaskId: "c1", taskSpec: { origin: "check", sources: [sources[0], sources[2]], acceptance: [{ line: "A user is greeted.", sources: ["S1", "A1"] }] }, name: "greets", decides: ["S1"] }],
    };
    const unverified = (lines: readonly string[]): string =>
      `\n\nThese assumptions were recorded as how the team builds the product, not as behaviour you could observe, so no check decides them: they are not verified by Ashara.\n${lines.join("\n")}`;
    const section = (lines: readonly string[]): string =>
      `\n\nThese items of what you asked for are decided by no stored check of a task whose stored checks passed on main, so nothing confirms them either way:\n${lines.join("\n")}${unverified(["- A2: State lives in memory."])}`;

    // A1 is cited by an acceptance line, yet no stored check decides it: it is not covered.
    it("accepts exactly the undecided asked-for items", () => {
      expect(keysOf(delivered(merged, traced, section(["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English."])), "accepted", [mergedGoal])).toEqual([]);
    });

    it("refuses an out-of-scope line or an internal-design assumption listed as not covered", () => {
      const listed = ["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English.", "- Any network service."];
      expect(keysOf(delivered(merged, traced, section(listed)), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
      const internal = ["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English.", "- Ashara's assumption, which Ashara has no record of showing you: State lives in memory."];
      expect(keysOf(delivered(merged, traced, section(internal)), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });

    it("refuses a report that leaves an undecided asked-for item out, or claims coverage the checks do not hold", () => {
      // Each names the item left out and the count that differs.
      const allCovered = `\n\nEvery item of what you asked for is decided by a stored check of a task whose stored checks passed on main.${unverified(["- A2: State lives in memory."])}`;
      expect(keysOf(delivered(merged, traced, allCovered), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
      expect(keysOf(delivered(merged, traced, `${unrecordedTail}${unverified(["- A2: State lives in memory."])}`), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });

    // ADR-083: every internal-design assumption is named, by id and text, as not verified by Ashara.
    it("refuses a report that leaves an internal-design assumption out of what Ashara did not verify, or names another there", () => {
      const uncovered = ["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English."];
      const head = `\n\nThese items of what you asked for are decided by no stored check of a task whose stored checks passed on main, so nothing confirms them either way:\n${uncovered.join("\n")}`;
      expect(keysOf(delivered(merged, traced, head), "accepted", [mergedGoal])).toEqual(["delivered-coverage"]);
      expect(keysOf(delivered(merged, traced, `${head}${unverified(["- A2: State lives in memory.", "- A1: Messages are in English."])}`), "accepted", [mergedGoal])).toEqual(["delivered-coverage"]);
      const noDesign = { ...traced, reviewSpec: { origin: "review", sources: sources.slice(0, 3) } };
      expect(keysOf(delivered(merged, noDesign, `${head}${unverified(["- A2: State lives in memory."])}`), "accepted", [mergedGoal])).toEqual(["delivered-coverage"]);
    });

    // ADR-084 decision 2: an item a review left undecided is named as not verified, never covered.
    const undecidedHead = (lines: readonly string[]): string =>
      `\n\nThese items of what you asked for have a stored check that passed on main and is recorded as deciding them, but a review of the checks found that none of them really decides it, and no second review by another model family confirmed or settled that: they are not verified by Ashara.\n${lines.join("\n")}`;
    it("holds an item a review left undecided to being named as not verified, never counted covered", () => {
      const left = { ...traced, goalUndecided: [{ id: "S1", text: "The product greets." }] };
      const uncovered = section(["- Ashara's assumption, which Ashara has no record of showing you: Messages are in English."]);
      expect(keysOf(delivered(merged, left, `${uncovered}${undecidedHead(["- The product greets."])}`), "accepted", [mergedGoal])).toEqual([]);
      expect(keysOf(delivered(merged, left, uncovered), "accepted", [mergedGoal])).toEqual(["delivered-coverage"]);
      expect(keysOf(delivered(merged, traced, `${uncovered}${undecidedHead(["- The product greets."])}`), "accepted", [mergedGoal])).toEqual(["delivered-coverage"]);
    });

    it("holds a report to saying coverage is not on record when a swept check records no items it decides", () => {
      const [check] = traced.goalChecks;
      if (check === undefined) throw new Error("the fixture holds one stored check");
      const untraced = { ...traced, goalChecks: [{ ...check, decides: null }] };
      expect(keysOf(delivered(merged, untraced, unrecordedTail), "accepted", [mergedGoal])).toEqual([]);
      expect(keysOf(delivered(merged, untraced, section(["- Messages are in English."])), "accepted", [mergedGoal])).toEqual(["delivered-coverage", "delivered-coverage"]);
    });
  });
});

// The guard of d89 E and ADR-083: no passed sweep leaves an in-scope line, or an assumption a client
// could observe, unchecked.
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
    sources: cites.map((cite) => (cite.type === "scope" ? { ...cite, side: "in" } : { ...cite, status: "Inferred", standing: "reported", kind: "client-visible" })),
    acceptance: [{ line: "A user is greeted.", sources: cites.map((cite) => cite.id) }],
  });
  /** One passed sweep whose one check task cites `cited` and whose one stored check decides `decided`. */
  const sweep = (inferences: unknown, decided: readonly Cite[], scopeBoundaries: unknown = [greets, network], cited: readonly Cite[] = decided) => ({
    id: "sweep-1",
    version: 2,
    inferences,
    scopeBoundaries,
    storedChecks: decided.length === 0 ? [] : [{ checkTaskId: "c1", taskSpec: spec(cited), name: "greets", decides: decided.map((cite) => cite.id) }],
    reportBody: null,
    undecided: [],
  });
  const keysOf = (...sweeps: ReportRecords["passedSweeps"]) => uncheckedAtPassedSweeps({ passedSweeps: sweeps }).map((found) => found.key);

  it("passes when every in-scope line and every assumption not recorded as internal design is decided as the sweep's vision states it", () => {
    expect(keysOf(sweep([visible, design], [S1, A1]))).toEqual([]);
  });

  it("names a client-visible assumption no swept check decides, or decides only as an earlier vision stated it", () => {
    expect(keysOf(sweep([visible, design], [S1]))).toEqual(["A1"]);
    expect(keysOf(sweep([visible], [S1, { ...A1, text: "Messages are in French." }]))).toEqual(["A1"]);
  });

  // ADR-083: a line citing an item is no check of it; only a stored check's decides is.
  it("names an item its check task cites, on an acceptance line too, that no stored check decides", () => {
    expect(keysOf(sweep([visible], [S1], [greets, network], [S1, A1]))).toEqual(["A1"]);
  });

  it("names an in-scope line, or one of no recorded side, no swept check decides; never an out-of-scope one", () => {
    expect(keysOf(sweep([visible], [S1, A1], [greets, counts, network]))).toEqual(["S2"]);
    expect(keysOf(sweep([visible], [A1], ["The product greets."]))).toEqual(["S1"]);
  });

  it("holds an assumption of no recorded kind to a check, keyed by its place", () => {
    expect(keysOf(sweep([visible, undecidedLegacy], [S1, A1]))).toEqual(["A2"]);
  });

  it("judges every passed sweep against the vision current when it passed, naming each item once", () => {
    const reworded = { ...visible, statement: "Messages are in French." };
    expect(keysOf(sweep([visible], [S1, A1]), { ...sweep([reworded], [S1, A1]), id: "sweep-2" })).toEqual(["A1"]);
    expect(keysOf(sweep([visible], [S1]), { ...sweep([visible], [S1]), id: "sweep-2" })).toEqual(["A1"]);
  });

  // ADR-084 decision 2: an item a suite review left undecided reaches I6 as unverified, never covered.
  it("names an item a review left undecided that the sweep's delivered report does not name as unverified, or calls covered", () => {
    const left = (reportBody: string) => ({ ...sweep([visible], [S1, A1]), reportBody, undecided: [{ id: "S1", text: greets.text }] });
    const named = `These items of what you asked for have a stored check that passed on main and is recorded as deciding them, but nothing settled it.\n- ${greets.text}`;
    expect(keysOf(left(`Delivered.\n\n${named}\n\nNothing more.`))).toEqual([]);
    expect(keysOf(left("Delivered.\n\nEvery item of what you asked for is decided by a stored check."))).toEqual(["undecided-unreported:S1", "undecided-covered"]);
    expect(keysOf({ ...left("Delivered."), reportBody: null })).toEqual([]);
  });

  it("fails closed when the vision or the trace cannot be read", () => {
    expect(keysOf({ ...sweep([], []), version: null })).toEqual(["no-vision"]);
    expect(keysOf(sweep({ planning: "a map" }, []))).toEqual(["vision-unreadable"]);
    expect(keysOf(sweep([visible], [S1], [{ text: "" }]))).toEqual(["vision-unreadable"]);
    const check = { checkTaskId: "c1", taskSpec: spec([S1]), name: "greets", decides: ["S1"] };
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, taskSpec: { origin: "check" } }] })).toEqual(["coverage-unreadable"]);
    // A check stored with no record of what it decides decides nothing on record.
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, decides: null }] })).toEqual(["coverage-unreadable"]);
    expect(keysOf({ ...sweep([visible], []), storedChecks: [{ ...check, decides: ["A1"] }] })).toEqual(["coverage-unreadable"]);
  });
});

describe("checkReports, a burn warning", () => {
  // ADR-084 addendum 1 decision 7: a warning states the figures it recorded, its zone held on them,
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
