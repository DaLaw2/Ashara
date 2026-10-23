import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { targetRepo } from "@ashara/execution-infra";
import type { Cell } from "@ashara/execution-infra";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import { CHECK_MISSING_EXIT, HELD_SET_RULE, heldSetRuleText, unheldItems } from "@ashara/workplace";
import type { CheckRun, HoldEvidence } from "@ashara/workplace";
import {
  CheckRecorder,
  checkAreaOf,
  harvestCheckFiles,
  formatChecksForBrief,
  formatFoundationForCheckAuthor,
  formatProjectChecksForCheckAuthor,
  productChangeOf,
  redRunPreview,
  redRunProblem,
  redRunSetLine,
  redRunSetVerdict,
  runSuitesOnCheckout,
  setRejected,
} from "./task-checks.js";
import type { CheckCells, TaskChecks } from "./task-checks.js";

const run = (exitCode: number | null, timedOut: boolean): CheckRun => ({ name: "c", command: "make check", exitCode, timedOut, output: "x" });

// One rule for every authoring, on the plan's foundation; a check that
// timed out is never kept as one that fails.
describe("the red-run rule", () => {
  // Any non-zero exit counted as decisive would read "nothing builds"
  // as "the work is missing". Only the check's own verdict exit is decisive.
  test("a check is kept only when it passes or states the behaviour missing by its verdict exit", () => {
    expect(redRunProblem(run(0, false))).toBeNull();
    expect(redRunProblem(run(CHECK_MISSING_EXIT, false))).toBeNull();
    expect(redRunProblem(run(127, false))).toContain("cannot be run");
    expect(redRunProblem(run(126, false))).toContain("cannot be run");
  });

  test.each([1, 2, 101])("exit %s on the foundation is a step of the check failing before its verdict: rejected", (exitCode) => {
    expect(redRunProblem(run(exitCode, false))).toContain(`it exited ${exitCode} on the foundation, not ${CHECK_MISSING_EXIT}`);
  });

  test.each([
    [137, true],
    [null, true],
    [1, true],
  ] as const)("exit %s with a timeout is rejected: a timeout proves nothing", (exitCode, timedOut) => {
    expect(redRunProblem(run(exitCode, timedOut))).toContain("timed out on the foundation");
  });

  const STILL_HOLDS: HoldEvidence = { kind: "still-holds", items: ["G3"] };
  const UNCORRECTED: HoldEvidence = { kind: "uncorrected", items: ["S1"] };
  const unread = notExercised("hold evidence");

  // The records are read only for a set holding whole: any other set is decided by its runs alone.
  test("the set is decisive only with at least one decisive failure on the foundation, and reads no evidence otherwise", async () => {
    expect(await redRunSetVerdict([run(0, false), run(CHECK_MISSING_EXIT, false)], unread)).toEqual({ kind: "decisive" });
    expect(await redRunSetVerdict([run(0, false), run(127, false)], unread)).toEqual({ kind: "unverdicted" });
    // A build that fails on the foundation is not the task's work missing.
    expect(await redRunSetVerdict([run(0, false), run(1, false)], unread)).toEqual({ kind: "unverdicted" });
    expect(await redRunSetVerdict([run(CHECK_MISSING_EXIT, true)], unread)).toEqual({ kind: "unverdicted" });
    expect(await redRunSetVerdict([], unread)).toEqual({ kind: "unverdicted" });
    expect(redRunSetLine({ kind: "unverdicted" })).toContain(heldSetRuleText(HELD_SET_RULE));
  });

  // A correction put the items in scope and they held before it: the set shows they still hold.
  test("a set holding whole on the foundation for items a correction put in scope that held before it is held", async () => {
    expect(await redRunSetVerdict([run(0, false), run(0, false)], async () => STILL_HOLDS)).toEqual({ kind: "held", items: ["G3"] });
  });

  // Every arm but still-holds is a typed reason the set is rejected, stated with the rule it breaks.
  test.each<[string, HoldEvidence, string]>([
    ["a first plan's task", UNCORRECTED, "no client correction a plan revision took in before the task was planned affects S1"],
    ["a task citing no item", { kind: "uncited", taskId: "t-1" }, "task t-1 records no vision item it cites"],
    // A correction that adds a guarantee: nothing delivered it before, so a set passing before any work tests nothing new.
    ["an add-guarantee correction's item", { kind: "undelivered", items: ["G9"] }, "no Completed implementation task's checks decide G9"],
    ["a revision-scoped guarantee never delivered", { kind: "undelivered", items: ["G2"] }, "no Completed implementation task's checks decide G2"],
    ["an amended assumption no earlier check decided", { kind: "assumption-undecided", items: ["A1"] }, "no earlier check decided the amended assumption(s) A1"],
    ["a mix of corrected and uncorrected items", { kind: "partly-corrected", corrected: ["G1"], uncorrected: ["G5"] }, "put G1 in scope, but none affects G5"],
  ])("a set holding whole for %s is rejected for that typed reason", async (_case, evidence, reason) => {
    const set = await redRunSetVerdict([run(0, false), run(0, false)], async () => evidence);
    expect(set).toEqual({ kind: "unheld", evidence });
    expect(setRejected(set)).toBe(true);
    expect(redRunSetLine(set)).toContain(reason);
    expect(redRunSetLine(set)).toContain(heldSetRuleText(HELD_SET_RULE));
  });

  // Identical rejections are counted by reason and items, so two orders of the same items are one rejection.
  test("an unheld rejection's items are sorted, and a task citing none is about no item", () => {
    expect(unheldItems({ kind: "partly-corrected", corrected: ["G5"], uncorrected: ["A1"] })).toEqual(["A1", "G5"]);
    expect(unheldItems({ kind: "undelivered", items: ["G9", "G2"] })).toEqual(["G2", "G9"]);
    expect(unheldItems({ kind: "uncited", taskId: "t-1" })).toEqual([]);
  });
});

