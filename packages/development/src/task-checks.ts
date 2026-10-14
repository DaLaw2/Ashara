import { mkdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type { Cell, CellSpec, HostRepo } from "@ashara/execution-infra";
import { runHostGit } from "@ashara/execution-infra";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { CHECK_RUNNER, describeProductChange } from "@ashara/workplace";
import type { CheckDefinition, CheckRedRunPreview, CheckRun, CheckRunReport, ProductChangedReport } from "@ashara/workplace";
import { freshWorktreeRepo, targetRepo } from "./host-git.js";
import { TreePathRefused, readTreeFile, writeTreeFile } from "./tree-read.js";
import { cleanupWorkdir } from "./workspace.js";

// Independent verification (story s-independent-verify-m1, ADR-074 addendum 2 d63): the check
// author writes an implementation task's checks in its check task, before the implementation
// starts. Z0 keeps a set of checks only if it fails on the plan revision's foundation (the red-run
// rule, d74 A: a fixed commit, never today's main), stores it in Quality's task_checks, and decides
// the implementation task by running the stored checks, with their stored files written over
// whatever the implementer left at those paths, on a throwaway checkout of its tentative merge.
// Nothing a check runs is on the host: every command runs in a cell.

const MAX_CHECKS = 50;
const MAX_CHECK_FILES = 200;
const MAX_CHECK_FILE_BYTES = 256 * 1024;
const MAX_CHECK_FILES_BYTES = 1024 * 1024;
/** Longest end of a check's output kept for the record and the model. */
const MAX_CHECK_OUTPUT_CHARS = 2000;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** `sh` exits 126 for a command it cannot execute and 127 for one it cannot find. */
const COMMAND_UNRUNNABLE = new Set([126, 127]);

export interface CheckFile {
  readonly path: string;
  readonly content: string;
}

/** The latest revision of an implementation task's checks, as Quality stores them. */
export interface TaskChecks {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly environmentVersion: string;
  /**
   * The commit the revision was red-run on, its plan revision's foundation; null for a revision
   * stored before baselines were recorded (migration 045), which cannot be red-run again.
   */
  readonly baselineCommit: string | null;
  readonly checks: readonly CheckDefinition[];
  readonly files: readonly CheckFile[];
}

/** A check task's foundation: the merged task whose commit its checks are red-run on, or why there is none. */
type CheckFoundation =
  | { readonly kind: "found"; readonly taskId: string; readonly commit: string }
  | { readonly kind: "none"; readonly reason: string };

/** The latest checks of an implementation task already merged: what a later merge must still pass. */
export interface CompletedTaskChecks extends TaskChecks {
  readonly taskId: string;
}

/** The latest checks of one task of the project, with its title, as a check author is shown them. */
interface ProjectTaskChecks extends CompletedTaskChecks {
  readonly title: string;
}

/** A stored check file of a task of the project: its path, and the task whose checks hold it. */
export interface StoredCheckFile {
  readonly taskId: string;
  readonly path: string;
}

/** The Completed implementation tasks of a project, split by whether any check is stored for them. */
interface CompletedTasksChecks {
  /** The latest checks of each task that has them, in the order the tasks completed. */
  readonly checked: readonly CompletedTaskChecks[];
  /**
   * Tasks Completed with no stored check (completed before checks existed): there is nothing of
   * theirs to re-run, so a later merge cannot be checked against them. Named, never dropped.
   */
  readonly unchecked: readonly string[];
}

/** Quality's task_checks (migration 036); the composition root supplies it. */
export interface TaskCheckStore {
  /**
   * The files of the latest checks of every task of the project, whatever its status: the paths
   * only the check author writes, which no implementation task's branch may change.
   */
  checkFilesOf(projectId: ProjectId): Promise<readonly StoredCheckFile[]>;
  /** Every Completed implementation task of the project except `exceptTaskId`, checked or not. */
  completedOf(projectId: ProjectId, exceptTaskId: WorkItemId): Promise<CompletedTasksChecks>;
  /** The implementation tasks that depend on the check task: the tasks its checks decide. */
  checkedTasksOf(checkTaskId: WorkItemId): Promise<readonly string[]>;
  /**
   * The check task's foundation (ADR-074 addendum 2 d74 A): the recorded merge of the product
   * scaffold it depends on, or of its environment task for a plan revision with no scaffold.
   */
  foundationOf(checkTaskId: WorkItemId): Promise<CheckFoundation>;
  /**
   * The latest checks of every other task of the project that has any (Abandoned tasks left out),
   * with its title: what a check author must not contradict.
   */
  storedOfProject(projectId: ProjectId, exceptTaskId: string): Promise<readonly ProjectTaskChecks[]>;
  /** Appends one revision of the task's checks; returns the revision. */
  append(write: {
    readonly projectId: ProjectId;
    readonly taskId: string;
    readonly checkTaskId: WorkItemId;
    readonly environmentVersion: string;
    readonly baselineCommit: string;
    readonly checks: readonly CheckDefinition[];
    readonly files: readonly CheckFile[];
  }): Promise<number>;
  /** The task's latest revision, or null when no check was ever stored for it. */
  latest(taskId: WorkItemId): Promise<TaskChecks | null>;
}

/** What recording one definition did: refused, or kept as the last definition of its name. */
type CheckRecording =
  | { readonly kind: "recorded"; readonly defined: number; readonly replaced: boolean }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * define_check's record: keeps each definition of one attempt for Z0 to harvest. A definition
 * with the name of an earlier one replaces it in place (the last definition of a name wins). It
 * also keeps the paths the author wrote with its file tools: only those are its submission, never
 * a file a command it ran left behind (fifth run N22).
 */
export class CheckRecorder {
  private readonly defined: CheckDefinition[] = [];
  private readonly written = new Set<string>();

  /** `path` as the file tool was given it; kept as the repository-relative path git reports. */
  fileWritten(path: string): void {
    this.written.add(posix.normalize(path).replace(/^(?:\.\/)+/, ""));
  }

  writtenFiles(): ReadonlySet<string> {
    return new Set(this.written);
  }

  record(check: CheckDefinition): CheckRecording {
    const earlier = this.defined.findIndex((d) => d.name === check.name);
    if (earlier !== -1) {
      this.defined[earlier] = check;
      return { kind: "recorded", defined: this.defined.length, replaced: true };
    }
    if (this.defined.length >= MAX_CHECKS) return { kind: "refused", reason: `a task has at most ${MAX_CHECKS} checks` };
    this.defined.push(check);
    return { kind: "recorded", defined: this.defined.length, replaced: false };
  }

  checks(): readonly CheckDefinition[] {
    return [...this.defined];
  }
}

/**
 * A task's stored checks were red-run on another environment version than the dispatch's, and on
 * the dispatch's image the set no longer holds the red-run rule on its baseline (or has no baseline
 * on record to be red-run on): they cannot decide the task until the check task writes them again
 * on the current environment.
 */
export class StoredChecksStale extends Error {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly storedVersion: string;
  /** For the operator: the message names no commit, since it becomes the reopened check attempt's brief. */
  readonly baselineCommit: string | null;

  constructor(
    readonly taskId: string,
    stored: TaskChecks,
    /** The dispatch's environment version; null on the BaseCell. */
    readonly currentVersion: string | null,
    /** Why the red run on the current version rejects them. */
    readonly redRun: string,
  ) {
    super(
      `the checks of task ${taskId} (revision ${stored.revision}, check task ${stored.checkTaskId}) were red-run on ` +
        `environment version ${stored.environmentVersion}, but this dispatch runs on ` +
        `${currentVersion === null ? "the BaseCell" : `environment version ${currentVersion}`}, where they no longer ` +
        `hold the red-run rule on the plan's foundation they were red-run on; the check task must ` +
        `write them again on the current environment:\n${redRun}`,
    );
    this.name = "StoredChecksStale";
    this.checkTaskId = stored.checkTaskId;
    this.revision = stored.revision;
    this.storedVersion = stored.environmentVersion;
    this.baselineCommit = stored.baselineCommit;
  }
}

/** A git step of the check flow printed something that is not what it must print. */
class CheckGitStepFailed extends Error {
  constructor(
    readonly taskId: string,
    readonly step: string,
    readonly detail: string,
  ) {
    super(`checks of task ${taskId}: ${step} failed: ${detail}`);
    this.name = "CheckGitStepFailed";
  }
}

/** A run of one suite reported none: no verdict exists for it. */
class SuiteRunMissing extends Error {
  constructor(readonly checkoutDir: string) {
    super(`the checks run on checkout ${checkoutDir} reported no suite`);
    this.name = "SuiteRunMissing";
  }
}

async function commitOf(repo: HostRepo, taskId: string, step: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runHostGit(repo, args);
  const line = stdout.trim();
  if (!COMMIT_HASH.test(line)) throw new CheckGitStepFailed(taskId, step, `printed ${JSON.stringify(stdout)}`);
  return line;
}

/**
 * The directory a check author writes its check files in: `checks/<id>/`, the id of the task its
 * checks decide. Only paths under it are a check set's files (eighth run E1, simulator B1): any
 * other file the author writes, the product's source included, is never kept nor placed under a
 * check run. It names a directory, never a language's file.
 */
export function checkAreaOf(checkedTaskId: string): string {
  return `checks/${checkedTaskId}/`;
}

/** The throwaway branch a check task's attempt works on; it is never merged. */
export function checkBranchName(taskId: string): string {
  return `check/${taskId}`;
}

/** A throwaway branch left by an attempt that never reached its discard is deleted before the next starts. */
export async function dropCheckBranch(targetProjectPath: string, branch: string): Promise<void> {
  const repo = targetRepo(targetProjectPath);
  const listed = await runHostGit(repo, ["branch", "--list", branch]);
  if (listed.stdout.trim() !== "") await runHostGit(repo, ["branch", "-D", branch]);
}

/** Removes a check attempt's worktree and its branch: nothing of a check task is merged. */
export async function discardCheckWorkdir(workDir: string, targetProjectPath: string, branch: string): Promise<void> {
  await cleanupWorkdir(workDir, targetProjectPath);
  try {
    await dropCheckBranch(targetProjectPath, branch);
  } catch (err) {
    console.warn(`[checks] the throwaway branch ${branch} could not be deleted; the next attempt deletes it:`, err);
  }
}

/** The commit a worktree's HEAD names, read before any cell mounted it. */
export function headCommit(repo: HostRepo, taskId: string): Promise<string> {
  return commitOf(repo, taskId, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
}

/** The target's main commit. */
export function mainCommit(targetProjectPath: string, taskId: string): Promise<string> {
  return commitOf(targetRepo(targetProjectPath), taskId, "rev-parse main", ["rev-parse", "--verify", "--end-of-options", "main^{commit}"]);
}

/** A commit of `repo`'s index, parented on its HEAD and reachable from no ref. */
async function commitIndex(repo: HostRepo, taskId: string, message: string): Promise<string> {
  const { stdout } = await runHostGit(repo, ["write-tree"]);
  const tree = stdout.trim();
  if (!COMMIT_HASH.test(tree)) throw new CheckGitStepFailed(taskId, "write-tree", `printed ${JSON.stringify(stdout)}`);
  return commitOf(repo, taskId, "commit-tree", [
    "-c", "user.name=Ashara Agent", "-c", "user.email=ashara-agent@local",
    "commit-tree", tree, "-p", "HEAD", "-m", message,
  ]);
}

/**
 * A commit of the target index holding the tentative merge (no conflict is left in it), parented
 * on HEAD, reachable from no ref: what the stored checks are checked out on.
 */
export function tentativeMergeCommit(targetProjectPath: string, taskId: string): Promise<string> {
  return commitIndex(targetRepo(targetProjectPath), taskId, `ashara: tentative merge of task ${taskId}, for its checks`);
}

/**
 * A commit of everything in a worktree now (what `git add -A` stages), parented on its HEAD and
 * reachable from no ref: the implementer's current work, for run_checks to check out elsewhere.
 * The worktree's files are not touched; only its index is.
 */
export async function worktreeSnapshotCommit(repo: HostRepo, taskId: string, purpose: "run_checks" | "define_check"): Promise<string> {
  await runHostGit(repo, ["add", "-A"]);
  return commitIndex(repo, taskId, `ashara: current work of task ${taskId}, for ${purpose}`);
}

export type CheckHarvest =
  | {
      readonly kind: "harvested";
      readonly files: readonly CheckFile[];
      /** Paths the author wrote outside its checks area: discarded, never stored nor run on. */
      readonly discarded: readonly string[];
    }
  /** The check task's work cannot be kept; `reason` is told to the task's failure record. */
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The files a check attempt wrote: everything in its worktree is committed to the throwaway branch,
 * the branch is diffed against the commit it started from (hardened git), and of the paths it
 * changed only those the author wrote with its file tools (`written`) are its submission; whatever
 * else changed was left by a command it ran and is no check file (fifth run N22). Of the submission
 * only the paths under `area` (checkAreaOf) are check files; the rest are discarded, logged and
 * returned, never kept (eighth run E1). Each file is read through the safe tree reader. A deletion,
 * a link, a file of the environment's build context (`buildContext`), a file too large or not UTF-8
 * text, all within the area, rejects the whole harvest.
 */
export async function harvestCheckFiles(
  repo: HostRepo,
  taskId: string,
  startCommit: string,
  buildContext: readonly string[],
  written: ReadonlySet<string>,
  area: string,
): Promise<CheckHarvest> {
  await runHostGit(repo, ["add", "-A"]);
  await runHostGit(repo, ["commit", "--allow-empty", "-q", "-m", `ashara: checks of task ${taskId}`]);
  return collectCheckFiles(repo, taskId, startCommit, "HEAD", buildContext, written, area);
}

/**
 * The files a check attempt has added or changed so far, by the harvest's own rules, without
 * touching its branch: a snapshot of the worktree (reachable from no ref) is diffed instead of a
 * commit. What define_check red-runs one check with, so the author meets the harvest's verdict early.
 */
export async function previewCheckFiles(
  repo: HostRepo,
  taskId: string,
  startCommit: string,
  buildContext: readonly string[],
  written: ReadonlySet<string>,
  area: string,
): Promise<CheckHarvest> {
  const snapshot = await worktreeSnapshotCommit(repo, taskId, "define_check");
  return collectCheckFiles(repo, taskId, startCommit, snapshot, buildContext, written, area);
}

/** The harvest's rules on the diff from `startCommit` to `endCommit`, each file read from the worktree. */
async function collectCheckFiles(
  repo: HostRepo,
  taskId: string,
  startCommit: string,
  endCommit: string,
  buildContext: readonly string[],
  written: ReadonlySet<string>,
  area: string,
): Promise<CheckHarvest> {
  const rejected = (reason: string): CheckHarvest => ({ kind: "rejected", reason });
  const { stdout } = await runHostGit(repo, ["diff", "--name-status", "-z", "--no-renames", startCommit, endCommit]);
  const fields = stdout.split("\0").filter((field) => field !== "");
  const changed: Array<{ readonly status: string; readonly path: string }> = [];
  const discarded: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1] ?? "";
    if (!written.has(path)) continue;
    if (path.startsWith(area)) changed.push({ status: fields[i] ?? "", path });
    else discarded.push(path);
  }
  if (discarded.length > 0) {
    console.warn(`[checks] check task ${taskId}: discarded ${discarded.length} file(s) written outside its checks area ${area}: ${discarded.join(", ")}`);
  }

  const deleted = changed.filter((c) => c.status !== "A" && c.status !== "M");
  if (deleted.length > 0) {
    return rejected(`a check may only add or change files; these were deleted or changed in kind: ${deleted.map((c) => `${c.path} (${c.status})`).join(", ")}`);
  }
  const contextHit = changed.filter((c) => buildContext.includes(c.path));
  if (contextHit.length > 0) {
    return rejected(
      `check files overlap the environment's recipe and inputs [${buildContext.join(", ")}]: ${contextHit.map((c) => c.path).join(", ")}`,
    );
  }
  if (changed.length > MAX_CHECK_FILES) return rejected(`${changed.length} check files; at most ${MAX_CHECK_FILES} are kept`);

  const files: CheckFile[] = [];
  let total = 0;
  for (const { path } of changed) {
    let read;
    try {
      read = await readTreeFile(repo.workTree, path, MAX_CHECK_FILE_BYTES);
    } catch (err) {
      if (err instanceof TreePathRefused) return rejected(`check file ${path} cannot be kept: ${err.message}`);
      throw err;
    }
    if (read.kind === "absent") return rejected(`check file ${path} is in the branch's diff but not in its worktree`);
    if (read.truncated) return rejected(`check file ${path} is larger than ${MAX_CHECK_FILE_BYTES} bytes`);
    if (read.text.includes("�")) return rejected(`check file ${path} is not UTF-8 text`);
    total += Buffer.byteLength(read.text, "utf8");
    if (total > MAX_CHECK_FILES_BYTES) return rejected(`the check files exceed ${MAX_CHECK_FILES_BYTES} bytes together`);
    files.push({ path, content: read.text });
  }
  return { kind: "harvested", files, discarded };
}

