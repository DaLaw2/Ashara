import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isGoalTask } from "@ashara/db";
import { judgedVerdictSchema, overallOf, type JudgedVerdict } from "./hidden-verdict.js";
import type { PickRecord } from "./pool-selection.js";
import { formatPoolVerdicts, formatRunReport, formatSuiteReviewClaims, formatSuiteReviewJudgements } from "./run-report-format.js";

const TSX = path.join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

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
  return at.map((t) => ({ callSite: "agent-runner", createdAt: new Date(t), agentTurn: true, costUsd: 0.01, inputTokens: null, contextWindowTokens: 200_000 }));
}

function evidence(tasks: readonly Omit<Task, "title" | "status">[]): Evidence {
  return {
    project: { id: "00000000-0000-4000-8000-0000000000a1", name: "p", status: "active" },
    tasks: tasks.map((t) => ({ ...t, title: "t", status: "Completed" })),
    workItems: tasks.map((t) => ({ id: t.taskId, level: "Task", parentId: null, title: "t", status: "Completed", workKind: "implementation", origin: "decomposition", checksFor: null, repairsTaskId: null })),
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
    const text = formatRunReport(evidence([{ taskId: TASK, sessions: [], calls: [{ callSite: "suite-review", createdAt: new Date("2026-10-16T03:18:46.109Z"), agentTurn: false, costUsd: 0.01, inputTokens: null, contextWindowTokens: 200_000 }] }])).text;
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
    return { id: id(n), level: "Task", parentId: parent === null ? null : id(parent), title: `item ${n}`, status: "Completed", workKind: null, origin: null, checksFor: null, repairsTaskId: null, ...fields };
  }
  const goal = (n: number, epic: number) => item(n, epic, { workKind: "implementation", origin: "decomposition", title: `goal ${n}` });
  const check = (n: number, epic: number, of: number) => item(n, epic, { workKind: "check", origin: "check", checksFor: id(of) });
  const repair = (n: number, epic: number, of: number) => item(n, epic, { workKind: "environment", origin: "environment-change", repairsTaskId: id(of) });
  const call = (minute: number, costUsd: number | null, inputTokens: number | null, contextWindowTokens: number | null = 100_000): TaskCall => ({
    callSite: "agent-runner",
    createdAt: T(minute, 30),
    agentTurn: true,
    costUsd,
    inputTokens,
    contextWindowTokens,
  });

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
        `mean input tokens per agent call 1650 (6600 over 4 call(s); 1 without input tokens excluded); ` +
        `peak context utilisation 3.0% (call 2026-10-16T03:12:30.000Z agent-runner) over 4 call(s); 1 call(s) of unknown utilisation excluded`,
    );
    expect(lineOf(text, `Epic ${id(0xe2)} Epic B:`)).toBe(
      `  Epic ${id(0xe2)} Epic B: spend $0.320000 over 2 goal task(s), $0.160000 per goal task; mean input tokens per agent call 2875 (23000 over 8 call(s)); ` +
        `peak context utilisation 9.0% (call 2026-10-16T03:06:30.000Z agent-runner) over 8 call(s)`,
    );
    expect(lineOf(text, `goal task ${id(0x11)}`)).toBe(
      `    goal task ${id(0x11)} [Completed] goal 17: own $0.150000 (first session $0.100000, rework $0.050000); ` +
        `charged $0.240000 (checks $0.200000, repairs $0.040000); total $0.390000`,
    );
    expect(lineOf(text, `goal task ${id(0x12)}`)).toContain("own $0.080000 (first session $0.060000, rework $0.020000); charged $0.130000 (checks $0.120000, repairs $0.010000); total $0.210000");
    expect(lineOf(text, `goal task ${id(0x13)}`)).toContain("own $0.040000 (first session $0.030000, rework $0.010000); charged $0.070000 (checks $0.050000, repairs $0.020000); total $0.110000");
    expect(lineOf(text, "unattributed: $")).toBe(`    unattributed: $0.030000, serving no goal task: ${id(0x50)} environment (sprint0) $0.030000`);
    expect(lineOf(text, "project-level")).toBe("  project-level (llm_calls with no task, in no Epic): spend $0.007000 over 1 call(s)");
    expect(lineOf(text, "run:")).toBe(
      "  run: spend $0.747000 over 3 goal task(s), $0.249000 per goal task; in Epics $0.740000 (charged to goal tasks $0.710000, unattributed $0.030000), project-level $0.007000",
    );

    // Nothing dropped or spread: what is charged plus what is unattributed plus project-level is every llm_calls row's cost.
    const run = lineOf(text, "run:");
    const figure = (label: string) => Number(new RegExp(`${label} \\$([0-9.]+)`).exec(run)?.[1]);
    const overall = costEvidence(workItems, taskCalls).calls.reduce((sum, row) => sum + row.measuredUsd, 0);
    expect(figure("charged to goal tasks") + figure("unattributed") + figure("project-level")).toBeCloseTo(overall, 9);
    expect(figure("spend")).toBeCloseTo(overall, 9);
  });

  // One definition of a goal task (isGoalTask): level 'Task' and origin 'decomposition', whatever
  // its work kind. Built on the two items where a work-kind reading and a level reading disagree.
  test("classifies a goal task by the one definition, the same way completedGoalTasks does, whatever its work kind", () => {
    const unkinded = item(0x14, 0xe1, { workKind: null, origin: "decomposition", title: "goal 20" });
    const storyLevel = item(0x15, 0xe1, { level: "Story", workKind: "implementation", origin: "decomposition", title: "story 21" });
    expect(isGoalTask(unkinded)).toBe(true);
    expect(isGoalTask(storyLevel)).toBe(false);
    const report = formatRunReport(
      costEvidence([...workItems, unkinded, storyLevel], new Map([...taskCalls, [0x14, { sessions: [], calls: [call(40, 0.4, 100)] }], [0x15, { sessions: [], calls: [call(41, 0.3, 100)] }]])),
    );
    expect(lineOf(report.text, `goal task ${id(0x14)}`)).toContain("own $0.400000");
    expect(report.text).not.toContain(`goal task ${id(0x15)}`);
    expect(lineOf(report.text, "unattributed: $")).toContain(`${id(0x15)} implementation (decomposition) $0.300000`);
    expect(lineOf(report.text, `Epic ${id(0xe1)} Epic A:`)).toContain("over 2 goal task(s)");
    expect(report.attributionViolation).toBe(false);
  });

  // A repair's spend follows the link its row records (work_items.repairs_task_id), even to a goal
  // task in another Epic; without the link it is named unattributed, never charged by guess or dropped.
  test("charges an environment change to the goal task its recorded link names, and names it unattributed without one", () => {
    const crossEpic = item(0x34, 0xe1, { workKind: "environment", origin: "environment-change", repairsTaskId: id(0x12) });
    const unlinked = item(0x35, 0xe2, { workKind: "environment", origin: "environment-change", repairsTaskId: null });
    const calls = new Map([...taskCalls, [0x34, { sessions: [], calls: [call(42, 0.25, 100)] }], [0x35, { sessions: [], calls: [call(43, 0.15, 100)] }]]);
    const report = formatRunReport(costEvidence([...workItems, crossEpic, unlinked], calls));
    expect(lineOf(report.text, `goal task ${id(0x12)}`)).toContain("charged $0.380000 (checks $0.120000, repairs $0.260000)");
    expect(lineOf(report.text, `Epic ${id(0xe2)} Epic B:`)).toContain("spend $0.720000 over 2 goal task(s)");
    expect(lineOf(report.text, `Epic ${id(0xe1)} Epic A:`)).toContain("spend $0.420000 over 1 goal task(s)");
    expect(lineOf(report.text, "unattributed: $0.150000")).toContain(`${id(0x35)} environment change with no work_items.repairs_task_id on record (created before the link was recorded) $0.150000`);
    expect(report.attributionViolation).toBe(false);
  });

  // Project-level spend (llm_calls with no task) belongs to no Epic: it is its own line, and the
  // Epics' totals plus that line are the run's total.
  test("prints llm_calls with no task as a project-level line, and the Epics plus that line are the run total", () => {
    const base = costEvidence(workItems, taskCalls);
    const [projectRow, ...taskRows] = base.calls;
    if (projectRow === undefined) throw new Error("fixture has no project-level row");
    const second = { ...projectRow, provider: "deepseek", calls: 2, measuredCalls: 2, measuredUsd: 0.013 };
    const report = formatRunReport({ ...base, calls: [projectRow, second, ...taskRows] });
    expect(lineOf(report.text, "project-level")).toBe("  project-level (llm_calls with no task, in no Epic): spend $0.020000 over 3 call(s)");
    const epics = report.text
      .split("\n")
      .filter((l) => l.startsWith("  Epic "))
      .map((l) => Number(/: spend \$([0-9.]+)/.exec(l)?.[1]));
    const overall = [projectRow, second, ...taskRows].reduce((sum, row) => sum + row.measuredUsd, 0);
    expect(epics.reduce((sum, x) => sum + x, 0) + 0.02).toBeCloseTo(overall, 9);
    expect(lineOf(report.text, "run:")).toContain(`spend $${overall.toFixed(6)} `);
    expect(lineOf(report.text, "run:")).toContain("project-level $0.020000");
    expect(report.attributionViolation).toBe(false);
  });

  test("a check task naming no goal task is unattributed, never charged to one", () => {
    const stray = item(0x24, 0xe1, { workKind: "check", origin: "check", checksFor: id(0x99) });
    const report = formatRunReport(costEvidence([...workItems, stray], new Map([...taskCalls, [0x24, { sessions: [], calls: [call(8, 0.5, 100)] }]])));
    expect(lineOf(report.text, "unattributed: $")).toContain(`${id(0x24)} check task whose checksFor ${id(0x99)} is no goal task of the project $0.500000`);
    expect(lineOf(report.text, "run:")).toContain("charged to goal tasks $0.710000, unattributed $0.530000), project-level $0.007000");
    expect(report.attributionViolation).toBe(false);
  });

  test("a task's calls that no work item of the project accounts for are a VIOLATION, not dropped", () => {
    const report = formatRunReport(costEvidence(workItems.filter((w) => w.id !== id(0x50)), taskCalls));
    expect(report.attributionViolation).toBe(true);
    expect(report.text).toContain(`VIOLATION: the Epics and the project-level line account for 13 of 14 llm_calls row(s) and $0.717000 of $0.747000; task(s) ${id(0x50)} are no work item of the project`);
  });

  // m3-scope C5: each call's input over its model's window, and each Epic's peak. A call with no
  // input tokens reported, or no window recorded, is unknown, never 0%.
  test("prints each call's context utilisation, unknown (never 0%) when its input tokens or window are not on record", () => {
    const calls = [call(10, 0.1, 30_000, 200_000), call(11, 0.1, null, 200_000), call(12, 0.1, 5000, null)];
    const report = formatRunReport(costEvidence(workItems, new Map([...taskCalls, [0x11, { sessions: goalSessions(10), calls }]])));
    const lines = report.text.split("\n");
    const at = lines.findIndex((l) => l === `task ${id(0x11)} [Completed] item 17`);
    const heading = lines.indexOf("  context utilisation per call (input tokens over the model's window):", at);
    expect(lines.slice(heading + 1, heading + 4)).toEqual([
      "    2026-10-16T03:10:30.000Z agent-runner: 15.0% (30000 of 200000 tokens)",
      "    2026-10-16T03:11:30.000Z agent-runner: unknown (no input tokens reported)",
      "    2026-10-16T03:12:30.000Z agent-runner: unknown (no window recorded (a row recorded before windows were, or not recorded yet))",
    ]);
    expect(report.text).not.toMatch(/agent-runner: 0\.0%/);
    expect(lineOf(report.text, `Epic ${id(0xe1)} Epic A:`)).toContain(
      "peak context utilisation 15.0% (call 2026-10-16T03:10:30.000Z agent-runner) over 3 call(s); 3 call(s) of unknown utilisation excluded",
    );
  });

  test("an Epic none of whose calls has a known utilisation prints it unknown, never 0%", () => {
    const unmeasured = new Map([...taskCalls].map(([n, t]) => [n, { sessions: t.sessions, calls: t.calls.map((c) => ({ ...c, inputTokens: null })) }]));
    const report = formatRunReport(costEvidence(workItems, unmeasured));
    expect(lineOf(report.text, `Epic ${id(0xe2)} Epic B:`)).toContain("peak context utilisation unknown (no call of 8 has a known utilisation)");
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
      { reviewTaskId: "r1", checkTaskId: "c1", checkName: "prints-count", outcome: "routed", basis: "two-reviews", firstFinding: first, secondFindings: [{ ...first, missingClause: "a row count" }], firstModel: "a/m", secondModel: "a/m", secondStrength: "same-model", passedOver: [], secondFailure: null },
    ]);
    expect(text).toContain("routed (two-reviews); second review same-model (first a/m, second a/m)");
    expect(text).toContain('first review:  missing "a count": the check asserts a count');
    expect(text).toContain('second review: missing "a row count": the check asserts a count');
  });

  test("states an advisory finding with why it did not act, and a ratchet's finding with no second review", () => {
    const undecided = { kind: "undecided-item" as const, checkTasks: ["c1"], item: "S9", problem: "no check forces data to disk", evidence: "put.sh" };
    const text = formatSuiteReviewJudgements([
      {
        reviewTaskId: "r1",
        checkTaskId: "c1",
        checkName: null,
        outcome: "advisory",
        basis: "second-opinion-disagreed",
        firstFinding: undecided,
        secondFindings: [undecided],
        firstModel: "a/m",
        secondModel: "a/n",
        secondStrength: "same-family-other-model",
        passedOver: [{ strength: "other-family", outcome: "unavailable", reason: "SecondOpinionUnavailable: no other provider" }],
        secondFailure: null,
      },
      { reviewTaskId: "r1", checkTaskId: "c1", checkName: null, outcome: "advisory", basis: "frozen", firstFinding: undecided, secondFindings: [], firstModel: "a/m", secondModel: null, secondStrength: null, passedOver: [], secondFailure: null },
      { reviewTaskId: "r1", checkTaskId: "c2", checkName: null, outcome: "advisory", basis: "second-review-failed", firstFinding: undecided, secondFindings: [], firstModel: "a/m", secondModel: null, secondStrength: null, passedOver: [], secondFailure: "SecondOpinionUnanswered: no answer" },
    ]);
    expect(text).toContain("its undecided-item finding of task c1: advisory (second-opinion-disagreed); second review same-family-other-model (first a/m, second a/n)");
    expect(text).toContain("    passed over other-family (unavailable): SecondOpinionUnavailable: no other provider\n    first review:  undecided S9: no check forces data to disk");
    expect(text).toContain("advisory (frozen); no second review asked");
    expect(text).toContain("advisory (second-review-failed); second review failed (first a/m): SecondOpinionUnanswered: no answer");
    expect(text).not.toContain("no finding on this check task");
  });
});


