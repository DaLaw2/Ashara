import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cell, CellSpec, HostRepo } from "@ashara/execution-infra";
import { runHostGit } from "@ashara/execution-infra";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { CheckDefinition, CheckDefinitionPort, CheckDefinitionResult, CheckRun, CheckRunReport } from "@ashara/workplace";
import { targetRepo } from "./host-git.js";
import { TreePathRefused, readTreeFile, writeTreeFile } from "./tree-read.js";
import { cleanupWorkdir } from "./workspace.js";

// Independent verification (story s-independent-verify-m1, ADR-074 addendum 2 d63): the check
// author writes an implementation task's checks in its check task, before the implementation
// starts. Z0 keeps a check only if it fails on the target's main (the red-run rule), stores it in
// Quality's task_checks, and decides the implementation task by running the stored checks, with
// their stored files written over whatever the implementer left at those paths, on a throwaway
// checkout of its tentative merge. Nothing a check runs is on the host: every command runs in a cell.

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
  readonly checks: readonly CheckDefinition[];
  readonly files: readonly CheckFile[];
}

/** The latest checks of an implementation task already merged: what a later merge must still pass. */
export interface CompletedTaskChecks extends TaskChecks {
  readonly taskId: string;
}

/** Quality's task_checks (migration 036); the composition root supplies it. */
export interface TaskCheckStore {
  /**
   * The latest checks of every Completed implementation task of the project except `exceptTaskId`,
   * in the order they completed. A Completed implementation task with no stored check throws:
   * an empty set would read as "nothing to regress".
   */
  completedOf(projectId: ProjectId, exceptTaskId: WorkItemId): Promise<readonly CompletedTaskChecks[]>;
  /** The implementation tasks that depend on the check task: the tasks its checks decide. */
  checkedTasksOf(checkTaskId: WorkItemId): Promise<readonly string[]>;
  /** Appends one revision of the task's checks; returns the revision. */
  append(write: {
    readonly projectId: ProjectId;
    readonly taskId: string;
    readonly checkTaskId: WorkItemId;
    readonly environmentVersion: string;
    readonly checks: readonly CheckDefinition[];
    readonly files: readonly CheckFile[];
  }): Promise<number>;
  /** The task's latest revision, or null when no check was ever stored for it. */
  latest(taskId: WorkItemId): Promise<TaskChecks | null>;
}

/** define_check's port: keeps each definition of one attempt for Z0 to harvest. */
export class CheckRecorder implements CheckDefinitionPort {
  private readonly defined: CheckDefinition[] = [];

  define(check: CheckDefinition): CheckDefinitionResult {
    if (this.defined.some((d) => d.name === check.name)) {
      return { kind: "refused", reason: `a check named ${JSON.stringify(check.name)} is already defined; give each check its own name` };
    }
    if (this.defined.length >= MAX_CHECKS) return { kind: "refused", reason: `a task has at most ${MAX_CHECKS} checks` };
    this.defined.push(check);
    return { kind: "recorded", defined: this.defined.length };
  }

  checks(): readonly CheckDefinition[] {
    return [...this.defined];
  }
}

/**
 * A task's stored checks were red-run on another environment version than the dispatch's, and on
 * the dispatch's they no longer all fail on main: they cannot decide the task until the check task
 * writes them again on the current environment.
 */
export class StoredChecksStale extends Error {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly storedVersion: string;

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
        `all fail on main; the check task must write them again on the current environment:\n${redRun}`,
    );
    this.name = "StoredChecksStale";
    this.checkTaskId = stored.checkTaskId;
    this.revision = stored.revision;
    this.storedVersion = stored.environmentVersion;
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
export async function worktreeSnapshotCommit(repo: HostRepo, taskId: string): Promise<string> {
  await runHostGit(repo, ["add", "-A"]);
  return commitIndex(repo, taskId, `ashara: current work of task ${taskId}, for run_checks`);
}

/** True when the owned entry `owned` contains `path` (itself, or anything under it). */
function covers(owned: string, path: string): boolean {
  return owned.endsWith("/") ? path.startsWith(owned) : path === owned || path.startsWith(`${owned}/`);
}