function tailOf(text: string): string {
  return text.length <= MAX_CHECK_OUTPUT_CHARS ? text : text.slice(-MAX_CHECK_OUTPUT_CHARS);
}

/** What running checks needs: cells mounting a host tree, and their bounds. */
export interface CheckCells {
  readonly targetProjectPath: string;
  readonly createCell: (spec: Pick<CellSpec, "image" | "role"> & { readonly hostPath: string }) => Promise<Cell>;
  readonly teardownCell: (cell: Cell) => Promise<void>;
  readonly timeoutSeconds: number;
}

/** One named set of checks run on a checkout: its files are written over it just before they run. */
export interface CheckSuite {
  /** Names the suite in the verdict, e.g. which task's checks these are. */
  readonly label: string;
  readonly checks: readonly CheckDefinition[];
  readonly files: readonly CheckFile[];
}

export interface SuiteRun {
  readonly suite: CheckSuite;
  readonly report: CheckRunReport;
}

/**
 * Checks `commit` out into `dir` (a detached worktree of the target that no cell has mounted) and
 * runs the suites in order, sequentially, in one cell from `image` that mounts it, started when the
 * first suite's files are in place. Before each suite its files are written over the checkout; a
 * suite whose files cannot be written is reported `files_refused` and the next one still runs. An
 * earlier suite's files and whatever its commands wrote stay in the checkout. A file `commit`
 * tracks may never change (L9's tracked-file refusal, eighth run E1): after the files are written
 * and after each check, hardened host git compares the checkout with `commit`, and the first
 * suite that changed one is reported `product_changed`, naming the files and the check; no later
 * check or suite runs on that tree, so the returned list then ends early. Each check is bounded
 * by `cells.timeoutSeconds`, so the run is bounded by that times the number of checks, plus the
 * cell's start and teardown. The checkout and the cell are removed afterwards. A substrate failure throws.
 */
