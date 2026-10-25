import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import type { DroppedOrderingHints, DuePlanReport, PlanTaskCounts } from "@ashara/delivery/reads";
import { PlanReports } from "./plan-report.js";
import type { PlanReportStore } from "./plan-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000010", "test");

type Revision = Extract<DuePlanReport, { readonly revisions: unknown }>["revisions"][number];

const CHANGE_SUMMARY = {
  changes: [{ answer: "Keys contain no whitespace.", decision: "Keys are non-empty and contain no whitespace." }],
  newTasks: ["Store text keys"],
  newCheckTasks: 1,
  newEnvironmentTask: true,
  supersededTasks: ["Store keys without newlines"],
  supersededOther: 4,
  keptCompleted: 0,
};

function reportsFor(
  tasks: PlanTaskCounts,
  droppedOrderingHints: DroppedOrderingHints = { kind: "recorded", count: 0 },
  revisions: readonly Revision[] = [],
  dueRevisions: readonly Revision[] = [],
  assumptions: ReadonlyArray<{ readonly key: string; readonly statement: string }> = [],
) {
  const posted: string[] = [];
  const folded: string[][] = [];
  const revisionPosts: string[] = [];
  const blocked: ProjectBlockCause[] = [];
  const store: PlanReportStore = {
    dueReports: async () => [
      { subject: "first-plan", projectId, epicTitles: ["Studio sign-up merge"], tasks, droppedOrderingHints, revisions, assumptions },
    ],
    postReport: async (_projectId, _subject, body, revisionIds) => {
      posted.push(body);
      folded.push([...revisionIds]);
      return "posted";
    },
    dueRevisionReports: async () => dueRevisions.map((r) => ({ ...r, projectId })),
    postRevisionReport: async (_revisionId, body) => {
      revisionPosts.push(body);
      return "posted";
    },
    blockProject: async (_projectId, cause) => {
      blocked.push(cause);
      return "blocked";
    },
    riskRecords: async () => ({ kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } }),
  };
  return { reports: new PlanReports(store, memoryStepContainment(() => true)), posted, folded, revisionPosts, blocked };
}

const FOUNDED: PlanTaskCounts = { decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 0, started: 0 };

