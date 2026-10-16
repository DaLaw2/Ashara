import { describe, expect, test } from "vitest";
import { formatRunReport } from "./run-report-format.js";

type Evidence = Parameters<typeof formatRunReport>[0];
type Session = Evidence["tasks"][number]["sessions"][number];

const TASK = "00000000-0000-4000-8000-0000000000b1";

function session(id: number, attempt: Session["attempt"], phase: string): Session {
  return { sessionId: `00000000-0000-4000-8000-00000000000${id}`, phase, environmentVersion: null, createdAt: new Date(0), attempt };
}

function evidence(sessions: readonly Session[]): Evidence {
  return {
    project: { id: "00000000-0000-4000-8000-0000000000a1", name: "p", status: "active" },
    tasks: [{ taskId: TASK, title: "t", status: "InProgress", sessions }],
    calls: [
      {
        taskId: TASK,
        provider: "deepseek",
        calls: 2,
        measuredCalls: 2,
        measuredUsd: 0.01,
        unmeasuredEstimateUsd: 0,
        pendingCalls: 0,
        lostCalls: 0,
        zeroCostCalls: 0,
        cacheCountedCalls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
      },
    ],
  };
}

describe("formatRunReport UNTIED", () => {
  test("an in-flight session leaves a task's calls tied", () => {
    const text = formatRunReport(evidence([session(1, { kind: "open" }, "Preparing")])).text;
    expect(text).not.toContain("UNTIED:");
    expect(text).toContain("0 task(s) UNTIED");
    expect(text).toContain("in flight: 1 session(s) not yet terminal");
  });

  test("a session completed without an attempt does not show it made no call, so the task's calls are untied", () => {
    const text = formatRunReport(evidence([session(1, { kind: "completed-without-attempt", endDetail: "already delivered" }, "Completed")])).text;
    expect(text).toContain("UNTIED: 2 llm_calls row(s) on this task and 1 session(s) that ended without a recorded attempt");
    expect(text).toContain("1 task(s) UNTIED");
  });

  test("calls on a task with no dev session, as a review of the plan's suites makes, are untied", () => {
    const text = formatRunReport(evidence([])).text;
    expect(text).toContain("UNTIED: 2 llm_calls row(s) on this task and no dev session");
    expect(text).toContain("1 task(s) UNTIED");
  });

  test("a session closed as a crash orphan leaves the task's calls untied", () => {
    const text = formatRunReport(evidence([session(1, { kind: "reconciled", by: "startup-reconciler" }, "Failed")])).text;
    expect(text).toContain("UNTIED: 2 llm_calls row(s) on this task and 1 session(s) that ended without a recorded attempt");
    expect(text).toContain("1 task(s) UNTIED");
  });
});