export async function runSuitesOnCheckout(
  cells: CheckCells,
  role: string,
  image: string,
  commit: string,
  dir: string,
  suites: readonly CheckSuite[],
): Promise<readonly SuiteRun[]> {
  await mkdir(dirname(dir), { recursive: true });
  await runHostGit(targetRepo(cells.targetProjectPath), ["worktree", "add", "--detach", dir, commit]);
  let cell: Cell | null = null;
  try {
    // Read before any cell mounts the checkout: its gitlink is then never re-read.
    const repo = await freshWorktreeRepo(cells.targetProjectPath, dir);
    const unchanged = new Set(await changedTrackedPaths(repo));
    const changedSinceCheckout = async (): Promise<string[]> => (await changedTrackedPaths(repo)).filter((path) => !unchanged.has(path));
    const reports: SuiteRun[] = [];
    for (const suite of suites) {
      const refused = await writeCheckFiles(dir, suite.files);
      if (refused !== null) {
        reports.push({ suite, report: { kind: "files_refused", detail: refused } });
        continue;
      }
      const replaced = await changedSinceCheckout();
      if (replaced.length > 0) {
        reports.push({ suite, report: { kind: "product_changed", check: null, paths: replaced, runs: [] } });
        return reports;
      }
      cell ??= await cells.createCell({ image, role, hostPath: dir });
      const runs: CheckRun[] = [];
      for (const check of suite.checks) {
        const result = await cell.exec(["sh", "-c", check.command], { timeoutSeconds: cells.timeoutSeconds });
        runs.push({
          name: check.name,
          command: check.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: tailOf(`${result.stdout}${result.stderr}`.trim()),
        });
        const changed = await changedSinceCheckout();
        if (changed.length > 0) {
          reports.push({ suite, report: { kind: "product_changed", check: check.name, paths: changed, runs } });
          return reports;
        }
      }
      reports.push({ suite, report: { kind: "ran", runs } });
    }
    return reports;
  } finally {
    try {
      if (cell !== null) await cells.teardownCell(cell);
    } finally {
      await cleanupWorkdir(dir, cells.targetProjectPath);
    }
  }
}

