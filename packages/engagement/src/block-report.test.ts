import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
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

/** Words that would leak Ashara's internals into the client channel. */
const INTERNAL = /[a-z]+_[a-z]+|[A-Z][a-z]+[A-Z][A-Za-z]+|Error|roster|operator_|blocked_reason/;

describe("project block reports", () => {
  test.each(["budget_cap", "configuration", "fault", "planning_stopped"] as const)(
    "%s: one plain report saying work is paused, what the team needs, and that the operator is awaited",
    async (kind) => {
      const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind }]);

      expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, subject: "project-blocked" }]);

      expect(posted).toHaveLength(1);
      expect(posted[0].key).toBe("e1:blocked");
      expect(posted[0].body).not.toMatch(INTERNAL);
      expect(posted[0].body).toContain("waiting on its operator");
    },
  );

  test("the budget cap is named as the budget being reached", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap" }]);
    await reports.runPending();
    expect(posted[0].body).toContain("the budget set for it has been reached");
  });

  test("a resumption after an unblock is told once, on its own episode", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "unblocked" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the team cleared what paused it") }]);
  });
});

// Story s-loop-never-stop-m1 W6: each halt's one report states its observed cause.
describe("halt reports state the observed cause", () => {
  test("an infrastructure halt names the task and its failures, says it is not charged and resumes by itself", async () => {
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "infrastructure", fault: { taskTitle: "Write the lock checks", faults: 4 } },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain(`failed 4 times while working on "Write the lock checks"`);
    expect(posted[0].body).toContain("not charged");
    expect(posted[0].body).toContain("resumes this project by itself");
    expect(posted[0].body).not.toContain("operator");
    expect(posted[0].body).not.toMatch(INTERNAL);
  });

  test("its resumption says the machines work again", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "probe_passed" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the machines Ashara runs the work on work again") }]);
  });

  test("an undeliverable halt names each task given up and why, in plain words", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [
          { title: "Lock the data directory", attempts: 3, cause: "failure_router" },
          { title: "Review the checks", attempts: 1, cause: "suite_review_unresolved" },
          { title: "Compact the log", attempts: 2, cause: "check_disputed" },
        ],
      },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    expect(body).toContain("cannot deliver it as planned");
    expect(body).toContain(`"Lock the data directory" (after 3 attempts: every attempt at it failed)`);
    expect(body).toContain(`"Review the checks" (after 1 attempt: the review of the checks written for the plan kept finding problems in them)`);
    expect(body).toContain(`"Compact the log" (after 2 attempts: its developer and the team could not settle whether a check`);
    expect(body).not.toMatch(INTERNAL);
  });
});