// A check broken by its own
// syntax is found when it is defined, not at finish, and can be replaced.
describe("define_check's record", () => {
  test("a check defined again under its name replaces the earlier one in place", () => {
    const recorder = new CheckRecorder(["S1", "A2"]);
    expect(recorder.record({ name: "a", command: "names=(x y); test -f out", decides: ["S1"] })).toEqual({ kind: "recorded", defined: 1, replaced: false });
    expect(recorder.record({ name: "b", command: "test -f other", decides: ["A2", "A2"] })).toEqual({ kind: "recorded", defined: 2, replaced: false });
    expect(recorder.record({ name: "a", command: "test -f out", decides: ["S1"] })).toEqual({ kind: "recorded", defined: 2, replaced: true });
    expect(recorder.checks()).toEqual([
      { name: "a", command: "test -f out", decides: ["S1"] },
      { name: "b", command: "test -f other", decides: ["A2"] },
    ]);
  });

  // Which items are checked is what the stored checks decide, never what a line cites.
  test("a check set that leaves one cited item decided by no check is incomplete, and no check may decide an uncited item", () => {
    const recorder = new CheckRecorder(["S1", "S3", "A1"]);
    recorder.record({ name: "a", command: "test -f out", decides: ["S1", "A1"] });
    expect(recorder.undecided()).toEqual(["S3"]);
    expect(recorder.record({ name: "b", command: "test -f other", decides: ["S9"] })).toEqual({
      kind: "refused",
      reason: expect.stringContaining("decides names [S9], which the task does not cite"),
    });
    // Replacing the only check of an item leaves it undecided again.
    recorder.record({ name: "b", command: "test -f other", decides: ["S3"] });
    expect(recorder.undecided()).toEqual([]);
    recorder.record({ name: "b", command: "test -f other", decides: ["S1"] });
    expect(recorder.undecided()).toEqual(["S3"]);
  });

  test("the red run's preview carries the run and the red-run rule's verdict on it", async () => {
    const syntax = { ...run(2, false), output: 'sh: 1: Syntax error: "(" unexpected' };
    // Hold evidence is read only for a check that passes.
    const unread = notExercised("hold evidence");
    expect(await redRunPreview({ kind: "ran", runs: [syntax] }, 30, "/d", unread)).toEqual({
      kind: "ran",
      run: syntax,
      timeoutSeconds: 30,
      // A check broken by its own syntax never reached its verdict: the author is told so at once.
      rejection: expect.stringContaining(`it exited 2 on the foundation, not ${CHECK_MISSING_EXIT}`),
      holdsAlready: null,
    });
    expect(await redRunPreview({ kind: "ran", runs: [run(CHECK_MISSING_EXIT, false)] }, 30, "/d", unread)).toMatchObject({ rejection: null, holdsAlready: null });
    expect(await redRunPreview({ kind: "ran", runs: [run(1, true)] }, 30, "/d", unread)).toMatchObject({ rejection: expect.stringContaining("timed out"), holdsAlready: null });
    expect(await redRunPreview({ kind: "files_refused", detail: "link" }, 30, "/d", unread)).toEqual({
      kind: "files_refused",
      detail: "the check files cannot be placed on the foundation: link",
    });
    // A passing check carries the records' reading of a set that holds whole: the set rule the task is held to.
    const UNCORRECTED: HoldEvidence = { kind: "uncorrected", items: ["S1"] };
    const STILL_HOLDS: HoldEvidence = { kind: "still-holds", items: ["G3"] };
    expect(await redRunPreview({ kind: "ran", runs: [run(0, false)] }, 30, "/d", async () => UNCORRECTED)).toMatchObject({ rejection: null, holdsAlready: UNCORRECTED });
    expect(await redRunPreview({ kind: "ran", runs: [run(0, false)] }, 30, "/d", async () => STILL_HOLDS)).toMatchObject({ rejection: null, holdsAlready: STILL_HOLDS });
  });
});

