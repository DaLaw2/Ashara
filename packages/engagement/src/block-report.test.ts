import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause, StoredBlockedReason } from "@ashara/shared";
import { BlockReports } from "./block-report.js";
import type { BlockReportStore } from "./block-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000020");

type Due = Awaited<ReturnType<BlockReportStore["dueReports"]>>[number];

function reportsFor(due: readonly Due[]) {
  const posted: Array<{ key: string; body: string }> = [];
  const blocked: ProjectBlockCause[] = [];
  const store: BlockReportStore = {
    dueReports: async () => due,
    postProjectReport: async (episodeId, on, body) => {
      posted.push({ key: `${episodeId}:${on}`, body });
      return "posted";
    },
    postTaskReport: async (taskId, body) => {
      posted.push({ key: taskId, body });
      return "posted";
    },
    blockProject: async (_projectId, cause) => {
      blocked.push(cause);
      return "blocked";
    },
  };
  return { reports: new BlockReports(store), posted, blocked };
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

  test("a resumption is told once, on its own episode", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("has resumed") }]);
  });
});

describe("task block reports name the task's exit", () => {
  const cases: Array<{ reason: StoredBlockedReason; exit: string }> = [
    { reason: { source: "owner_unresolved", ownerRoleId: null, rosterRevision: 1, reason: "x" }, exit: "resumes by itself once the project team is changed" },
    { reason: { source: "environment_undefined", reason: "x" }, exit: "resumes by itself once the project's build and test environment is ready" },
    { reason: { source: "environment_unavailable", unavailable: "podman", reason: "x" }, exit: "waiting on its operator" },
    { reason: { source: "environment_change_needed", paths: ["environment/x"], reason: "x" }, exit: "waiting on its operator" },
    { reason: { source: "checks_stale", checkTaskId: "c", reason: "x" }, exit: "waiting on its operator" },
    { reason: { source: "checks_rewrite_bound", checkTaskId: "c", revision: 2, bound: 2, reason: "x" }, exit: "waiting on its operator" },
    { reason: { source: "dependency_unsatisfiable", blockedBy: ["a"], reason: "x" }, exit: "waiting on its operator" },
    { reason: { source: "api" }, exit: "waiting on its operator" },
  ];

  test.each(cases)("$reason.source", async ({ reason, exit }) => {
    const { reports, posted } = reportsFor([{ subject: "task-blocked", projectId, taskId: "t1", title: "Add the export button", reason, waiting: 0 }]);

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain(`The task "Add the export button" is paused`);
    expect(posted[0].body).toContain(exit);
    expect(posted[0].body).not.toMatch(INTERNAL);
  });
});

describe("a task block report says what waits on the task (third run N10)", () => {
  const reason: StoredBlockedReason = { source: "environment_change_needed", paths: ["main.go"], reason: "x" };

  test("with no open dependent, the rest of the project goes on", async () => {
    const { reports, posted } = reportsFor([{ subject: "task-blocked", projectId, taskId: "t1", title: "Read the file", reason, waiting: 0 }]);
    await reports.runPending();
    expect(posted[0].body).toContain("The rest of the project goes on.");
  });

  test("with open dependents, it says how many wait and never that the rest goes on", async () => {
    const { reports, posted } = reportsFor([{ subject: "task-blocked", projectId, taskId: "t1", title: "Read the file", reason, waiting: 6 }]);
    await reports.runPending();
    expect(posted[0].body).toContain("6 other tasks depend on it, directly or through other tasks, and wait until it goes on.");
    expect(posted[0].body).not.toContain("The rest of the project goes on");
  });

  test("one dependent is named in the singular", async () => {
    const { reports, posted } = reportsFor([{ subject: "task-blocked", projectId, taskId: "t1", title: "Read the file", reason, waiting: 1 }]);
    await reports.runPending();
    expect(posted[0].body).toContain("1 other task depends on it, directly or through other tasks, and waits until it goes on.");
  });
});

test("an unreadable blocked task blocks its project and posts nothing", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const cause: ProjectBlockCause = { category: "fault", errorClass: "WorkItemRowCorrupt", reason: "bad jsonb" };
  const { reports, posted, blocked } = reportsFor([{ subject: "task-blocked-unreadable", projectId, cause }]);

  expect(await reports.runPending()).toEqual([{ kind: "project-blocked", projectId, cause }]);
  expect(posted).toEqual([]);
  expect(blocked).toEqual([cause]);
});