describe("formatSuiteReviewClaims", () => {
  type Claim = Parameters<typeof formatSuiteReviewClaims>[0][number];
  const finding = { kind: "undecided-item" as const, checkTasks: ["c2"], item: "S4", problem: "no check forces data to disk", evidence: "put.sh" };
  type Answered = Extract<Claim["second"], { kind: "answered" }>;
  const answered = (strength: Answered["strength"], model: string, findings: Answered["findings"] = []): Answered => ({ kind: "answered", model, strength, findings });
  const claims: Claim[] = [
    { reviewTaskId: "r1", basis: "second-opinion-clean", covered: ["c1"], firstModel: "a/m", passedOver: [], unverified: [], second: answered("other-family", "b/n") },
    {
      reviewTaskId: "r2",
      basis: "second-opinion-found",
      covered: ["c1", "c2"],
      firstModel: "a/m",
      passedOver: [{ strength: "other-family", outcome: "unavailable", reason: "SecondOpinionUnavailable: no other provider" }],
      unverified: [{ checkTaskId: "c2", itemId: "S4", itemText: "data survives a restart" }],
      second: answered("same-family-other-model", "a/n", [finding]),
    },
    {
      reviewTaskId: "r3",
      basis: "second-opinion-clean",
      covered: ["c3"],
      firstModel: "a/m",
      passedOver: [
        { strength: "other-family", outcome: "unavailable", reason: "SecondOpinionUnavailable: no other provider" },
        { strength: "same-family-other-model", outcome: "failed", reason: "SecondOpinionUnanswered: unfit answer" },
      ],
      unverified: [],
      second: answered("same-model", "a/m"),
    },
    {
      reviewTaskId: "r4",
      basis: "second-review-failed",
      covered: ["c4"],
      firstModel: "a/m",
      passedOver: [{ strength: "same-model", outcome: "failed", reason: "SecondOpinionUnanswered: no answer" }],
      unverified: [{ checkTaskId: "c4", itemId: "S7", itemText: "a full disk is reported" }],
      second: { kind: "failed", reason: "SecondOpinionUnanswered: no answer at any strength" },
    },
  ];

  test("prints each claim's coverage, basis, second-opinion strength or none with why, passed-over list and unverified items with their reason", () => {
    const text = formatSuiteReviewClaims(claims);
    expect(text).not.toContain("none recorded");
    expect(text).toContain("Suite review claims (4):");
    expect(text).toContain(
      "  review r1, covering check task(s) c1: second-opinion-clean (clean: the second opinion found no problem either); second opinion: other-family, another model family (first a/m, second b/n)\n    unverified: none",
    );
    expect(text).toContain(
      "  review r2, covering check task(s) c1, c2: second-opinion-found (finding: the second opinion found a problem); second opinion: same-family-other-model, another model of the family (first a/m, second a/n)",
    );
    expect(text).toContain("    passed over other-family (unavailable): SecondOpinionUnavailable: no other provider\n    second review: undecided S4: no check forces data to disk");
    expect(text).toContain('    unverified S4 of task c2 "data survives a restart": the second opinion named a problem in it (another model of the family)');
    expect(text).toContain("second opinion: same-model, the same model from another angle (first a/m, second a/m)");
    expect(text).toContain("    passed over same-family-other-model (failed): SecondOpinionUnanswered: unfit answer");
    expect(text).toContain(
      "  review r4, covering check task(s) c4: second-review-failed (unconfirmed: the second opinion failed at every strength); second opinion: none (first a/m): SecondOpinionUnanswered: no answer at any strength",
    );
    expect(text).toContain('    unverified S7 of task c4 "a full disk is reported": no second opinion answered: SecondOpinionUnanswered: no answer at any strength');
  });

  test("states a no-other-family claim, whose second opinion came from the first's provider, as unconfirmed, with its items unverified", () => {
    const sameProvider: Claim = {
      reviewTaskId: "r5",
      basis: "no-other-family",
      covered: ["c5"],
      firstModel: "a/m",
      passedOver: [],
      unverified: [{ checkTaskId: "c5", itemId: "S9", itemText: "put survives a power loss" }],
      second: answered("same-family-other-model", "a/n"),
    };
    const text = formatSuiteReviewClaims([sameProvider]);
    expect(text).toContain(
      "  review r5, covering check task(s) c5: no-other-family (unconfirmed: the second opinion came from the first review's provider (recorded before second-opinion strength was)); second opinion: same-family-other-model, another model of the family (first a/m, second a/n)",
    );
    expect(text).toContain('    unverified S9 of task c5 "put survives a power loss": no second opinion of another provider confirmed it (another model of the family)');
  });

  test("states that no claim is recorded, apart from the judgements", () => {
    expect(formatSuiteReviewClaims([])).toBe("Suite review claims: none recorded");
  });
});