/** The paths the checkout's commit tracks that are now modified, deleted or changed in kind. */
async function changedTrackedPaths(repo: HostRepo): Promise<string[]> {
  const { stdout } = await runHostGit(repo, ["status", "--porcelain", "-z", "--untracked-files=no", "--no-renames"]);
  // Each record is "XY <path>"; --no-renames keeps every record to one path.
  return stdout.split("\0").filter((record) => record !== "").map((record) => record.slice(3));
}

/**
 * A run of the checks on Z0's own checkout (the post-merge run, the run on main) changed files the
 * checked-out commit tracks: the product they judge is no longer the one checked out, so the run
 * is no verdict on it, neither a pass nor a failure of the task's work (eighth run E1, L9).
 */
class CheckRunChangedProduct extends Error {
  readonly check: string | null;
  readonly paths: readonly string[];

  constructor(
    readonly taskId: string,
    /** The suite whose files or check changed them, as the run labels it. */
    readonly suite: string,
    report: ProductChangedReport,
  ) {
    // Names no commit: its message reaches a later brief through the block's reason, and a cell's
    // repository holds no commit of the target (eighth run E5); the caller's event carries it.
    super(`checks of task ${taskId}: ${suite}: ${describeProductChange(report)}`);
    this.name = "CheckRunChangedProduct";
    this.check = report.check;
    this.paths = report.paths;
  }
}

