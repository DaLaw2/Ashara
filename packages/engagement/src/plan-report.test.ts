import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "@ashara/shared";
import { PlanReports } from "./plan-report.js";
import type { PlanReportStore } from "./plan-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000010", "test");

type Dropped = { kind: "recorded"; count: number } | { kind: "unrecorded" };

function reportsFor(
  tasks: { decomposition: number; sprint0: number; checks: number; reviews: number; unrecorded: number },
  droppedOrderingHints: Dropped = { kind: "recorded", count: 0 },
) {
  const posted: string[] = [];
  const blocked: ProjectBlockCause[] = [];
  const store: PlanReportStore = {
    dueReports: async () => [
      { subject: "first-plan", projectId, epicTitles: ["Studio sign-up merge"], tasks, droppedOrderingHints },
    ],
    postReport: async (_projectId, _subject, body) => {
      posted.push(body);
      return "posted";
    },
    dueRevisionReports: async () => [],
    postRevisionReport: async () => {
      throw new Error("no revision is due");
    },
    blockProject: async (_projectId, cause) => {
      blocked.push(cause);
      return "blocked";
    },
  };
  return { reports: new PlanReports(store), posted, blocked };
}

describe("first-plan report", () => {
  test("counts only the tasks toward the client's goal and states the environment setup and the checks apart", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, checks: 6, reviews: 1, unrecorded: 0 });

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`1 epic ("Studio sign-up merge"), split into 6 tasks for what you asked for.`);
    expect(posted[0]).toContain("First, the team sets up the project environment");
    expect(posted[0]).toContain("Before any of those tasks starts, team members who do not do them write the checks that decide whether each is done (6 check tasks)");
    expect(posted[0]).toContain("Then a team member who wrote none of those checks reads them all together with what you asked for");
    expect(posted[0]).not.toMatch(/7 tasks|12 tasks|13 tasks|ordering hint/);
  });

  test("states the ordering hints the plan dropped", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, checks: 6, reviews: 1, unrecorded: 0 }, { kind: "recorded", count: 2 });

    await reports.runPending();

    expect(posted[0]).toContain("2 ordering hints were dropped while planning");
  });

  test.each([
    ["a task of unrecorded origin", { decomposition: 6, sprint0: 1, checks: 6, reviews: 1, unrecorded: 1 }, { kind: "recorded", count: 0 }],
    ["no Sprint 0 task", { decomposition: 6, sprint0: 0, checks: 6, reviews: 1, unrecorded: 0 }, { kind: "recorded", count: 0 }],
    ["a decomposed task without its check task", { decomposition: 6, sprint0: 1, checks: 5, reviews: 1, unrecorded: 0 }, { kind: "recorded", count: 0 }],
    ["no record of dropped ordering hints", { decomposition: 6, sprint0: 1, checks: 6, reviews: 1, unrecorded: 0 }, { kind: "unrecorded" }],
    ["no review of its checks", { decomposition: 6, sprint0: 1, checks: 6, reviews: 0, unrecorded: 0 }, { kind: "recorded", count: 0 }],
  ] as const)("a plan with %s is not reported and its project is blocked", async (_case, tasks, dropped) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor({ ...tasks }, { ...dropped });

    const outcomes = await reports.runPending();

    expect(blocked).toEqual([{ category: "fault", errorClass: "PlanReportUnfounded", reason: expect.stringMatching(/^PlanReportUnfounded: /) }]);
    expect(outcomes).toEqual([{ kind: "project-blocked", projectId, cause: blocked[0] }]);
    expect(posted).toHaveLength(0);
  });
});

describe("plan revision report", () => {
  function revisionReports(summary: unknown) {
    const posted: Array<{ revisionId: string; body: string }> = [];
    const blocked: ProjectBlockCause[] = [];
    const store: PlanReportStore = {
      dueReports: async () => [],
      postReport: async () => {
        throw new Error("no first-plan report is due");
      },
      dueRevisionReports: async () => [{ revisionId: "rev-2", projectId, revision: 2, summary }],
      postRevisionReport: async (revisionId, body) => {
        posted.push({ revisionId, body });
        return "posted";
      },
      blockProject: async (_projectId, cause) => {
        blocked.push(cause);
        return "blocked";
      },
    };
    return { reports: new PlanReports(store), posted, blocked };
  }

  test("says what the client said, what the team now does, what is set aside and what stays done", async () => {
    const { reports, posted } = revisionReports({
      answer: "The hill studio opens first.",
      decision: "The hill studio opens first.",
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
    expect(body).toMatch(/^Because you said "The hill studio opens first\.", the team has revised the plan/);
    expect(body).toContain("The team will now do 1 task:\n- Open hill studio bookings");
    expect(body).toContain("set aside and will not be done as planned:\n- Open harbour studio bookings");
    expect(body).toContain("1 task already finished stays done");
    expect(body).not.toContain("sets up the project environment again");
  });

  test("a summary that does not parse is not reported and blocks the project", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = revisionReports({ answer: "Hill first." });

    await reports.runPending();

    expect(posted).toHaveLength(0);
    expect(blocked.map((cause) => cause.errorClass)).toEqual(["PlanRevisionSummaryUnreadable"]);
  });
});
