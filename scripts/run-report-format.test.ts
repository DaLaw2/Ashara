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
  return at.map((t) => ({ callSite: "agent-runner", createdAt: new Date(t), agentTurn: true, costUsd: 0.01, inputTokens: null }));
}

function evidence(tasks: readonly Omit<Task, "title" | "status">[]): Evidence {
  return {
    project: { id: "00000000-0000-4000-8000-0000000000a1", name: "p", status: "active" },
    tasks: tasks.map((t) => ({ ...t, title: "t", status: "Completed" })),
    workItems: tasks.map((t) => ({ id: t.taskId, level: "Task", parentId: null, title: "t", status: "Completed", workKind: "implementation", origin: "decomposition", checksFor: null, dependents: [] })),
    calls: tasks.map((t) => ({
      taskId: t.taskId,
      provider: "anthropic",
      calls: t.calls.length,
      measuredCalls: t.calls.length,
      measuredUsd: 0.01 * t.calls.length,
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
    const text = formatRunReport(evidence([{ taskId: TASK, sessions: [], calls: [{ callSite: "suite-review", createdAt: new Date("2026-10-16T03:18:46.109Z"), agentTurn: false, costUsd: 0.01, inputTokens: null }] }])).text;
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

describe("formatRunReport cost per Epic and goal task", () => {
  type WorkItem = Evidence["workItems"][number];
  const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const T = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 16, 3, minute, second));

  function item(n: number, parent: number | null, fields: Partial<WorkItem>): WorkItem {
    return { id: id(n), level: "Task", parentId: parent === null ? null : id(parent), title: `item ${n}`, status: "Completed", workKind: null, origin: null, checksFor: null, dependents: [], ...fields };
  }
  const goal = (n: number, epic: number) => item(n, epic, { workKind: "implementation", origin: "decomposition", title: `goal ${n}` });
  const check = (n: number, epic: number, of: number) => item(n, epic, { workKind: "check", origin: "check", checksFor: id(of) });
  const repair = (n: number, epic: number, of: number) => item(n, epic, { workKind: "environment", origin: "environment-change", dependents: [id(of)] });
  const call = (minute: number, costUsd: number | null, inputTokens: number | null): TaskCall => ({ callSite: "agent-runner", createdAt: T(minute, 30), agentTurn: true, costUsd, inputTokens });

  // A goal task's first session runs from minute m, its rework session from minute m + 2.
  function goalSessions(m: number): Session[] {
    return [
      session(1, ATTEMPT, "Failed", T(m).toISOString(), T(m + 1).toISOString()),
      session(2, ATTEMPT, "Completed", T(m + 2).toISOString(), T(m + 3).toISOString()),
    ];
  }

  // Two Epics; every goal task has a check task, a rework attempt and an environment change (its
  // repair); Sprint 0 serves no goal task, and one call has no task.
  const workItems: WorkItem[] = [
    item(0xe1, null, { level: "Epic", title: "Epic A" }),
    item(0xe2, null, { level: "Epic", title: "Epic B" }),
    item(0x50, 0xe1, { workKind: "environment", origin: "sprint0" }),
    goal(0x11, 0xe1), check(0x21, 0xe1, 0x11), repair(0x31, 0xe1, 0x11),
    goal(0x12, 0xe2), check(0x22, 0xe2, 0x12), repair(0x32, 0xe2, 0x12),
    goal(0x13, 0xe2), check(0x23, 0xe2, 0x13), repair(0x33, 0xe2, 0x13),
  ];
  const taskCalls: ReadonlyMap<number, { sessions: Session[]; calls: TaskCall[] }> = new Map([
    [0x50, { sessions: [], calls: [call(0, 0.03, 600)] }],
    [0x11, { sessions: goalSessions(10), calls: [call(10, 0.1, 1000), call(12, 0.05, 3000)] }],
    [0x21, { sessions: [], calls: [call(5, 0.2, 2000)] }],
    [0x31, { sessions: [], calls: [call(11, 0.04, null)] }],
    [0x12, { sessions: goalSessions(20), calls: [call(20, 0.06, 4000), call(22, 0.02, 2000)] }],
    [0x22, { sessions: [], calls: [call(6, 0.12, 9000)] }],
    [0x32, { sessions: [], calls: [call(21, 0.01, 1000)] }],
    [0x13, { sessions: goalSessions(30), calls: [call(30, 0.03, 1000), call(32, 0.01, 1000)] }],
    [0x23, { sessions: [], calls: [call(7, 0.05, 3000)] }],
    [0x33, { sessions: [], calls: [call(31, 0.02, 2000)] }],
  ]);
  const PROJECT_CALL_USD = 0.007;

  function costEvidence(items: readonly WorkItem[], perTask: ReadonlyMap<number, { sessions: Session[]; calls: TaskCall[] }>): Evidence {
    const tasks = [...perTask.entries()].map(([n, t]) => ({ taskId: id(n), title: `item ${n}`, status: "Completed", sessions: t.sessions, calls: t.calls }));
    const totals = (taskId: string | null, calls: readonly TaskCall[]) => ({
      taskId,
      provider: "anthropic",
      calls: calls.length,
      measuredCalls: calls.filter((c) => c.costUsd !== null).length,
      measuredUsd: calls.reduce((sum, c) => sum + (c.costUsd === null ? 0 : c.costUsd), 0),
      unmeasuredEstimateUsd: 0,
      pendingCalls: 0,
      lostCalls: 0,
      zeroCostCalls: 0,
      cacheCountedCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
    });
    return {
      project: { id: id(0xa1), name: "p", status: "active" },
      tasks,
      workItems: [...items],
      calls: [totals(null, [call(0, PROJECT_CALL_USD, 500)]), ...tasks.map((t) => totals(t.taskId, t.calls))],
    };
  }

  const lineOf = (text: string, start: string) => {
    const line = text.split("\n").find((l) => l.trimStart().startsWith(start));
    if (line === undefined) throw new Error(`no line starting "${start}" in:\n${text}`);
    return line;
  };

  test("charges check, rework and repair spend to the goal task each serves, per Epic, with C5's mean input tokens", () => {
    const report = formatRunReport(costEvidence(workItems, taskCalls));
    const text = report.text;
    expect(report.attributionViolation).toBe(false);
    expect(lineOf(text, `Epic ${id(0xe1)} Epic A:`)).toBe(
      `  Epic ${id(0xe1)} Epic A: spend $0.420000 over 1 goal task(s), $0.420000 per goal task; ` +
        `mean input tokens per agent call 1650 (6600 over 4 call(s); 1 without input tokens excluded)`,
    );
    expect(lineOf(text, `Epic ${id(0xe2)} Epic B:`)).toBe(
      `  Epic ${id(0xe2)} Epic B: spend $0.320000 over 2 goal task(s), $0.160000 per goal task; mean input tokens per agent call 2875 (23000 over 8 call(s))`,
    );
    expect(lineOf(text, `goal task ${id(0x11)}`)).toBe(
      `    goal task ${id(0x11)} [Completed] goal 17: own $0.150000 (first session $0.100000, rework $0.050000); ` +
        `charged $0.240000 (checks $0.200000, repairs $0.040000); total $0.390000`,
    );
    expect(lineOf(text, `goal task ${id(0x12)}`)).toContain("own $0.080000 (first session $0.060000, rework $0.020000); charged $0.130000 (checks $0.120000, repairs $0.010000); total $0.210000");
    expect(lineOf(text, `goal task ${id(0x13)}`)).toContain("own $0.040000 (first session $0.030000, rework $0.010000); charged $0.070000 (checks $0.050000, repairs $0.020000); total $0.110000");
    expect(lineOf(text, "unattributed: $")).toBe(`    unattributed: $0.030000, serving no goal task: ${id(0x50)} environment (sprint0) $0.030000`);
    expect(lineOf(text, "unattributed: project calls")).toBe("  unattributed: project calls (no task): $0.007000");
    expect(lineOf(text, "run:")).toBe("  run: spend $0.747000 over 3 goal task(s), $0.249000 per goal task; charged to goal tasks $0.710000, unattributed $0.037000");

    // Nothing dropped or spread: what is charged plus what is unattributed is every llm_calls row's cost.
    const run = lineOf(text, "run:");
    const figure = (label: string) => Number(new RegExp(`${label} \\$([0-9.]+)`).exec(run)?.[1]);
    const overall = costEvidence(workItems, taskCalls).calls.reduce((sum, row) => sum + row.measuredUsd, 0);
    expect(figure("charged to goal tasks") + figure("unattributed")).toBeCloseTo(overall, 9);
    expect(figure("spend")).toBeCloseTo(overall, 9);
  });

  test("a check task naming no goal task is unattributed, never charged to one", () => {
    const stray = item(0x24, 0xe1, { workKind: "check", origin: "check", checksFor: id(0x99) });
    const report = formatRunReport(costEvidence([...workItems, stray], new Map([...taskCalls, [0x24, { sessions: [], calls: [call(8, 0.5, 100)] }]])));
    expect(lineOf(report.text, "unattributed: $")).toContain(`${id(0x24)} check task whose checksFor ${id(0x99)} is no goal task of the project $0.500000`);
    expect(lineOf(report.text, "run:")).toContain("charged to goal tasks $0.710000, unattributed $0.537000");
    expect(report.attributionViolation).toBe(false);
  });

  test("a task's calls that no work item of the project accounts for are a VIOLATION, not dropped", () => {
    const report = formatRunReport(costEvidence(workItems.filter((w) => w.id !== id(0x50)), taskCalls));
    expect(report.attributionViolation).toBe(true);
    expect(report.text).toContain(`VIOLATION: the attribution accounts for 13 of 14 llm_calls row(s) and $0.717000 of $0.747000; task(s) ${id(0x50)} are no work item of the project`);
  });

  test("an unmeasured call is counted apart, never read as $0 spend", () => {
    const report = formatRunReport(costEvidence(workItems, new Map([...taskCalls, [0x21, { sessions: [], calls: [call(5, 0.2, 2000), call(5, null, 2000)] }]])));
    expect(lineOf(report.text, `goal task ${id(0x11)}`)).toContain("charged $0.240000 (1 of 3 call(s) unmeasured, not in this figure)");
    expect(lineOf(report.text, "run:")).toContain("spend $0.747000 (1 of 15 call(s) unmeasured, not in this figure)");
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