/** The first suite run that changed the checkout's tracked files, as a typed error; null when none did. */
export function productChangeOf(taskId: string, runs: readonly SuiteRun[]): CheckRunChangedProduct | null {
  for (const run of runs) {
    if (run.report.kind === "product_changed") return new CheckRunChangedProduct(taskId, run.suite.label, run.report);
  }
  return null;
}

/** Writes the files over the checkout; the refusal's message when one cannot be placed, else null. */
async function writeCheckFiles(dir: string, files: readonly CheckFile[]): Promise<string | null> {
  for (const file of files) {
    try {
      await writeTreeFile(dir, file.path, file.content);
    } catch (err) {
      if (err instanceof TreePathRefused) return err.message;
      throw err;
    }
  }
  return null;
}

/** One suite of checks on a fresh checkout of `commit`, as runSuitesOnCheckout runs it. */
export async function runChecksOnCheckout(
  cells: CheckCells,
  role: string,
  image: string,
  commit: string,
  dir: string,
  checks: readonly CheckDefinition[],
  files: readonly CheckFile[],
): Promise<CheckRunReport> {
  const [only] = await runSuitesOnCheckout(cells, role, image, commit, dir, [{ label: "checks", checks, files }]);
  if (only === undefined) throw new SuiteRunMissing(dir);
  return only.report;
}

