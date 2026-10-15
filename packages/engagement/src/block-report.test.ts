import { describe, expect, test } from "vitest";
import { SPEND_CAP_ERROR_CLASS, parseProjectId } from "@ashara/shared";
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
  return { reports: new BlockReports(store), posted };
}

describe("project block reports", () => {
  test.each(["budget_cap", "configuration", "fault", "planning_stopped"] as const)(
    "%s: one report saying work is paused, the recorded cause, and that the operator is awaited",
    async (kind) => {
      const cause = { errorClass: "SomethingFailed", reason: `the ${kind} cause as recorded` };
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

  // smoke1 D4: a deployment-cap halt was told as "The budget set for this project has to be raised".
  test.each([
    [
      SPEND_CAP_ERROR_CLASS.deployment,
      "the spending limit set for all of Ashara's work, across every project it runs, was reached",
      "The spending limit for all of Ashara's work has to be raised before more is spent on any project, this one included.",
    ],
    [SPEND_CAP_ERROR_CLASS.project, "the spending limit set for this project was reached", "The budget set for this project has to be raised before more is spent."],
    ["SomethingElse", "a spending limit set for this work was reached, so the next step of the work was not paid for; which limit it was is not on record", "The spending limit that was reached has to be raised before more is spent."],
  ])("a budget_cap halt recorded as %s names the limit its record names", async (errorClass, cause, next) => {
    // The message names the other cap: the report is chosen by the recorded class, never by the message's words.
    const reason = "budget_cap: the spend cap of project p is $1; Raise ASHARA_PROJECT_BUDGET_LIMIT_USD (the deployment cap)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap", cause: { errorClass, reason } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(`Ashara recorded the cause as this: ${cause}`);
    expect(posted[0].body).toContain(next);
    expect(posted[0].body).not.toContain(errorClass);
    if (errorClass !== SPEND_CAP_ERROR_CLASS.project) expect(posted[0].body).not.toContain("The budget set for this project");
  });

  test("a halt with no cause recorded says so, and claims none", async () => {
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "fault", cause: { errorClass: null, reason: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain("No cause was recorded for this pause.");
  });

  // W11b D3: the client read "PlanReportUnfounded: project ... 13 decomposed task(s) ...".
  test("a fault's report keeps the error class and chain with the operator, and names the record that holds them", async () => {
    const reason =
      "PlanReportUnfounded: project 00000000-0000-4000-8000-000000000020 is recorded as planned with 2 epic(s), 13 decomposed task(s); " +
      "no report is posted\n    at PlanReports.compose (packages/engagement/src/plan-report.ts:289:13)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "ep-7", projectId, kind: "fault", cause: { errorClass: "PlanReportUnfounded", reason } },
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

// Story s-independent-verify-m1 W7 (M2 trial M3): the cause told is the one observed, never a
// sentence fixed per kind of halt.
describe("halt reports state the observed cause", () => {
  test("an infrastructure halt quotes the recorded fault chain, says it is not charged and resumes by itself", async () => {
    const reason =
      "task t1 met 4 infrastructure fault(s), past the budget of 3 uncharged requeues; the project halts until the " +
      "substrate probe passes. The last fault: task cell unavailable: exec wrapper killed by the command's own kill -9";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "infrastructure", cause: { errorClass: "InfrastructureFaultBudgetSpent", reason } },
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

  test("an undeliverable halt names each task given up with the cause its record holds", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [
          { title: "Lock the data directory", attempts: 3, cause: { source: "failure_given_up", reason: "attempts exhausted (3/3)", detail: "flock: lock held by pid 41" } },
          { title: "Review the checks", attempts: 1, cause: { source: "suite_review_unresolved", checkTaskIds: ["c"], reason: "checks 2 and 5 contradict" } },
          {
            title: "Acceptance on main 0123456789ab",
            attempts: 0,
            cause: { source: "acceptance_failed", mainCommit: "0123456789abcdef0123456789abcdef01234567", reason: `check "get" exited 1` },
          },
        ],
      },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    expect(body).toContain("cannot deliver it as planned");
    expect(body).toContain(`"Lock the data directory", after 3 attempts. As recorded: attempts exhausted (3/3) flock: lock held by pid 41`);
    expect(body).toContain(`"Review the checks", after 1 attempt. As recorded: checks 2 and 5 contradict`);
    expect(body).toContain(`the acceptance run on main 0123456789abcdef0123456789abcdef01234567 did not pass: check "get" exited 1`);
    // The fixed per-source sentences are gone (Discipline D).
    expect(body).not.toContain("every attempt at it failed");
  });

  test("a task given up through the API quotes the reason its caller stored, and says when none was", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [
          { title: "Port the importer", attempts: 2, cause: { source: "api", reason: "superseded by the new importer" } },
          { title: "Drop the cache", attempts: 0, cause: { source: "api" } },
        ],
      },
    ]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain(`"Port the importer", after 2 attempts. As recorded: it was moved by hand through Ashara's API, with this recorded: {"reason":"superseded by the new importer"}`);
    expect(body).toContain(`"Drop the cache", after 0 attempts. As recorded: it was moved by hand through Ashara's API; no cause beyond that is recorded`);
  });
});
