import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import type { CheckRun } from "@ashara/workplace";
import { targetRepo } from "./host-git.js";
import {
  CheckRecorder,
  harvestCheckFiles,
  formatChecksForBrief,
  formatProjectChecksForCheckAuthor,
  redRunPreview,
  redRunProblem,
  redRunSetProblem,
} from "./task-checks.js";
import type { TaskChecks } from "./task-checks.js";

const run = (exitCode: number | null, timedOut: boolean): CheckRun => ({ name: "c", command: "make check", exitCode, timedOut, output: "x" });

// The 30fb60d5 review (b): a check that timed out on main was kept as "fails on main". ADR-074
// addendum 2 d74 A: one rule for every authoring, on the plan's foundation.
describe("the red-run rule", () => {
  test("a check is rejected only when it reaches no verdict on the foundation", () => {
    expect(redRunProblem(run(1, false))).toBeNull();
    expect(redRunProblem(run(0, false))).toBeNull();
    expect(redRunProblem(run(127, false))).toContain("cannot be run");
    expect(redRunProblem(run(126, false))).toContain("cannot be run");
  });

  test.each([
    [137, true],
    [null, true],
    [1, true],
  ] as const)("exit %s with a timeout is rejected: a timeout proves nothing", (exitCode, timedOut) => {
    expect(redRunProblem(run(exitCode, timedOut))).toContain("timed out on the foundation");
  });

  test("the set holds only with at least one decisive failure on the foundation", () => {
    expect(redRunSetProblem([run(0, false), run(1, false)])).toBeNull();
    expect(redRunSetProblem([run(0, false), run(0, false)])).toContain("no check of the set fails on the foundation");
    expect(redRunSetProblem([run(0, false), run(127, false)])).toContain("no check of the set fails on the foundation");
    expect(redRunSetProblem([run(1, true)])).toContain("no check of the set fails on the foundation");
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
    expect(redRunPreview({ kind: "ran", runs: [syntax] }, 30, "/d")).toEqual({
      kind: "ran",
      run: syntax,
      timeoutSeconds: 30,
      rejection: null,
      holdsAlready: false,
    });
    expect(redRunPreview({ kind: "ran", runs: [run(0, false)] }, 30, "/d")).toMatchObject({ rejection: null, holdsAlready: true });
    expect(redRunPreview({ kind: "ran", runs: [run(1, true)] }, 30, "/d")).toMatchObject({ rejection: expect.stringContaining("timed out"), holdsAlready: false });
    expect(redRunPreview({ kind: "files_refused", detail: "link" }, 30, "/d")).toEqual({
      kind: "files_refused",
      detail: "the check files cannot be placed on the foundation: link",
    });
  });
});

// Fifth run N22: a check run wrote an interpreter cache into the workspace, and the harvest rejected
// every check for it ("not UTF-8 text").
describe("the harvest of a check attempt's files", () => {
  const scratch: string[] = [];
  afterAll(async () => {
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  });

  async function repoWithStart(): Promise<{ readonly dir: string; readonly start: string }> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ashara-harvest-")));
    scratch.push(dir);
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "t");
    await git("config", "user.email", "t@t");
    await writeFile(join(dir, "README"), "product\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "start");
    return { dir, start: (await git("rev-parse", "HEAD")).stdout.trim() };
  }

  test("keeps only the files the author wrote with its file tools; what a command it ran left behind is no check file", async () => {
    const { dir, start } = await repoWithStart();
    await mkdir(join(dir, "checks", "__pycache__"), { recursive: true });
    await writeFile(join(dir, "checks", "run.py"), "print('hi')\n");
    await writeFile(join(dir, "checks", "__pycache__", "run.cpython-311.pyc"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const recorder = new CheckRecorder();
    recorder.fileWritten("./checks/run.py");

    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml"], recorder.writtenFiles());
    expect(harvest).toEqual({ kind: "harvested", files: [{ path: "checks/run.py", content: "print('hi')\n" }] });
  });

  test("a written file of the environment's build context still rejects the whole harvest", async () => {
    const { dir, start } = await repoWithStart();
    await writeFile(join(dir, "manifest.txt"), "dependencies: none\n");
    const recorder = new CheckRecorder();
    recorder.fileWritten("manifest.txt");

    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml", "manifest.txt"], recorder.writtenFiles());
    expect(harvest).toMatchObject({ kind: "rejected", reason: expect.stringContaining("overlap the environment's recipe and inputs") });
  });
});

// Second run D10: an implementer that could not see the check files recreated one.
describe("the implementer's brief of its checks", () => {
  const stored = (files: TaskChecks["files"]): TaskChecks => ({
    checkTaskId: "check-1",
    revision: 1,
    environmentVersion: "v",
    baselineCommit: "b".repeat(40),
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
    baselineCommit: "b".repeat(40),
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