/**
 * The red-run rule on one check's run on the foundation (ADR-074 addendum 2 d74 A): it must run to
 * a verdict there, an exit within its time limit by a command the environment can run. A timeout
 * proves nothing: the same check could time out on the task's work too. A check that passes on the
 * foundation is kept: it guards behaviour that already holds, and the set rule (redRunSetProblem)
 * is what proves the set can tell the task's work from its absence. null when it holds.
 */
export function redRunProblem(run: CheckRun): string | null {
  if (run.timedOut) {
    return "it timed out on the foundation instead of exiting there; a check must exit within its time limit";
  }
  if (run.exitCode === null) return "it was killed on the foundation without an exit code, so it reached no verdict there";
  if (COMMAND_UNRUNNABLE.has(run.exitCode)) {
    return `its command cannot be run in the project environment (exit ${run.exitCode})`;
  }
  return null;
}

/** Whether a check's run on the foundation is a decisive failure there. */
function failsDecisively(run: CheckRun): boolean {
  return run.exitCode !== 0 && redRunProblem(run) === null;
}

/**
 * The red run's verdict on the whole set, beyond each check's own: at least one check must fail
 * on the foundation decisively, for the reason the task's work is missing there. null when it holds.
 */
export function redRunSetProblem(runs: readonly CheckRun[]): string | null {
  if (runs.some(failsDecisively)) return null;
  return "no check of the set fails on the foundation; at least one must fail there, for the reason the task's work is missing";
}

