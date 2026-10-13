import { describe, expect, test } from "vitest";
import type { CheckRun } from "@ashara/workplace";
import { CheckRecorder, formatChecksForBrief, formatProjectChecksForCheckAuthor, redRunPreview, redRunProblem } from "./task-checks.js";
import type { TaskChecks } from "./task-checks.js";

const run = (exitCode: number | null, timedOut: boolean): CheckRun => ({ name: "c", command: "make check", exitCode, timedOut, output: "x" });

// The 30fb60d5 review (b): a check that timed out on main was kept as "fails on main".
describe("the red-run rule", () => {
  test("a check fails on main only by a non-zero exit within its time limit", () => {
    expect(redRunProblem(run(1, false))).toBeNull();
    expect(redRunProblem(run(0, false))).toContain("already passes on main");
    expect(redRunProblem(run(127, false))).toContain("cannot be run");
  });

  test.each([
    [137, true],
    [null, true],
    [1, true],
  ] as const)("exit %s with a timeout is rejected: a timeout proves nothing", (exitCode, timedOut) => {
    expect(redRunProblem(run(exitCode, timedOut))).toContain("timed out on main");
  });
});

// Second run N1/N5 (docs/investigations/second-run-2026-10-14.md): a check broken by its own
// syntax was only found at finish, and could not be replaced.
describe("define_check's record", () => {
  test("a check defined again under its name replaces the earlier one in place", () => {
    const recorder = new CheckRecorder();
    expect(recorder.record({ name: "a", command: "names=(x y); test -f out" })).toEqual({ kind: "recorded", defined: 1, replaced: false });
    expect(recorder.record({ name: "b", command: "test -f other" })).toEqual({ kind: "recorded", defined: 2, replaced: false });
    expect(recorder.record({ name: "a", command: "test -f out" })).toEqual({ kind: "recorded", defined: 2, replaced: true });
    expect(recorder.checks()).toEqual([
      { name: "a", command: "test -f out" },
      { name: "b", command: "test -f other" },
    ]);
  });

  test("the red run's preview carries the run and the red-run rule's verdict on it", () => {
    const syntax = { ...run(2, false), output: 'sh: 1: Syntax error: "(" unexpected' };
    expect(redRunPreview({ kind: "ran", runs: [syntax] }, 30, "/d")).toEqual({ kind: "ran", run: syntax, timeoutSeconds: 30, rejection: null });
    expect(redRunPreview({ kind: "ran", runs: [run(0, false)] }, 30, "/d")).toMatchObject({ rejection: expect.stringContaining("already passes") });
    expect(redRunPreview({ kind: "files_refused", detail: "link" }, 30, "/d")).toEqual({
      kind: "files_refused",
      detail: "the check files cannot be placed on main: link",
    });
  });
});

// Second run D10: an implementer that could not see the check files recreated one.
describe("the implementer's brief of its checks", () => {
  const stored = (files: TaskChecks["files"]): TaskChecks => ({
    checkTaskId: "check-1",
    revision: 1,
    environmentVersion: "v",
    checks: [{ name: "greets", command: "sh checks/greet.sh" }],
    files,
  });

  test("states the runner and shows every stored check file's content read-only", () => {
    const brief = formatChecksForBrief(stored([{ path: "checks/greet.sh", content: "grep -q hello greet.txt && cat greet.txt\n" }]));
    expect(brief).toContain("`sh -c '<command>'`");
    expect(brief).toContain("from the repository root");
    expect(brief).toContain("- greets: `sh checks/greet.sh`");
    expect(brief).toContain("#### checks/greet.sh");
    expect(brief).toContain("grep -q hello greet.txt && cat greet.txt");
    expect(brief).toContain("the ownership gate refuses work");
  });

  test("check files beyond the brief's caps are cut with an explicit marker, never silently", () => {
    const brief = formatChecksForBrief(
      stored([
        { path: "checks/big.txt", content: "x".repeat(9000) },
        { path: "checks/more.txt", content: "y".repeat(8000) },
        { path: "checks/rest.txt", content: "z".repeat(8000) },
        { path: "checks/last.txt", content: "w" },
      ]),
    );
    expect(brief).toContain("[truncated: 1000 of 9000 characters not shown]");
    expect(brief).toContain("#### checks/last.txt (1 characters)\n[not shown:");
  });
});

// Third run N8: independent check authors fixed incompatible output formats for the same line.
describe("the check author's brief of the project's stored checks", () => {
  const task = (taskId: string, title: string, files: TaskChecks["files"]) => ({
    taskId,
    title,
    checkTaskId: `check-of-${taskId}`,
    revision: 1,
    environmentVersion: "v",
    checks: [{ name: `${taskId}-check`, command: `sh checks/${taskId}.sh` }],
    files,
  });

  test("names every stored check by task, with its command and files, and the rule not to contradict them", () => {
    const brief = formatProjectChecksForCheckAuthor([
      task("t1", "Print month totals", [{ path: "checks/t1.sh", content: "./tool in.csv | grep -qx '2024-01: 12.50'\n" }]),
      task("t2", "Print the grand total", []),
    ]);
    expect(brief).toContain("must not contradict them");
    expect(brief).toContain(`### Task "Print month totals" (t1)`);
    expect(brief).toContain("- t1-check: `sh checks/t1.sh`");
    expect(brief).toContain("#### checks/t1.sh");
    expect(brief).toContain("grep -qx '2024-01: 12.50'");
    expect(brief).toContain(`### Task "Print the grand total" (t2)`);
  });

  test("files share one cap across tasks, every cut marked", () => {
    const brief = formatProjectChecksForCheckAuthor([
      task("t1", "a", [{ path: "checks/a.txt", content: "x".repeat(8000) }, { path: "checks/b.txt", content: "y".repeat(8000) }]),
      task("t2", "b", [{ path: "checks/c.txt", content: "z".repeat(9000) }, { path: "checks/d.txt", content: "w" }]),
    ]);
    expect(brief).toContain("[truncated: 1000 of 9000 characters not shown]");
    expect(brief).toContain("#### checks/d.txt (1 characters)\n[not shown:");
  });

  test("with nothing stored yet it says so", () => {
    expect(formatProjectChecksForCheckAuthor([])).toContain("None: no other task of this project has stored checks yet.");
  });
});