describe("formatPoolVerdicts: Ashara's verdict beside the hidden suite's", () => {
  const PICK: PickRecord = { kind: "pick", run: "pool-1", commit: "0e2adaf9", tender: "T1", seed: "c".repeat(64), reason: "fewest runs (0) among T1, T2; drawn by seed", at: "2026-10-18T00:00:00.000Z" };

  function verdict(guarantees: JudgedVerdict["guarantees"], problems: readonly string[] = []): JudgedVerdict {
    return judgedVerdictSchema.parse({
      tender: "T1",
      suiteDigest: "sha256:aa",
      product: { dir: "/p", digest: "sha256:bb" },
      image: "img",
      suiteArgs: ["--cmd", "{product}/x"],
      timeoutSeconds: 60,
      startedAt: "2026-10-18T00:00:00.000Z",
      endedAt: "2026-10-18T00:01:00.000Z",
      overall: overallOf(guarantees, problems),
      guarantees,
      problems,
      runs: {},
    });
  }
  const allPass = verdict([{ id: "G1", verdict: "pass" }, { id: "G2", verdict: "pass" }]);
  const oneFail = verdict([{ id: "G1", verdict: "pass" }, { id: "G2", verdict: "fail" }, { id: "G3", verdict: "unjudged", reason: "no tool" }]);
  const incomplete = verdict([{ id: "G1", verdict: "unjudged", reason: "suite crashed" }], ["the suite exited 1"]);

  test("Accepted and a hidden pass agree, every guarantee named, the pick's tender and seed printed", () => {
    const { lines, violation } = formatPoolVerdicts("accepted", { hidden: allPass, pick: PICK });
    expect(lines).toEqual([
      `tender pick: T1 seed ${"c".repeat(64)} (fewest runs (0) among T1, T2; drawn by seed; run pool-1, commit 0e2adaf9)`,
      `verdicts: Ashara Accepted | hidden suite T1 seed ${"c".repeat(12)}: PASS 2/2 pass, G1 pass, G2 pass | agree`,
    ]);
    expect(violation).toBe(false);
  });

  test("Accepted over a hidden fail, and over a hidden incomplete, is DISAGREE", () => {
    expect(formatPoolVerdicts("accepted", { hidden: oneFail, pick: PICK }).lines[1]).toBe(
      `verdicts: Ashara Accepted | hidden suite T1 seed ${"c".repeat(12)}: FAIL 1/3 pass, G1 pass, G2 fail, G3 unjudged | DISAGREE`,
    );
    expect(formatPoolVerdicts("accepted", { hidden: incomplete, pick: PICK }).lines[1]).toMatch(/: INCOMPLETE 0\/1 pass, G1 unjudged \| DISAGREE$/);
  });

  test("Ashara halting on what the hidden suite passes is DISAGREE; halting on a hidden fail agrees", () => {
    expect(formatPoolVerdicts("blocked", { hidden: allPass, pick: PICK }).lines[1]).toMatch(/^verdicts: Ashara halted \| .* \| DISAGREE$/);
    expect(formatPoolVerdicts("blocked", { hidden: oneFail, pick: PICK }).lines[1]).toMatch(/^verdicts: Ashara halted \| .* \| agree$/);
  });

  test("no --hidden prints 'hidden suite: not run', never a pass", () => {
    const { lines } = formatPoolVerdicts("accepted", { hidden: null, pick: null });
    expect(lines).toEqual(["tender pick: not recorded (run-report was given no --run)", "verdicts: Ashara Accepted | hidden suite: not run"]);
  });

  test("a verdict for another tender than the pick is a violation", () => {
    const { lines, violation } = formatPoolVerdicts("accepted", { hidden: allPass, pick: { ...PICK, tender: "T2" } });
    expect(violation).toBe(true);
    expect(lines).toContain("VIOLATION: the hidden verdict judges tender T1, the run picked T2");
  });

  test("a verdict file whose overall does not follow from its guarantees fails the schema", () => {
    expect(judgedVerdictSchema.safeParse({ ...oneFail, overall: "pass" }).success).toBe(false);
  });
});

describe("run-report --hidden with a verdict file that fails the schema", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "run-report-hidden-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("exits 1 naming the file, before any database is read", async () => {
    const file = path.join(dir, "verdict.json");
    await writeFile(file, JSON.stringify({ tender: "T1", overall: "pass", guarantees: [{ id: "G1", verdict: "maybe" }] }));
    const result = spawnSync(process.execPath, [TSX, path.join(import.meta.dirname, "run-report.ts"), "00000000-0000-4000-8000-0000000000a1", "--hidden", file], {
      encoding: "utf8",
      // An unreachable database: the report must stop on the verdict file before it connects.
      env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`run-report --hidden ${file}: JSON of an unexpected shape`);
  });
});