export type CheckHarvest =
  | { readonly kind: "harvested"; readonly files: readonly CheckFile[] }
  /** The check task's work cannot be kept; `reason` is told to the task's failure record. */
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The files a check attempt added or changed: everything in its worktree is committed to the
 * throwaway branch, the branch is diffed against the commit it started from (hardened git), and
 * each file is read through the safe tree reader. A deletion, a link, a file in the environment's
 * owned paths, a file too large or not UTF-8 text rejects the whole harvest.
 */
export async function harvestCheckFiles(
  repo: HostRepo,
  taskId: string,
  startCommit: string,
  owned: readonly string[],
): Promise<CheckHarvest> {
  const rejected = (reason: string): CheckHarvest => ({ kind: "rejected", reason });
  await runHostGit(repo, ["add", "-A"]);
  await runHostGit(repo, ["commit", "--allow-empty", "-q", "-m", `ashara: checks of task ${taskId}`]);
  const { stdout } = await runHostGit(repo, ["diff", "--name-status", "-z", "--no-renames", startCommit, "HEAD"]);
  const fields = stdout.split("\0").filter((field) => field !== "");
  const changed: Array<{ readonly status: string; readonly path: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changed.push({ status: fields[i] ?? "", path: fields[i + 1] ?? "" });

  const deleted = changed.filter((c) => c.status !== "A" && c.status !== "M");
  if (deleted.length > 0) {
    return rejected(`a check may only add or change files; these were deleted or changed in kind: ${deleted.map((c) => `${c.path} (${c.status})`).join(", ")}`);
  }
  const ownedHit = changed.filter((c) => owned.some((o) => covers(o, c.path)));
  if (ownedHit.length > 0) {
    return rejected(`check files overlap the environment's owned paths [${owned.join(", ")}]: ${ownedHit.map((c) => c.path).join(", ")}`);
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
  return { kind: "harvested", files };
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
 * earlier suite's files and whatever its commands wrote stay in the checkout. Each check is bounded
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
    const reports: SuiteRun[] = [];
    for (const suite of suites) {
      const refused = await writeCheckFiles(dir, suite.files);
      if (refused !== null) {
        reports.push({ suite, report: { kind: "files_refused", detail: refused } });
        continue;
      }
      cell ??= await cells.createCell({ image, role, hostPath: dir });
      const runs: CheckRun[] = [];
      for (const check of suite.checks) {
        const result = await cell.exec(["sh", "-c", check.command], { timeoutSeconds: cells.timeoutSeconds });
        runs.push({
          name: check.name,
          command: check.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut || result.exitCode === null,
          output: tailOf(`${result.stdout}${result.stderr}`.trim()),
        });
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
 * The red-run rule on a check's run on main: it must fail there decisively, by a non-zero exit
 * within its time limit, and its command must be one the environment can run. A timeout proves
 * nothing about main: the same check could time out on the task's work too. null when it holds.
 */
export function redRunProblem(run: CheckRun): string | null {
  if (run.timedOut) {
    return "it timed out on main instead of failing there; a check must fail on main by a non-zero exit within its time limit";
  }
  if (run.exitCode === null) return "it was killed on main without an exit code, so it did not fail there decisively";
  if (run.exitCode === 0) return "it already passes on main, so it cannot tell the task's work from its absence";
  if (COMMAND_UNRUNNABLE.has(run.exitCode)) {
    return `its command cannot be run in the project environment (exit ${run.exitCode})`;
  }
  return null;
}

/** The checks as the implementation task's brief states them: what decides the task. */
export function formatChecksForBrief(stored: TaskChecks): string {
  const lines = [
    `## Checks that decide this task`,
    `Another team member wrote these checks before this task started. The task is done only when every one of them`,
    `exits 0 and prints output, run from the project root on your merged work. Their files are put back as written`,
    `whenever they run, so changing them changes nothing. Call run_checks to run them on your current work before`,
    `you finish: it reports each check's exit code and output exactly as verification would.`,
    `Verification on the merge also runs the environment's test and the checks of every task already merged:`,
    `if your work breaks any of them, this task fails as a regression and nothing is merged.`,
    ...stored.checks.map((check) => `- ${check.name}: \`${check.command}\``),
  ];
  if (stored.files.length > 0) lines.push(`Check files: ${stored.files.map((file) => file.path).join(", ")}`);
  return lines.join("\n");
}
