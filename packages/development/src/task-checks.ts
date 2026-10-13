import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cell, CellSpec, HostRepo } from "@ashara/execution-infra";
import { runHostGit } from "@ashara/execution-infra";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { CheckDefinition, CheckDefinitionPort, CheckDefinitionResult } from "@ashara/workplace";
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

/** Quality's task_checks (migration 036); the composition root supplies it. */
export interface TaskCheckStore {
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

/**
 * A commit of the target index holding the tentative merge (no conflict is left in it), parented
 * on HEAD, reachable from no ref: what the stored checks are checked out on.
 */
export async function tentativeMergeCommit(targetProjectPath: string, taskId: string): Promise<string> {
  const repo = targetRepo(targetProjectPath);
  const { stdout } = await runHostGit(repo, ["write-tree"]);
  const tree = stdout.trim();
  if (!COMMIT_HASH.test(tree)) throw new CheckGitStepFailed(taskId, "write-tree", `printed ${JSON.stringify(stdout)}`);
  return commitOf(repo, taskId, "commit-tree", [
    "-c", "user.name=Ashara Agent", "-c", "user.email=ashara-agent@local",
    "commit-tree", tree, "-p", "HEAD", "-m", `ashara: tentative merge of task ${taskId}, for its checks`,
  ]);
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

/** One check run in a cell. */
export interface CheckRun {
  readonly name: string;
  readonly command: string;
  /** null when the host had to kill the podman client; timedOut is then true. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The end of stdout and stderr together. */
  readonly output: string;
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

/** A stored check file could not be written into the checkout: the checks cannot run there. */
export type CheckoutOutcome =
  | { readonly kind: "ran"; readonly runs: readonly CheckRun[] }
  | { readonly kind: "files_refused"; readonly detail: string };

/**
 * Checks `commit` out into `dir` (a detached worktree of the target that no cell has mounted),
 * writes the check files over it, and runs each check from the root of a fresh cell from `image`
 * that mounts it. The checkout and the cell are removed afterwards. A substrate failure throws.
 */
export async function runChecksOnCheckout(
  cells: CheckCells,
  role: string,
  image: string,
  commit: string,
  dir: string,
  checks: readonly CheckDefinition[],
  files: readonly CheckFile[],
): Promise<CheckoutOutcome> {
  await mkdir(dirname(dir), { recursive: true });
  await runHostGit(targetRepo(cells.targetProjectPath), ["worktree", "add", "--detach", dir, commit]);
  try {
    for (const file of files) {
      try {
        await writeTreeFile(dir, file.path, file.content);
      } catch (err) {
        if (err instanceof TreePathRefused) return { kind: "files_refused", detail: err.message };
        throw err;
      }
    }
    const cell = await cells.createCell({ image, role, hostPath: dir });
    try {
      const runs: CheckRun[] = [];
      for (const check of checks) {
        const result = await cell.exec(["sh", "-c", check.command], { timeoutSeconds: cells.timeoutSeconds });
        runs.push({
          name: check.name,
          command: check.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut || result.exitCode === null,
          output: tailOf(`${result.stdout}${result.stderr}`.trim()),
        });
      }
      return { kind: "ran", runs };
    } finally {
      await cells.teardownCell(cell);
    }
  } finally {
    await cleanupWorkdir(dir, cells.targetProjectPath);
  }
}

/** A check passes: it exited 0 within its time and printed something (an empty pass proves nothing). */
export function checkPassed(run: CheckRun): boolean {
  return run.exitCode === 0 && !run.timedOut && run.output.trim() !== "";
}

/**
 * The red-run rule on a check's run on main: it must fail there, and its command must be one the
 * environment can run. null when it holds.
 */
export function redRunProblem(run: CheckRun): string | null {
  if (run.exitCode === 0 && !run.timedOut) return "it already passes on main, so it cannot tell the task's work from its absence";
  if (run.exitCode !== null && COMMAND_UNRUNNABLE.has(run.exitCode)) {
    return `its command cannot be run in the project environment (exit ${run.exitCode})`;
  }
  return null;
}

export function formatCheckRuns(runs: readonly CheckRun[], verdictOf: (run: CheckRun) => string): string {
  return runs
    .map((run) =>
      [
        `Check ${JSON.stringify(run.name)}: ${verdictOf(run)}`,
        `  command: ${run.command}`,
        `  exit code: ${run.exitCode ?? "none (killed)"}${run.timedOut ? " (timed out)" : ""}`,
        `  output: ${run.output === "" ? "(empty)" : run.output}`,
      ].join("\n"),
    )
    .join("\n");
}

/** The checks as the implementation task's brief states them: what decides the task. */
export function formatChecksForBrief(stored: TaskChecks): string {
  const lines = [
    `## Checks that decide this task`,
    `Another team member wrote these checks before this task started. The task is done only when every one of them`,
    `exits 0 and prints output, run from the project root on your merged work. Their files are put back as written`,
    `whenever they run, so changing them changes nothing.`,
    ...stored.checks.map((check) => `- ${check.name}: \`${check.command}\``),
  ];
  if (stored.files.length > 0) lines.push(`Check files: ${stored.files.map((file) => file.path).join(", ")}`);
  return lines.join("\n");
}
