import { describe, expect, test } from "vitest";
import { formatRunReport, formatSuiteReviewJudgements } from "./run-report-format.js";

type Evidence = Parameters<typeof formatRunReport>[0];
type Task = Evidence["tasks"][number];
type Session = Task["sessions"][number];
type TaskCall = Task["calls"][number];

const TASK = "00000000-0000-4000-8000-0000000000b1";
const ATTEMPT: Session["attempt"] = {
  kind: "recorded",
  attempt: { promptDigest: "a".repeat(64), terminal: "finished:done", turns: 6, provider: "anthropic", model: "claude-sonnet-5-5", cell: "environment" },
};

function session(id: number, attempt: Session["attempt"], phase: string, createdAt: string, updatedAt: string): Session {
  return { sessionId: `00000000-0000-4000-8000-00000000000${id}`, phase, environmentVersion: "b".repeat(64), createdAt: new Date(createdAt), updatedAt: new Date(updatedAt), attempt };
}

function agentCalls(...at: readonly string[]): TaskCall[] {
  return at.map((t) => ({ callSite: "agent-runner", createdAt: new Date(t), agentTurn: true }));
}

function evidence(tasks: readonly Omit<Task, "title" | "status">[]): Evidence {
  return {
    project: { id: "00000000-0000-4000-8000-0000000000a1", name: "p", status: "active" },
    tasks: tasks.map((t) => ({ ...t, title: "t", status: "Completed" })),
    calls: tasks.map((t) => ({
      taskId: t.taskId,
      provider: "anthropic",
      calls: t.calls.length,
      measuredCalls: t.calls.length,
      measuredUsd: 0.01,
      unmeasuredEstimateUsd: 0,
      pendingCalls: 0,
      lostCalls: 0,
      zeroCostCalls: 0,
      cacheCountedCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
    })),
  };
}

describe("formatRunReport UNTIED: only an agent call that matches no attempt", () => {
  test("a conflicted task's calls inside its recorded attempt, then a session completed as already delivered: tied", () => {
    // The shape of an implementation task whose merge conflicted and whose next session found it delivered on main.
    const text = formatRunReport(
      evidence([
        {
          taskId: TASK,
          sessions: [
            session(1, ATTEMPT, "Failed", "2026-10-16T03:20:57.196Z", "2026-10-16T03:21:48.743Z"),
            session(2, { kind: "completed-without-attempt", endDetail: "task already delivered on main" }, "Completed", "2026-10-16T03:21:50.260Z", "2026-10-16T03:21:58.000Z"),
          ],
          calls: agentCalls("2026-10-16T03:21:03.931Z", "2026-10-16T03:21:07.090Z", "2026-10-16T03:21:11.029Z", "2026-10-16T03:21:12.525Z", "2026-10-16T03:21:27.886Z", "2026-10-16T03:21:43.574Z"),
        },
      ]),
    ).text;
    expect(text).not.toContain("UNTIED:");
    expect(text).toContain("0 task(s) UNTIED");
  });

  test("a review of the plan's suites, with no dev session, is listed by its site and is not untied", () => {
    const text = formatRunReport(evidence([{ taskId: TASK, sessions: [], calls: [{ callSite: "suite-review", createdAt: new Date("2026-10-16T03:18:46.109Z"), agentTurn: false }] }])).text;
    expect(text).not.toContain("UNTIED:");
    expect(text).toContain("1 call(s) by suite-review: not an attempt's turn");
    expect(text).toContain("0 task(s) UNTIED");
  });

  test("an agent call inside a session closed as a crash orphan is untied, though another session recorded an attempt", () => {
    const text = formatRunReport(
      evidence([
        {
          taskId: TASK,
          sessions: [
            session(1, { kind: "reconciled", by: "startup-reconciler" }, "Failed", "2026-10-16T03:00:00.000Z", "2026-10-16T03:10:00.000Z"),
            session(2, ATTEMPT, "Completed", "2026-10-16T03:10:05.000Z", "2026-10-16T03:11:00.000Z"),
          ],
          calls: agentCalls("2026-10-16T03:00:10.000Z", "2026-10-16T03:10:10.000Z"),
        },
      ]),
    ).text;
    expect(text).toContain("UNTIED: 1 of 2 agent call(s) on this task fall in no session with a recorded attempt (admitted at 2026-10-16T03:00:10.000Z)");
    expect(text).toContain("1 task(s) UNTIED");
  });

  test("an agent call on a task with no dev session is untied", () => {
    const text = formatRunReport(evidence([{ taskId: TASK, sessions: [], calls: agentCalls("2026-10-16T03:00:10.000Z") }])).text;
    expect(text).toContain("UNTIED: 1 of 1 agent call(s)");
    expect(text).toContain("1 task(s) UNTIED");
  });

  // A session not yet terminal may be a crash orphan whose attempt is never recorded: the label
  // says what the rows show, never that the calls will be tied.
  test("an agent call in a session not yet terminal is open, not untied, and never promised a tie", () => {
    const open = session(1, { kind: "open" }, "Preparing", "2026-10-16T03:00:00.000Z", "2026-10-16T03:00:00.000Z");
    const text = formatRunReport(evidence([{ taskId: TASK, sessions: [open], calls: agentCalls("2026-10-16T03:00:10.000Z") }])).text;
    expect(text).not.toContain("UNTIED:");
    expect(text).toContain("open: 1 agent call(s) admitted in a session not yet terminal (in flight, or a crash orphan not yet reconciled)");
    expect(text).not.toMatch(/tied once|will be tied/);
    expect(text).toContain("0 task(s) UNTIED");
  });
});