// A check run can write an interpreter cache into the workspace, which must not make
// the harvest reject every check ("not UTF-8 text").
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

  const AREA = checkAreaOf("impl-1");

  test("keeps only the files the author wrote with its file tools; what a command it ran left behind is no check file", async () => {
    const { dir, start } = await repoWithStart();
    await mkdir(join(dir, AREA, "__pycache__"), { recursive: true });
    await writeFile(join(dir, AREA, "run.py"), "print('hi')\n");
    await writeFile(join(dir, AREA, "__pycache__", "run.cpython-311.pyc"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const recorder = new CheckRecorder(["S1"]);
    recorder.fileWritten(`./${AREA}run.py`);

    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml"], recorder.writtenFiles(), AREA, recordingLogger());
    expect(harvest).toEqual({ kind: "harvested", files: [{ path: `${AREA}run.py`, content: "print('hi')\n" }], discarded: [] });
  });

  // Product files an author writes beside its checks never reach the stored set.
  test("stores only the files under the author's checks area; product files it wrote beside them are discarded", async () => {
    const { dir, start } = await repoWithStart();
    await mkdir(join(dir, AREA), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "checks", "impl-2"), { recursive: true });
    await writeFile(join(dir, AREA, "run.sh"), "./tool | grep -q ok\n");
    await writeFile(join(dir, "README"), "the author's own product\n");
    await writeFile(join(dir, "src", "main.src"), "an implementation\n");
    await writeFile(join(dir, "checks", "impl-2", "other.sh"), "another task's area\n");
    const recorder = new CheckRecorder(["S1"]);
    for (const path of [`${AREA}run.sh`, "README", "src/main.src", "checks/impl-2/other.sh"]) recorder.fileWritten(path);

    const logger = recordingLogger();
    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml"], recorder.writtenFiles(), AREA, logger);
    expect(harvest).toEqual({
      kind: "harvested",
      files: [{ path: `${AREA}run.sh`, content: "./tool | grep -q ok\n" }],
      discarded: ["README", "checks/impl-2/other.sh", "src/main.src"],
    });
    expect(logger.records.map((r) => [r.level, r.event, r.fields?.["discarded"]])).toEqual([
      ["info", "quality.check-files-discarded", ["README", "checks/impl-2/other.sh", "src/main.src"]],
    ]);
  });

  test("a product file of the environment's build context written outside the area is discarded, not kept", async () => {
    const { dir, start } = await repoWithStart();
    await writeFile(join(dir, "manifest.txt"), "dependencies: none\n");
    const recorder = new CheckRecorder(["S1"]);
    recorder.fileWritten("manifest.txt");

    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml", "manifest.txt"], recorder.writtenFiles(), AREA, recordingLogger());
    expect(harvest).toEqual({ kind: "harvested", files: [], discarded: ["manifest.txt"] });
  });

  test("a file in the area that is also of the environment's build context still rejects the whole harvest", async () => {
    const { dir, start } = await repoWithStart();
    await mkdir(join(dir, AREA), { recursive: true });
    await writeFile(join(dir, AREA, "input.txt"), "read by the image build\n");
    const recorder = new CheckRecorder(["S1"]);
    recorder.fileWritten(`${AREA}input.txt`);

    const harvest = await harvestCheckFiles(targetRepo(dir), "t1", start, ["environment/environment.toml", `${AREA}input.txt`], recorder.writtenFiles(), AREA, recordingLogger());
    expect(harvest).toMatchObject({ kind: "rejected", reason: expect.stringContaining("overlap the environment's recipe and inputs") });
  });
});

