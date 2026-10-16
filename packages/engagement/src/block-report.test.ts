import { describe, expect, test } from "vitest";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import { BlockReports } from "./block-report.js";
import type { BlockReportStore } from "./block-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000020", "test");

type Due = Awaited<ReturnType<BlockReportStore["dueReports"]>>[number];

function reportsFor(due: readonly Due[]) {
  const posted: Array<{ key: string; body: string }> = [];
  const store: BlockReportStore = {
    dueReports: async () => due,
    postProjectReport: async (episodeId, on, body) => {
      posted.push({ key: `${episodeId}:${on}`, body });
      return "posted";
    },
  };
  return { reports: new BlockReports(store, memoryStepContainment(() => true)), posted };
}

describe("project block reports", () => {
  test.each(["budget_cap", "configuration", "fault", "planning_stopped"] as const)(
    "%s: one report saying work is paused, the recorded cause, and that the operator is awaited",
    async (kind) => {
      const cause = { errorClass: "SomethingFailed", reason: `the ${kind} cause as recorded`, spend: null, work: null };
      const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind, cause }]);

      expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "project-blocked" }]);

      expect(posted).toHaveLength(1);
      expect(posted[0].key).toBe("e1:blocked");
      expect(posted[0].body).toContain("Ashara recorded the cause as this: ");
      expect(posted[0].body).toContain("its own record of this pause, record e1.");
      expect(posted[0].body).not.toContain("SomethingFailed");
      expect(posted[0].body).not.toContain(`the ${kind} cause as recorded`);
      expect(posted[0].body).toContain("waiting on its operator");
    },
  );

  // A deployment-cap halt is never told as the project's own budget needing to be raised.
  test.each([
    [
      SPEND_CAP_ERROR_CLASS.deployment,
      "the spending limit set for all of Ashara's work, across every project it runs, left no room for the next step of the work",
      "The spending limit for all of Ashara's work has to be raised before more is spent on any project, this one included.",
    ],
    [SPEND_CAP_ERROR_CLASS.project, "the spending limit set for this project left no room for the next step of the work", "The budget set for this project has to be raised before more is spent."],
    [
      "SomethingElse",
      "a spending limit set for this work left no room for the next step of the work, so that step was not paid for; which limit it was is not on record",
      "The spending limit that stopped the work has to be raised before more is spent.",
    ],
  ])("a budget_cap halt recorded as %s names the limit its record names", async (errorClass, cause, next) => {
    // The message names the other cap: the report is chosen by the recorded class, never by the message's words.
    const reason = "budget_cap: the spend cap of project p is $1; Raise ASHARA_PROJECT_BUDGET_LIMIT_USD (the deployment cap)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap", cause: { errorClass, reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(`Ashara recorded the cause as this: ${cause}`);
    expect(posted[0].body).not.toContain("was reached");
    expect(posted[0].body).toContain("How much had been spent and set aside against that limit when it stopped the work is not on record.");
    expect(posted[0].body).toContain(next);
    expect(posted[0].body).not.toContain(errorClass);
    if (errorClass !== SPEND_CAP_ERROR_CLASS.project) expect(posted[0].body).not.toContain("The budget set for this project");
  });

  // A cap refuses a call whose worst case would cross it, before the recorded spend reaches the limit.
  test("a budget_cap halt states the spent, set-aside and limit amounts its record holds, never a limit reached", async () => {
    const spend = { capUsd: 1, spentUsd: 0.412203, inFlightUsd: 0.29854, nextCallUsd: 0.304642 };
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap", cause: { errorClass: SPEND_CAP_ERROR_CLASS.deployment, reason: "r", spend, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(
      "When it stopped the work, $0.412203 had been spent and $0.298540 was set aside for work under way, and the next step " +
        "needed up to $0.304642 set aside, more than the limit had room for; the limit is $1.000000.",
    );
    expect(posted[0].body).not.toContain("was reached");
  });

  // ADR-084 decision 1: the report names the budget, what was drawn against it and which call sites drew it.
  test("a work_budget halt names the request budget, what was drawn and the call sites that drew it, and that a grant is awaited", async () => {
    const work = {
      scope: "project" as const,
      budgetRequests: 650,
      grantedRequests: 50,
      spentRequests: 649,
      inFlightRequests: 1,
      bySite: [{ callSite: "agent", requests: 600 }, { callSite: "suite-review", requests: 50 }],
    };
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "work_budget", cause: { errorClass: "WorkBudgetSpent", reason: "r", spend: null, work } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain("Ashara recorded the cause as this: the budget of model requests set for this project was used up");
    expect(posted[0].body).toContain(
      "When it stopped the work, 649 model requests had been sent and 1 more were under way, against a budget of 650 model " +
        'requests, 50 model requests of it granted by the operator. The requests drawn, by the step of the work that drew them: "agent" 600, "suite-review" 50.',
    );
    expect(posted[0].body).toContain("More model requests have to be granted to this project before more work is done.");
    expect(posted[0].body).not.toContain("WorkBudgetSpent");
  });

  test("a halt with no cause recorded says so, and claims none", async () => {
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "fault", cause: { errorClass: null, reason: null, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain("No cause was recorded for this pause.");
  });

  // The client never reads an error class or its chain.
  test("a fault's report keeps the error class and chain with the operator, and names the record that holds them", async () => {
    const reason =
      "PlanReportUnfounded: project 00000000-0000-4000-8000-000000000020 is recorded as planned with 2 epic(s), 13 decomposed task(s); " +
      "no report is posted\n    at PlanReports.compose (packages/engagement/src/plan-report.ts:289:13)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "ep-7", projectId, kind: "fault", cause: { errorClass: "PlanReportUnfounded", reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).not.toMatch(/PlanReportUnfounded|Error\b|decomposed task\(s\)|\n\s+at |\.ts:\d+/);
    expect(body).toContain(
      "Ashara recorded the cause as this: a step of Ashara's own work on this project failed, or Ashara's own record of the project did not hold together.",
    );
    expect(body).toContain("Ashara keeps the technical detail in its own record of this pause, record ep-7.");
    expect(body).toContain("The team has to repair it.");
  });

  test("a resumption after an unblock is told once, on its own episode", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "unblocked" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the team cleared what paused it") }]);
  });
});