describe("formatSuiteReviewJudgements", () => {
  test("states both reviews' findings whole, side by side, with what the second review was", () => {
    const first = { kind: "outside-vision" as const, checkTasks: ["c1"], check: "prints-count", judgedItems: ["Monthly totals"], missingClause: "a count", problem: "the check asserts a count", evidence: "line 3" };
    const text = formatSuiteReviewJudgements([
      { reviewTaskId: "r1", checkTaskId: "c1", checkName: "prints-count", outcome: "routed", basis: "two-reviews", firstFinding: first, secondFindings: [{ ...first, missingClause: "a row count" }], firstModel: "a/m", secondModel: "a/m", secondReview: "re-sample", secondFailure: null },
    ]);
    expect(text).toContain("routed (two-reviews); second review re-sample (first a/m, second a/m)");
    expect(text).toContain('first review:  missing "a count": the check asserts a count');
    expect(text).toContain('second review: missing "a row count": the check asserts a count');
  });

  test("states an advisory finding with why it did not act, and a ratchet's finding with no second review", () => {
    const undecided = { kind: "undecided-item" as const, checkTasks: ["c1"], item: "S9", problem: "no check forces data to disk", evidence: "put.sh" };
    const text = formatSuiteReviewJudgements([
      { reviewTaskId: "r1", checkTaskId: "c1", checkName: null, outcome: "advisory", basis: "no-other-family", firstFinding: undecided, secondFindings: [undecided], firstModel: "a/m", secondModel: "a/n", secondReview: "other-model", secondFailure: null },
      { reviewTaskId: "r1", checkTaskId: "c1", checkName: null, outcome: "advisory", basis: "frozen", firstFinding: undecided, secondFindings: [], firstModel: "a/m", secondModel: null, secondReview: null, secondFailure: null },
      { reviewTaskId: "r1", checkTaskId: "c2", checkName: null, outcome: "advisory", basis: "second-review-failed", firstFinding: undecided, secondFindings: [], firstModel: "a/m", secondModel: null, secondReview: null, secondFailure: "NoOtherFamilyAnswered: no answer" },
    ]);
    expect(text).toContain("its undecided-item finding of task c1: advisory (no-other-family); second review other-model (first a/m, second a/n)");
    expect(text).toContain("    first review:  undecided S9: no check forces data to disk");
    expect(text).toContain("advisory (frozen); no second review asked");
    expect(text).toContain("advisory (second-review-failed); second review failed (first a/m): NoOtherFamilyAnswered: no answer");
    expect(text).not.toContain("no finding on this check task");
  });
});