// The tracked-file refusal: a check run on a tree whose product files it replaced
// is no verdict on that product. The cell is a stand-in that runs the command on the host checkout.
describe("a check run that changes a tracked file of the checkout", () => {
  const scratch: string[] = [];
  afterAll(async () => {
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  });

  async function target(): Promise<{ readonly root: string; readonly commit: string; readonly cells: CheckCells }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-tracked-")));
    scratch.push(root);
    const project = join(root, "target");
    await mkdir(join(project, "src"), { recursive: true });
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await git("init", "-q", "-b", "main");
    await writeFile(join(project, "src", "main.src"), "foundation\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "foundation");
    const commit = (await git("rev-parse", "HEAD")).stdout.trim();
    const hostCell = (hostPath: string): Cell => ({
      id: "host-stand-in",
      spec: { image: "none", project: "p", task: "t", role: "ci", instance: "test", mount: { hostPath } },
      exec: async (argv) => {
        try {
          const { stdout, stderr } = await promisify(execFile)(argv[0] ?? "sh", argv.slice(1), { cwd: hostPath });
          return { exitCode: 0, stdout, stderr, timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
        } catch (err) {
          const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "number" ? err.code : 1;
          return { exitCode: code, stdout: "", stderr: String(err), timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
        }
      },
      teardown: async () => {},
    });
    const cells: CheckCells = {
      targetProjectPath: project,
      createCell: async (spec) => hostCell(spec.hostPath),
      teardownCell: async () => {},
      timeoutSeconds: 30,
      signal: new AbortController().signal,
    };
    return { root, commit, cells };
  }

  test("a check that rewrites a product file is unrunnable, naming it and the check; nothing after it runs", async () => {
    const { root, commit, cells } = await target();
    const suites = [
      { label: "the author's checks", checks: [
        { name: "replaces the product", command: "cp checks/x/impl.src src/main.src && echo ok" },
        { name: "never runs", command: "echo late" },
      ], files: [{ path: "checks/x/impl.src", content: "the author's implementation\n" }] },
      { label: "a later suite", checks: [{ name: "later", command: "echo later" }], files: [] },
    ];

    const runs = await runSuitesOnCheckout(cells, "ci", "image", commit, join(root, "checkouts", "a"), suites);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.report).toMatchObject({ kind: "product_changed", check: "replaces the product", paths: ["src/main.src"] });
    const error = productChangeOf("task-1", runs);
    expect(error?.name).toBe("CheckRunChangedProduct");
    expect(error?.message).toContain('the author\'s checks: check "replaces the product" changed files the project tracks: src/main.src');
    expect(await redRunPreview(runs[0]?.report ?? { kind: "ran", runs: [] }, 30, "/d", notExercised("hold evidence"))).toMatchObject({ kind: "product_changed", detail: expect.stringContaining("src/main.src") });
  });

  test("check files that would replace a tracked product file are unrunnable before any check runs", async () => {
    const { root, commit, cells } = await target();
    const runs = await runSuitesOnCheckout(cells, "ci", "image", commit, join(root, "checkouts", "b"), [
      { label: "an old set", checks: [{ name: "c", command: "echo ran" }], files: [{ path: "src/main.src", content: "replaced\n" }] },
    ]);
    expect(runs[0]?.report).toEqual({ kind: "product_changed", check: null, paths: ["src/main.src"], runs: [] });
  });

  test("a check that writes only untracked files and its own check files runs to a verdict", async () => {
    const { root, commit, cells } = await target();
    const runs = await runSuitesOnCheckout(cells, "ci", "image", commit, join(root, "checkouts", "c"), [
      { label: "clean", checks: [{ name: "c", command: "mkdir -p build && echo out > build/o && echo out > checks/x/log && echo ran" }], files: [{ path: "checks/x/run.sh", content: "true\n" }] },
    ]);
    expect(runs[0]?.report).toMatchObject({ kind: "ran", runs: [{ name: "c", exitCode: 0 }] });
    expect(productChangeOf("task-1", runs)).toBeNull();
  });
});

// The brief never names the foundation's commit, which the cell's one-commit repository never holds.
describe("the check author's foundation and checks directory", () => {
  test("names the foundation by its task and the author's checks directory, never a commit", () => {
    const text = formatFoundationForCheckAuthor({ taskId: "env-task" }, checkAreaOf("impl-1"));
    expect(text).toContain("the merge of task env-task");
    expect(text).toContain("under checks/impl-1/ and nowhere else");
    expect(text).not.toMatch(/commit [0-9a-f]{7,}/);
  });
});

// An implementer that cannot see the check files may recreate one.
describe("the implementer's brief of its checks", () => {
  const stored = (files: TaskChecks["files"]): TaskChecks => ({
    checkTaskId: "check-1",
    revision: 1,
    environmentVersion: "v",
    baselineCommit: "b".repeat(40),
    checks: [{ name: "greets", command: "sh checks/greet.sh", decides: ["S1"] }],
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

// Independent check authors can fix incompatible output formats for the same line.
describe("the check author's brief of the project's stored checks", () => {
  const task = (taskId: string, title: string, files: TaskChecks["files"]) => ({
    taskId,
    title,
    checkTaskId: `check-of-${taskId}`,
    revision: 1,
    environmentVersion: "v",
    baselineCommit: "b".repeat(40),
    checks: [{ name: `${taskId}-check`, command: `sh checks/${taskId}.sh`, decides: ["S1"] as const }],
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