describe("first-plan report", () => {
  test("counts only the tasks toward the client's goal and states the environment setup and the checks apart", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 0, started: 0 });

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`1 epic ("Studio sign-up merge"), split into 6 tasks for what you asked for.`);
    expect(posted[0]).toContain("First, the team sets up the project environment");
    expect(posted[0]).toContain("Before any of those tasks starts, team members who do not do them write the checks that decide whether each is done (6 check tasks)");
    expect(posted[0]).toContain("Then a team member who wrote none of those checks reads them all together with what you asked for");
    expect(posted[0]).not.toMatch(/7 tasks|12 tasks|13 tasks|ordering hint/);
  });

  test("names each behaviour the plan adds beyond the contract by the assumption it is recorded as, and says none of its tasks starts first", async () => {
    const { reports, posted } = reportsFor(FOUNDED, { kind: "recorded", count: 0 }, [], [], [
      { key: "A12", statement: "A loan returned after its due date stays listed with its fine." },
    ]);

    await reports.runPending();

    expect(posted[0]).toContain("The plan also builds behaviour your request does not state.");
    expect(posted[0]).toContain("- A12: A loan returned after its due date stays listed with its fine.");
    expect(posted[0]).toContain("no task resting on it starts before this message");
  });

  test("a plan that adds nothing beyond the contract names no assumption of its own", async () => {
    const { reports, posted } = reportsFor(FOUNDED);

    await reports.runPending();

    expect(posted[0]).not.toContain("your request does not state");
  });

  test("states the ordering hints the plan dropped", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 0, started: 0 }, { kind: "recorded", count: 2 });

    await reports.runPending();

    expect(posted[0]).toContain("2 ordering hints were dropped while planning");
  });

  test.each([
    ["a task of unrecorded origin", { decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 1, started: 0 }, { kind: "recorded", count: 0 }],
    ["no Sprint 0 task", { decomposition: 6, sprint0: 0, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 0, started: 0 }, { kind: "recorded", count: 0 }],
    ["a decomposed task without its check task", { decomposition: 6, sprint0: 1, scaffolds: 1, checks: 5, reviews: 1, unrecorded: 0, started: 0 }, { kind: "recorded", count: 0 }],
    ["no record of dropped ordering hints", { decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 1, unrecorded: 0, started: 0 }, { kind: "unrecorded" }],
    ["no review of its checks", { decomposition: 6, sprint0: 1, scaffolds: 1, checks: 6, reviews: 0, unrecorded: 0, started: 0 }, { kind: "recorded", count: 0 }],
    ["no product scaffold", { decomposition: 6, sprint0: 1, scaffolds: 0, checks: 6, reviews: 1, unrecorded: 0, started: 0 }, { kind: "recorded", count: 0 }],
  ] as const)("a plan with %s is not reported and its project is blocked", async (_case, tasks, dropped) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor({ ...tasks }, { ...dropped });

    const outcomes = await reports.runPending();

    expect(blocked).toEqual([{ category: "fault", errorClass: "PlanReportUnfounded", reason: expect.stringMatching(/^PlanReportUnfounded: /) }]);
    expect(outcomes).toEqual([{ kind: "project-blocked", projectId, cause: blocked[0] }]);
    expect(posted).toHaveLength(0);
  });

  test("a plan with a task already started is not reported as one none of whose tasks had started", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor({ ...FOUNDED, started: 1 });

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["PlanReportUnfounded"]);
  });

  test("a plan revised before it was reported is one report of the plan that stands, which also tells the revision", async () => {
    const { reports, posted, folded, revisionPosts, blocked } = reportsFor(FOUNDED, { kind: "recorded", count: 0 }, [
      { revisionId: "rev-2", revision: 2, summary: CHANGE_SUMMARY, answersTaken: 1 },
    ]);

    expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);

    expect(blocked).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(folded).toEqual([["rev-2"]]);
    expect(revisionPosts).toEqual([]);
    expect(posted[0]).toContain("split into 6 tasks for what you asked for.");
    expect(posted[0]).toContain(`This plan already takes in your message. The team revised the plan`);
    expect(posted[0]).toContain(`Because you said "Keys contain no whitespace.", work proceeds on: Keys are non-empty and contain no whitespace.`);
    // Nothing of the replaced plan is described: the client never saw it.
    expect(posted[0]).not.toMatch(/Store keys without newlines|set aside/);
  });

  test("a revision that took in two changing answers names both, each with what it changed", async () => {
    const twoChanges = {
      ...CHANGE_SUMMARY,
      changes: [
        { answer: "Count words like wc does.", decision: "Words are counted as wc counts them." },
        { answer: "Use Python 3.", decision: "The tool is written in Python 3." },
      ],
    };
    const { reports, posted, blocked } = reportsFor(FOUNDED, { kind: "recorded", count: 0 }, [
      { revisionId: "rev-2", revision: 2, summary: twoChanges, answersTaken: 2 },
    ]);

    await reports.runPending();

    expect(blocked).toEqual([]);
    expect(posted[0]).toContain("This plan already takes in your 2 messages that changed it.");
    expect(posted[0]).toContain(`- Because you said "Count words like wc does.", work proceeds on: Words are counted as wc counts them.`);
    expect(posted[0]).toContain(`- Because you said "Use Python 3.", work proceeds on: The tool is written in Python 3.`);
  });

  test.each([
    ["names fewer changes than the answers it took in", CHANGE_SUMMARY, 2],
    ["is a client change with no answer recorded as taken in", CHANGE_SUMMARY, 0],
  ] as const)("a revision whose summary %s is not reported and blocks the project", async (_case, summary, answersTaken) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor(FOUNDED, { kind: "recorded", count: 0 }, [{ revisionId: "rev-2", revision: 2, summary, answersTaken }]);

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["RevisionChangesUnrecorded"]);
  });

  test("a repair recorded before the first plan was reported cannot be described, and blocks the project", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { newTasks, newCheckTasks, newEnvironmentTask, supersededTasks, supersededOther, keptCompleted } = CHANGE_SUMMARY;
    const repair = { repaired: ["Store keys"], newTasks, newCheckTasks, newEnvironmentTask, supersededTasks, supersededOther, keptCompleted };
    const { reports, posted, blocked } = reportsFor(FOUNDED, { kind: "recorded", count: 0 }, [
      { revisionId: "rev-2", revision: 2, summary: repair, answersTaken: 0 },
    ]);

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["RepairBeforeFirstPlanReport"]);
  });

  test("a project blocked by its first-plan report is not told what the team will now do", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, revisionPosts, blocked } = reportsFor({ ...FOUNDED, sprint0: 2 }, { kind: "recorded", count: 0 }, [], [
      { revisionId: "rev-2", revision: 2, summary: CHANGE_SUMMARY, answersTaken: 1 },
    ]);

    await reports.runPending();

    expect(blocked).toHaveLength(1);
    expect(posted).toEqual([]);
    expect(revisionPosts).toEqual([]);
  });
});

