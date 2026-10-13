import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "@ashara/shared";
import { PlanReports } from "./plan-report.js";
import type { PlanReportStore } from "./plan-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000010");

type Dropped = { kind: "recorded"; count: number } | { kind: "unrecorded" };

function reportsFor(
  tasks: { decomposition: number; sprint0: number; checks: number; unrecorded: number },
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
    blockProject: async (_projectId, cause) => {
      blocked.push(cause);
      return "blocked";
    },
  };
  return { reports: new PlanReports(store), posted, blocked };
}

describe("first-plan report", () => {
  test("counts only the tasks toward the client's goal and states the environment setup and the checks apart", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, checks: 6, unrecorded: 0 });

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`1 epic ("Studio sign-up merge"), split into 6 tasks for what you asked for.`);
    expect(posted[0]).toContain("First, the team sets up the project environment");
    expect(posted[0]).toContain("writes the checks that decide whether it is done (6 check tasks)");
    expect(posted[0]).not.toMatch(/7 tasks|12 tasks|13 tasks|ordering hint/);
  });

  test("states the ordering hints the plan dropped", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, sprint0: 1, checks: 6, unrecorded: 0 }, { kind: "recorded", count: 2 });

    await reports.runPending();

    expect(posted[0]).toContain("2 ordering hints were dropped while planning");
  });

  test.each([
    ["a task of unrecorded origin", { decomposition: 6, sprint0: 1, checks: 6, unrecorded: 1 }, { kind: "recorded", count: 0 }],
    ["no Sprint 0 task", { decomposition: 6, sprint0: 0, checks: 6, unrecorded: 0 }, { kind: "recorded", count: 0 }],
    ["a decomposed task without its check task", { decomposition: 6, sprint0: 1, checks: 5, unrecorded: 0 }, { kind: "recorded", count: 0 }],
    ["no record of dropped ordering hints", { decomposition: 6, sprint0: 1, checks: 6, unrecorded: 0 }, { kind: "unrecorded" }],
  ] as const)("a plan with %s is not reported and its project is blocked", async (_case, tasks, dropped) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor({ ...tasks }, { ...dropped });

    const outcomes = await reports.runPending();

    expect(blocked).toEqual([{ errorClass: "PlanReportUnfounded", reason: expect.stringMatching(/^PlanReportUnfounded: /) }]);
    expect(outcomes).toEqual([{ kind: "project-blocked", projectId, cause: blocked[0] }]);
    expect(posted).toHaveLength(0);
  });
});