// Story s-independent-verify-m1 W7: the cause told is the one observed, never a
// sentence fixed per kind of halt.
describe("halt reports state the observed cause", () => {
  test("an infrastructure halt quotes the recorded fault chain, says it is not charged and resumes by itself", async () => {
    const reason =
      "task t1 met 4 infrastructure fault(s), past the budget of 3 uncharged requeues; the project halts until the " +
      "substrate probe passes. The last fault: task cell unavailable: exec wrapper killed by the command's own kill -9";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "infrastructure", cause: { errorClass: "InfrastructureFaultBudgetSpent", reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain("Ashara recorded the cause as this: the machines Ashara runs the work on kept failing");
    expect(posted[0].body).not.toContain("InfrastructureFaultBudgetSpent");
    expect(posted[0].body).not.toContain("kill -9");
    expect(posted[0].body).toContain("not charged");
    expect(posted[0].body).toContain("resumes this project by itself");
    expect(posted[0].body).not.toContain("operator");
  });

  test("its resumption says the machines work again", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "probe_passed" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the machines Ashara runs the work on work again") }]);
  });

  test("an undeliverable halt names each task given up with its recorded category and record, never the stored text", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [
          { workItemId: "w1", title: "Lock the data directory", attempts: 3, cause: { source: "failure_given_up", reason: "attempts exhausted (3/3)", detail: "flock: lock held by pid 41" } },
          { workItemId: "w2", title: "Review the checks", attempts: 1, cause: { source: "suite_review_unresolved", checkTaskIds: ["c"], reason: "checks 2 and 5 contradict" } },
          {
            workItemId: "w3",
            title: "Acceptance on main 0123456789ab",
            attempts: 0,
            cause: { source: "acceptance_failed", mainCommit: "0123456789abcdef0123456789abcdef01234567", reason: `check "get" exited 1` },
          },
          { workItemId: "w4", title: "Write the importer", attempts: 2, cause: { source: "orchestrator_error", reason: "orchestrator error" } },
        ],
      },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    expect(body).toContain("cannot deliver it as planned");
    expect(body).toContain(
      `- "Lock the data directory", after 3 attempts counted against it. Ashara recorded why it was given up as this: its attempts at the work did not succeed. ` +
        `Ashara keeps the detail in its own record of that task, record w1.`,
    );
    expect(body).toContain(`"Review the checks", after 1 attempt counted against it. Ashara recorded why it was given up as this: the review of the plan's checks found problems`);
    expect(body).toContain("the final check of the whole project did not pass on the project's main line. Ashara keeps the detail in its own record of that task, record w3.");
    expect(body).toContain("a step of Ashara's own work on it failed. Ashara keeps the detail in its own record of that task, record w4.");
    // The stored reasons are Ashara's internal wording: none reaches the client.
    for (const stored of ["attempts exhausted", "flock", "checks 2 and 5", "exited 1", "orchestrator error"]) expect(body).not.toContain(stored);
  });

  test("a task given up through the API is told as moved by hand, whatever its caller stored", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [{ workItemId: "w1", title: "Port the importer", attempts: 2, cause: { source: "api", reason: "superseded by the new importer" } }],
      },
    ]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain(`"Port the importer", after 2 attempts counted against it. Ashara recorded why it was given up as this: it was moved by hand through Ashara's API.`);
    expect(body).not.toContain("superseded by the new importer");
  });
});