describe("plan revision report", () => {
  function revisionReports(summary: unknown, answersTaken = 1) {
    const posted: Array<{ revisionId: string; body: string }> = [];
    const blocked: ProjectBlockCause[] = [];
    const store: PlanReportStore = {
      dueReports: async () => [],
      postReport: async () => {
        throw new Error("no first-plan report is due");
      },
      dueRevisionReports: async () => [{ revisionId: "rev-2", projectId, revision: 2, summary, answersTaken }],
      postRevisionReport: async (revisionId, body) => {
        posted.push({ revisionId, body });
        return "posted";
      },
      blockProject: async (_projectId, cause) => {
        blocked.push(cause);
        return "blocked";
      },
      riskRecords: async () => ({ kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } }),
    };
    return { reports: new PlanReports(store, memoryStepContainment(() => true)), posted, blocked };
  }

  test("says what the client said, what the team now does, what is set aside and what stays done", async () => {
    const { reports, posted } = revisionReports({
      changes: [{ answer: "The hill studio opens first.", decision: "The hill studio opens first." }],
      newTasks: ["Open hill studio bookings"],
      newCheckTasks: 1,
      newEnvironmentTask: false,
      supersededTasks: ["Open harbour studio bookings"],
      supersededOther: 1,
      keptCompleted: 1,
    });

    expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);

    expect(posted).toHaveLength(1);
    const body = posted[0]?.body ?? "";
    expect(body).toMatch(/^The team has revised the plan for this project for your message\. Because you said "The hill studio opens first\.", work proceeds on: The hill studio opens first\./);
    expect(body).toContain("The team will now do 1 task:\n- Open hill studio bookings");
    expect(body).toContain("set aside and will not be done as planned:\n- Open harbour studio bookings");
    expect(body).toContain("1 task already finished stays done");
    expect(body).not.toContain("sets up the project environment again");
    // Recorded before review tasks were counted: the review is told as not on record, never asserted.
    expect(body).toContain("The record of this revision does not say whether a team member who wrote none of those checks reviews them");
    expect(body).not.toContain("reads them all together");
  });

  test("a repair that adds behaviour beyond the contract names each assumption it recorded", async () => {
    const { reports, posted } = revisionReports(
      {
        repaired: ["Report overdue loans"],
        newTasks: ["Report overdue and late-returned loans"],
        newCheckTasks: 1,
        newReviewTasks: 1,
        newEnvironmentTask: false,
        supersededTasks: [],
        supersededOther: 0,
        keptCompleted: 2,
        assumptions: [{ key: "A12", statement: "A loan returned after its due date stays listed with its fine." }],
      },
      0,
    );

    expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    const body = posted[0]?.body ?? "";
    expect(body).toContain("The plan also builds behaviour your request does not state.");
    expect(body).toContain("- A12: A loan returned after its due date stays listed with its fine.");
  });

  test("a correction that left nothing to plan again is reported with no new task", async () => {
    const { reports, posted } = revisionReports({
      changes: [{ answer: "Drop the class list.", decision: "G1 is withdrawn." }],
      newTasks: [],
      newCheckTasks: 0,
      newReviewTasks: 0,
      newEnvironmentTask: false,
      supersededTasks: ["List classes"],
      supersededOther: 1,
      keptCompleted: 0,
    });

    expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    const body = posted[0]?.body ?? "";
    expect(body).toContain("No new task is needed for this");
    expect(body).not.toContain("The team will now do");
    expect(body).toContain("set aside and will not be done as planned:\n- List classes");
  });

  test("states the review of the checks only when the revision records its review task", async () => {
    const summary = { ...CHANGE_SUMMARY, newEnvironmentTask: false };
    const reviewed = revisionReports({ ...summary, newReviewTasks: 1 });
    await reviewed.reports.runPending();
    expect(reviewed.posted[0]?.body).toContain("Then a team member who wrote none of those checks reads them all together");

    const unreviewed = revisionReports({ ...summary, newReviewTasks: 0 });
    await unreviewed.reports.runPending();
    expect(unreviewed.posted[0]?.body).toContain("No team member reviews those checks together before building starts.");
  });

  test("a summary that does not parse is not reported and blocks the project", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = revisionReports({ answer: "Hill first." });

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["PlanRevisionSummaryUnreadable"]);
  });

  test("a revision that took in two answers names both, each with what it changed", async () => {
    const { reports, posted, blocked } = revisionReports(
      {
        changes: [
          { answer: "The hill studio opens first.", decision: "The hill studio opens first." },
          { answer: "Bookings close at 18:00.", decision: "Bookings close at 18:00." },
        ],
        newTasks: ["Open hill studio bookings"],
        newCheckTasks: 1,
        newEnvironmentTask: false,
        supersededTasks: [],
        supersededOther: 0,
        keptCompleted: 0,
      },
      2,
    );

    await reports.runPending();

    expect(blocked).toEqual([]);
    const body = posted[0]?.body ?? "";
    expect(body).toContain("for your 2 messages that changed it:");
    expect(body).toContain(`- Because you said "The hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(body).toContain(`- Because you said "Bookings close at 18:00.", work proceeds on: Bookings close at 18:00.`);
  });

  test("a revision recorded as taking in an answer its summary does not name is not reported", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = revisionReports(
      {
        changes: [{ answer: "The hill studio opens first.", decision: "The hill studio opens first." }],
        newTasks: ["Open hill studio bookings"],
        newCheckTasks: 1,
        newEnvironmentTask: false,
        supersededTasks: [],
        supersededOther: 0,
        keptCompleted: 0,
      },
      2,
    );

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["RevisionChangesUnrecorded"]);
  });
});