/** One check's line in a red run's report. */
export function redRunVerdict(run: CheckRun): string {
  const problem = redRunProblem(run);
  if (problem !== null) return `REJECTED: ${problem}`;
  return failsDecisively(run) ? "fails on the foundation" : "passes on the foundation: kept, as a guard of behaviour that already holds";
}

/** define_check's red run of its one check on the foundation, as the author is shown it. */
export function redRunPreview(report: CheckRunReport, timeoutSeconds: number, checkoutDir: string): CheckRedRunPreview {
  if (report.kind === "files_refused") {
    return { kind: "files_refused", detail: `the check files cannot be placed on the foundation: ${report.detail}` };
  }
  if (report.kind === "product_changed") return { kind: "product_changed", detail: `on the foundation, ${describeProductChange(report)}` };
  const [run] = report.runs;
  if (run === undefined) throw new SuiteRunMissing(checkoutDir);
  const rejection = redRunProblem(run);
  return { kind: "ran", run, timeoutSeconds, rejection, holdsAlready: rejection === null && !failsDecisively(run) };
}

/**
 * Where a check task's checks are red-run and where its files go, as its brief states it: the
 * foundation, never today's main, named by the task whose merge it is. Its commit is not named: the
 * cell's repository is a throwaway one of a single commit, which never holds it (eighth run E5).
 */
export function formatFoundationForCheckAuthor(foundation: { readonly taskId: string }, area: string): string {
  return [
    `## Red run on the foundation`,
    `Your checks are red-run on the foundation of this plan: the project as the merge of task ${foundation.taskId} left`,
    `it, which every task of the plan builds on, before any of them did its work. It is not in your workspace, and the`,
    `workspace's own repository holds no other version of the project: only define_check's red run shows how a check`,
    `does there. Your workspace shows the project as it is now, which other tasks may already have changed; the red`,
    `run does not use it.`,
    ``,
    `## Your checks directory`,
    `Write every file your checks need under ${area} and nowhere else. Only files you write there are kept and`,
    `written over the foundation for the red run; any other file you write, the product's source included, is`,
    `discarded. A check must not change a file the project tracks when it runs.`,
  ].join("\n");
}

