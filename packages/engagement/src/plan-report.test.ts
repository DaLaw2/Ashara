import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "@ashara/shared";
import { PlanReports } from "./plan-report.js";
import type { PlanReportStore } from "./plan-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000010");

function reportsFor(tasks: { decomposition: number; scaffold: number; unrecorded: number }) {
  const posted: string[] = [];
  const blocked: ProjectBlockCause[] = [];
  const store: PlanReportStore = {
    dueReports: async () => [{ subject: "first-plan", projectId, epicTitles: ["Studio sign-up merge"], tasks }],
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
  test("counts only the tasks toward the client's goal and states the generic setup task apart", async () => {
    const { reports, posted } = reportsFor({ decomposition: 6, scaffold: 1, unrecorded: 0 });

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`1 epic ("Studio sign-up merge"), split into 6 tasks for what you asked for.`);
    expect(posted[0]).toContain("Before those, 1 standard setup task prepares the project's basic structure");
    expect(posted[0]).not.toMatch(/7 tasks/);
  });

  test("a plan with a task of unrecorded origin is not reported and its project is blocked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reports, posted, blocked } = reportsFor({ decomposition: 6, scaffold: 0, unrecorded: 1 });

    const outcomes = await reports.runPending();

    expect(blocked).toEqual([{ errorClass: "PlanReportUnfounded", reason: expect.stringMatching(/^PlanReportUnfounded: /) }]);
    expect(outcomes).toEqual([{ kind: "project-blocked", projectId, cause: blocked[0] }]);
    expect(posted).toHaveLength(0);
  });
});