/** The checks as the implementation task's brief states them: what decides the task. */
export function formatChecksForBrief(stored: TaskChecks): string {
  const lines = [
    `## Checks that decide this task`,
    `Another team member wrote these checks before this task started. The task is done only when every one of them`,
    `exits 0 and prints output on your merged work. ${CHECK_RUNNER}`,
    `Call run_checks to run them on your current work before you finish: it reports each check's exit code and output`,
    `exactly as verification would.`,
    `Verification on the merge also runs the environment's test and the checks of every task already merged:`,
    `if your work breaks any of them, this task fails as a regression and nothing is merged. Any of these checks that`,
    `cannot pass on correct work, an already merged task's included, may be disputed with dispute_check: for an`,
    `already merged task's check, give that task's id as the verification failure names it.`,
    ...stored.checks.map((check) => `- ${check.name}: \`${check.command}\``),
  ];
  if (stored.files.length > 0) lines.push("", checkFilesForBrief(stored.files));
  return lines.join("\n");
}

/** Longest part of one check file the implementer's brief shows, and of all of them together. */
const MAX_BRIEF_CHECK_FILE_CHARS = 8000;
const MAX_BRIEF_CHECK_FILES_CHARS = 24000;

/**
 * The stored check files, read-only: the implementer must see what the checks read to satisfy them
 * (second run D10: one that could not see them recreated one, which the ownership gate refuses).
 * A cut is always marked, never silent.
 */
function checkFilesForBrief(files: readonly CheckFile[]): string {
  const lines = [
    `### Check files (read-only)`,
    `These files are the checks' own and are not in your workspace; run_checks puts them in place for its run. At`,
    `verification they are written over the merge exactly as stored, whatever`,
    `is at their paths. Do not create, change or delete a file at any of these paths: the ownership gate refuses work`,
    `that touches one, and the task fails.`,
  ];
  const budget = { left: MAX_BRIEF_CHECK_FILES_CHARS };
  lines.push(...checkFileLines(files, budget, "####"));
  return lines.join("\n");
}

/** The files, each cut to what is left of the shared `budget` (which it spends); every cut is marked. */
function checkFileLines(files: readonly CheckFile[], budget: { left: number }, heading: string): string[] {
  const lines: string[] = [];
  for (const file of files) {
    const limit = Math.min(MAX_BRIEF_CHECK_FILE_CHARS, budget.left);
    if (limit <= 0) {
      lines.push(`${heading} ${file.path} (${file.content.length} characters)`, `[not shown: the check files exceed ${MAX_BRIEF_CHECK_FILES_CHARS} characters together; it is not in your workspace]`);
      continue;
    }
    const shown = file.content.length <= limit ? file.content : file.content.slice(0, limit);
    budget.left -= shown.length;
    lines.push(`${heading} ${file.path} (${file.content.length} characters)`, "````", shown, "````");
    if (shown.length < file.content.length) {
      lines.push(`[truncated: ${file.content.length - shown.length} of ${file.content.length} characters not shown]`);
    }
  }
  return lines;
}

/**
 * Every check already stored in the project, as the check author's brief states them (third run
 * N8): independent authors fixed incompatible output formats for the same line, and nothing showed
 * one author the other's checks. The rule is stated; a contradiction that still slips through is
 * disputed by the implementer that meets it. Files share one size cap, every cut marked.
 */
export function formatProjectChecksForCheckAuthor(stored: readonly ProjectTaskChecks[]): string {
  const lines = [
    `## Checks already stored in this project`,
    `Every check below runs on the same product as yours once all its tasks are merged: a task whose work breaks an`,
    `earlier task's checks is refused as a regression. Your checks must not contradict them: where they fix an output,`,
    `its format, a file or a name, require the same. Do not create or change a file at any of their paths.`,
  ];
  if (stored.length === 0) return [...lines, ``, `None: no other task of this project has stored checks yet.`].join("\n");
  const budget = { left: MAX_BRIEF_CHECK_FILES_CHARS };
  for (const task of stored) {
    lines.push(``, `### Task "${task.title}" (${task.taskId})`, ...task.checks.map((check) => `- ${check.name}: \`${check.command}\``));
    lines.push(...checkFileLines(task.files, budget, "####"));
  }
  return lines.join("\n");
}
