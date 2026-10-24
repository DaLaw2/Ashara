import { mkdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type { Cell, CellSpec, EnvironmentTestRun, HostRepo } from "@ashara/execution-infra";
import {
  TreePathRefused,
  cleanupWorkdir,
  elidedOutput,
  freshWorktreeRepo,
  readTreeFile,
  runHostGit,
  targetRepo,
  writeTreeFile,
} from "@ashara/execution-infra";
import type { CapabilityLevel } from "@ashara/finance";
import { joinElided, keepEnds, renderElided } from "@ashara/shared";
import type { ElidedText, Logger, ProjectId, WorkItemId } from "@ashara/shared";
import { CHECK_MISSING_EXIT, CHECK_RUNNER, HELD_SET_RULE, heldSetRuleText, unheldReason } from "@ashara/workplace";
import type { CheckDefinition, CheckRedRunPreview, CheckRun, DefinedCheck, FoundationProbe, HoldEvidence, UnheldEvidence } from "@ashara/workplace";
import type { VisionSource } from "./acl/engagement-acl.js";
import { describeProductChange } from "./check-verdict.js";
import type { CheckRunReport, ProductChangedReport } from "./check-verdict.js";

// Independent verification: the check
// author writes an implementation task's checks in its check task, before the implementation
// starts. Z0 keeps a set of checks only by the held-set rule (Workplace's HELD_SET_RULE) on the plan
// revision's foundation (a fixed commit, never today's main), stores it in Quality's task_checks, and decides
// the implementation task by running the stored checks, with their stored files written over
// whatever the implementer left at those paths, on a throwaway checkout of its tentative merge.
// Nothing a check runs is on the host: every command runs in a cell.

const MAX_CHECKS = 50;
const MAX_CHECK_FILES = 200;
const MAX_CHECK_FILE_BYTES = 256 * 1024;
const MAX_CHECK_FILES_BYTES = 1024 * 1024;
/** Most characters of a check's output kept, head and tail, for the record and the model. */
const MAX_CHECK_OUTPUT_CHARS = 2000;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** `sh` exits 126 for a command it cannot execute and 127 for one it cannot find. */
const COMMAND_UNRUNNABLE = new Set([126, 127]);

interface CheckFile {
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
   * stored before baselines were recorded, which cannot be red-run again.
   */
  readonly baselineCommit: string | null;
  readonly checks: readonly StoredCheck[];
  readonly files: readonly CheckFile[];
}

/**
 * One stored check with the ids of the vision items it decides; null for a check
 * stored before they were recorded, which is not evidence that it decides any item.
 */
interface StoredCheck extends CheckDefinition {
  readonly decides: DefinedCheck["decides"] | null;
}

/** A check task's foundation: the merged task whose commit its checks are red-run on, or why there is none. */
export type CheckFoundation =
  | { readonly kind: "found"; readonly taskId: string; readonly commit: string }
  | { readonly kind: "none"; readonly reason: string };

/** The latest checks of one implementation task, with the task they decide: of a task already merged, what a later merge must still pass. */
export interface CompletedTaskChecks extends TaskChecks {
  readonly taskId: string;
}

/** The latest checks of one task of the project, with its title, as a check author is shown them. */
export interface ProjectTaskChecks extends CompletedTaskChecks {
  readonly title: string;
}

/** A stored check file of a task of the project: its path, and the task whose checks hold it. */
export interface StoredCheckFile {
  readonly taskId: string;
  readonly path: string;
}

/** The Completed implementation tasks of a project, split by whether any check is stored for them. */
export interface CompletedTasksChecks {
  /** The latest checks of each task that has them, in the order the tasks completed. */
  readonly checked: readonly CompletedTaskChecks[];
  /**
   * Tasks Completed with no stored check (completed before checks existed): there is nothing of
   * theirs to re-run, so a later merge cannot be checked against them. Named, never dropped.
   */
  readonly unchecked: readonly string[];
}

/** A check task a suite review reads, as stored; nulls are what its row does not record. */
export interface CheckTaskUnderReview {
  readonly id: string;
  readonly status: string;
  /** The implementation task its checks decide (task_spec.checksFor). */
  readonly checksFor: string | null;
  /** The vision items its task cites (task_spec.visionItems). */
  readonly visionItems: readonly string[] | null;
  /** The same items with their ids, status and kind (task_spec.sources); null on rows written before them. */
  readonly sources: readonly VisionSource[] | null;
  /** The title of the task its checks decide. */
  readonly checkedTitle: string | null;
  /** How many reviews have reopened it so far (its suite_review_findings rows). */
  readonly reviewReopens: number;
  /** The grade its task was dispatched at (task_spec.capability); null when the row records none. */
  readonly grade: CapabilityLevel | null;
  /**
   * Every model an attempt on it ran on (dev_sessions.attempt_model), oldest first, each with its catalog
   * grade; null for a model the catalog does not hold under the attempt's provider.
   */
  readonly attemptModels: ReadonlyArray<{ readonly model: string; readonly grade: CapabilityLevel | null }>;
}

/** One problem a suite review routes, with the check tasks whose checks it involves. */
export interface SuiteReviewProblem {
  readonly checkTaskIds: readonly string[];
  readonly kind: "contradiction" | "outside-vision" | "undecided-item" | "breaks-contract";
  readonly problem: string;
  readonly evidence: string;
}

/** The suite review a suite_review block was written on: what it found, and how often it had named the check task. */
export interface BlockingReviewRow {
  /** How many reviews had named the check task past the bound when the project was blocked. */
  readonly times: number;
  /** What the last review found, as it stated each problem. */
  readonly problems: readonly string[];
}

/** One revision of an implementation task's checks, as the check task harvested it. */
export interface NewTaskChecks {
  readonly projectId: ProjectId;
  readonly taskId: string;
  readonly checkTaskId: WorkItemId;
  readonly environmentVersion: string;
  /** The commit the checks were red-run on: their plan revision's foundation. */
  readonly baselineCommit: string;
  readonly checks: readonly DefinedCheck[];
  readonly files: readonly CheckFile[];
}

/** Quality's task_checks; the composition root supplies it. */
export interface TaskCheckStore {
  /**
   * The files of the latest checks of every task of the project, whatever its status: the paths
   * only the check author writes, which no implementation task's branch may change.
   */
  checkFilesOf(projectId: ProjectId): Promise<readonly StoredCheckFile[]>;
  /** Every Completed implementation task of the project except `exceptTaskId` (every one when null), checked or not. */
  completedOf(projectId: ProjectId, exceptTaskId: WorkItemId | null): Promise<CompletedTasksChecks>;
  /** The implementation tasks that depend on the check task: the tasks its checks decide. */
  checkedTasksOf(checkTaskId: WorkItemId): Promise<readonly string[]>;
  /**
   * The check task's foundation: the recorded merge of the product
   * scaffold it depends on, or of its one dependency merged after the scaffold for a plan revision
   * with no scaffold of its own; none for a dependency merged before it.
   */
  foundationOf(checkTaskId: WorkItemId): Promise<CheckFoundation>;
  /**
   * The latest checks of every other task of the project that has any (Abandoned tasks left out),
   * with its title: what a check author must not contradict.
   */
  storedOfProject(projectId: ProjectId, exceptTaskId: string): Promise<readonly ProjectTaskChecks[]>;
  /** Appends one revision of the task's checks; returns the revision. */
  append(write: NewTaskChecks): Promise<number>;
  /** The task's latest revision, or null when no check was ever stored for it. */
  latest(taskId: WorkItemId): Promise<TaskChecks | null>;
  /** What a check set of the implementation task that holds whole on its foundation is evidence of (HoldEvidence). */
  holdEvidenceOf(taskId: WorkItemId): Promise<HoldEvidence>;
  /**
   * Records that a check attempt's set holding whole on its foundation was rejected for `evidence`;
   * returns how many identical rejections (same reason, same items) the records hold for the checked task or a task
   * written before it, this one included; a sibling task of the same plan never counts.
   */
  recordSetRejection(rejection: SetRejection): Promise<number>;
}

/** One rejection of a check set that holds whole on its foundation, as recordSetRejection records it. */
export interface SetRejection {
  readonly projectId: ProjectId;
  readonly checkedTaskId: WorkItemId;
  readonly checkTaskId: WorkItemId;
  readonly attempt: number;
  readonly evidence: UnheldEvidence;
}

/** What recording one definition did: refused, or kept as the last definition of its name. */
type CheckRecording =
  | { readonly kind: "recorded"; readonly defined: number; readonly replaced: boolean }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * define_check's record: keeps each definition of one attempt for Z0 to harvest. A definition
 * with the name of an earlier one replaces it in place (the last definition of a name wins). It
 * also keeps the paths the author wrote with its file tools: only those are its submission, never
 * a file a command it ran left behind. A definition may decide only items its task cites (`cited`,
 * their ids), and the set is complete only when every cited item is decided by one of its checks.
 */
export class CheckRecorder {
  private readonly defined: DefinedCheck[] = [];
  private readonly written = new Set<string>();

  constructor(private readonly cited: CitedItemIds) {}

  /** `path` as the file tool was given it; kept as the repository-relative path git reports. */
  fileWritten(path: string): void {
    this.written.add(posix.normalize(path).replace(/^(?:\.\/)+/, ""));
  }

  writtenFiles(): ReadonlySet<string> {
    return new Set(this.written);
  }

  record(defined: DefinedCheck): CheckRecording {
    const uncited = defined.decides.filter((id) => !this.cited.includes(id));
    if (uncited.length > 0) {
      return {
        kind: "refused",
        reason: `decides names [${uncited.join(", ")}], which the task does not cite; it cites [${this.cited.join(", ")}]`,
      };
    }
    const [first, ...rest] = defined.decides;
    const check: DefinedCheck = { ...defined, decides: [first, ...rest.filter((id, i) => id !== first && rest.indexOf(id) === i)] };
    const earlier = this.defined.findIndex((d) => d.name === check.name);
    if (earlier !== -1) {
      this.defined[earlier] = check;
      return { kind: "recorded", defined: this.defined.length, replaced: true };
    }
    if (this.defined.length >= MAX_CHECKS) return { kind: "refused", reason: `a task has at most ${MAX_CHECKS} checks` };
    this.defined.push(check);
    return { kind: "recorded", defined: this.defined.length, replaced: false };
  }

  checks(): readonly DefinedCheck[] {
    return [...this.defined];
  }

  /** The cited items no check defined so far decides, in the order the task cites them. */
  undecided(): readonly string[] {
    return undecidedItems(this.cited, this.defined);
  }
}

/** The ids of the vision items a check task cites (task_spec.sources), never none. */
export type CitedItemIds = readonly [string, ...string[]];

/**
 * The cited items no check of `checks` decides: a check stored with no record of what it
 * decides decides nothing. Empty only when every cited item has a check whose stored verdict is on it.
 */
function undecidedItems(cited: readonly string[], checks: ReadonlyArray<{ readonly decides: readonly string[] | null }>): string[] {
  // eslint-disable-next-line no-restricted-syntax -- policy default: a check with no record of what it decides decides nothing, so its cited items stay undecided
  const decided = new Set(checks.flatMap((check) => check.decides ?? []));
  return cited.filter((id) => !decided.has(id));
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

/** The environment's build on a red run's foundation, as a record and a brief read it: its command, exit and output's end. */
export function describeFoundationBuild(build: EnvironmentTestRun): string {
  const exit = build.timedOut ? "timed out" : build.exitCode === null ? "killed without an exit code" : `exit code ${build.exitCode}`;
  const output = checkOutput([build.stdout, build.stderr]);
  return `\`${build.command}\`: ${exit}\n${output === "" ? "(no output)" : output}`;
}

/**
 * The environment's build fails on a red run's foundation: every check would fail there
 * because nothing builds, which says nothing about whether it tells the task's work from its
 * absence. The red run is unrunnable, never accepted. Names no commit: its message reaches the plan
 * repair's evidence; the commit goes to the event.
 */
export class FoundationUnbuildable extends Error {
  constructor(
    readonly taskId: string,
    readonly foundationTaskId: string,
    readonly environmentVersion: string,
    readonly build: EnvironmentTestRun,
  ) {
    super(
      `the environment's build (version ${environmentVersion}) fails on the plan's foundation, the merge of task ` +
        `${foundationTaskId}, so no check of task ${taskId} can be red-run there: a check failing on a product that ` +
        `does not build proves nothing about the work it decides. The build: ${describeFoundationBuild(build)}`,
    );
    this.name = "FoundationUnbuildable";
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
 * checks decide. Only paths under it are a check set's files: any
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
export async function discardCheckWorkdir(workDir: string, targetProjectPath: string, branch: string, logger: Logger): Promise<void> {
  await cleanupWorkdir(workDir, targetProjectPath);
  try {
    await dropCheckBranch(targetProjectPath, branch);
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: a check task's throwaway branch is never merged; the next attempt deletes it before it starts, or the settled-branch release
    logger.warn(
      "quality.check-branch-left",
      `the throwaway branch ${branch} could not be deleted and is left in ${targetProjectPath}; the task's next ` +
        `attempt deletes it before it starts, or the settled-branch release once the task is Completed or Abandoned`,
      { branch, targetPath: targetProjectPath },
      err,
    );
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

type CheckHarvest =
  | {
      readonly kind: "harvested";
      readonly files: readonly CheckFile[];
      /** Paths the author wrote outside its checks area: discarded, never stored nor run on. */
      readonly discarded: readonly string[];
    }
  /** The check task's work cannot be kept; `reason` is told to the task's failure record. */
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Whose check files a harvest reads: the attempt's worktree `repo`, the commit it started from, the
 * environment's build context, the paths the author wrote with its file tools, and its checks area.
 */
interface CheckHarvestOf {
  readonly repo: HostRepo;
  readonly taskId: string;
  readonly startCommit: string;
  readonly buildContext: readonly string[];
  readonly written: ReadonlySet<string>;
  readonly area: string;
  readonly logger: Logger;
}

/**
 * The files a check attempt wrote: everything in its worktree is committed to the throwaway branch,
 * the branch is diffed against the commit it started from (hardened git), and of the paths it
 * changed only those the author wrote with its file tools (`written`) are its submission; whatever
 * else changed was left by a command it ran and is no check file. Of the submission
 * only the paths under `area` (checkAreaOf) are check files; the rest are discarded, logged and
 * returned, never kept. Each file is read through the safe tree reader. A deletion,
 * a link, a file of the environment's build context (`buildContext`), a file too large or not UTF-8
 * text, all within the area, rejects the whole harvest.
 */
export async function harvestCheckFiles(harvest: CheckHarvestOf): Promise<CheckHarvest> {
  await runHostGit(harvest.repo, ["add", "-A"]);
  await runHostGit(harvest.repo, ["commit", "--allow-empty", "-q", "-m", `ashara: checks of task ${harvest.taskId}`]);
  return collectCheckFiles(harvest, "HEAD");
}

/**
 * The files a check attempt has added or changed so far, by the harvest's own rules, without
 * touching its branch: a snapshot of the worktree (reachable from no ref) is diffed instead of a
 * commit. What define_check red-runs one check with, so the author meets the harvest's verdict early.
 */
export async function previewCheckFiles(harvest: CheckHarvestOf): Promise<CheckHarvest> {
  const snapshot = await worktreeSnapshotCommit(harvest.repo, harvest.taskId, "define_check");
  return collectCheckFiles(harvest, snapshot);
}

/** The harvest's rules on the diff from `startCommit` to `endCommit`, each file read from the worktree. */
async function collectCheckFiles(
  { repo, taskId, startCommit, buildContext, written, area, logger }: CheckHarvestOf,
  endCommit: string,
): Promise<CheckHarvest> {
  const rejected = (reason: string): CheckHarvest => ({ kind: "rejected", reason });
  const { stdout } = await runHostGit(repo, ["diff", "--name-status", "-z", "--no-renames", startCommit, endCommit]);
  const fields = stdout.split("\0").filter((field) => field !== "");
  const changed: Array<{ readonly status: string; readonly path: string }> = [];
  const discarded: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1];
    if (!written.has(path)) continue;
    if (path.startsWith(area)) changed.push({ status: fields[i], path });
    else discarded.push(path);
  }
  if (discarded.length > 0) {
    logger.info("quality.check-files-discarded", `check task ${taskId}: discarded ${discarded.length} file(s) written outside its checks area ${area}`, {
      taskId,
      area,
      discarded,
    });
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

/** Streams together, their middle cut past MAX_CHECK_OUTPUT_CHARS with the cut counted, as a record and the model read them. */
function checkOutput(streams: readonly ElidedText[]): string {
  return renderElided(keepEnds(joinElided(streams), MAX_CHECK_OUTPUT_CHARS)).trim();
}

/** What running checks needs: cells mounting a host tree, and their bounds. */
export interface CheckCells {
  readonly targetProjectPath: string;
  readonly createCell: (spec: Pick<CellSpec, "image" | "role"> & { readonly hostPath: string }) => Promise<Cell>;
  readonly teardownCell: (cell: Cell) => Promise<void>;
  readonly timeoutSeconds: number;
  /** The process's shutdown: a check it interrupts throws CellExecInterrupted, and is no run, passed or failed. */
  readonly signal: AbortSignal;
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

/** Where checks run: `commit` checked out into `dir`, in one cell of `role` from `image`. */
interface CheckCheckout {
  readonly role: string;
  readonly image: string;
  readonly commit: string;
  readonly dir: string;
}

/**
 * Checks `commit` out into `dir` (a detached worktree of the target that no cell has mounted) and
 * runs the suites in order, sequentially, in one cell from `image` that mounts it, started when the
 * first suite's files are in place. Before each suite its files are written over the checkout; a
 * suite whose files cannot be written is reported `files_refused` and the next one still runs. An
 * earlier suite's files and whatever its commands wrote stay in the checkout. A file `commit`
 * tracks may never change (the tracked-file refusal): after the files are written
 * and after each check, hardened host git compares the checkout with `commit`, and the first
 * suite that changed one is reported `product_changed`, naming the files and the check; no later
 * check or suite runs on that tree, so the returned list then ends early. Each check is bounded
 * by `cells.timeoutSeconds`, so the run is bounded by that times the number of checks, plus the
 * cell's start and teardown. The checkout and the cell are removed afterwards. A substrate failure throws.
 */
export async function runSuitesOnCheckout(
  cells: CheckCells,
  { role, image, commit, dir }: CheckCheckout,
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
        const result = await cell.exec(["sh", "-c", check.command], { timeoutSeconds: cells.timeoutSeconds, signal: cells.signal });
        runs.push({
          name: check.name,
          command: check.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: checkOutput([elidedOutput(result.stdout, result.stdoutCut), elidedOutput(result.stderr, result.stderrCut)]),
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
 * is no verdict on it, neither a pass nor a failure of the task's work.
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
    // repository holds no commit of the target; the caller's event carries it.
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
  checkout: CheckCheckout,
  checks: readonly CheckDefinition[],
  files: readonly CheckFile[],
): Promise<CheckRunReport> {
  const [only] = await runSuitesOnCheckout(cells, checkout, [{ label: "checks", checks, files }]);
  if (only === undefined) throw new SuiteRunMissing(checkout.dir);
  return only.report;
}

/**
 * The red-run rule on one check's run on the foundation: it must run to
 * a verdict there, an exit within its time limit by a command the environment can run, and either
 * pass or fail with the check's own verdict that the behaviour is missing (CHECK_MISSING_EXIT). Any
 * other failure is the check's build, setup or harness failing before its verdict: counting it as
 * decisive would accept "nothing builds" as "the work is missing". A timeout proves nothing:
 * the same check could time out on the task's work too. A check that passes on the foundation is
 * kept: it guards behaviour that already holds, and the set rule (redRunSetVerdict) decides what the
 * set as a whole shows. null when it holds.
 */
export function redRunProblem(run: CheckRun): string | null {
  if (run.timedOut) {
    return "it timed out on the foundation instead of exiting there; a check must exit within its time limit";
  }
  if (run.exitCode === null) return "it was killed on the foundation without an exit code, so it reached no verdict there";
  if (run.exitCode === 0 || run.exitCode === CHECK_MISSING_EXIT) return null;
  if (COMMAND_UNRUNNABLE.has(run.exitCode)) {
    return `its command cannot be run in the project environment (exit ${run.exitCode})`;
  }
  return (
    `it exited ${run.exitCode} on the foundation, not ${CHECK_MISSING_EXIT}, the exit by which a check states the behaviour it ` +
    `checks is missing: a step of its own (a build, setup or harness) failed before its verdict, so it reached none there`
  );
}

/** Whether a check's run on the foundation is a decisive failure there: its own verdict that the behaviour is missing. */
function failsDecisively(run: CheckRun): boolean {
  return run.exitCode === HELD_SET_RULE.decisiveExit && redRunProblem(run) === null;
}

/** The red run's verdict on the whole set by the held-set rule (HELD_SET_RULE), beyond each check's own. */
export type RedRunSetVerdict =
  /** At least one check fails on the foundation decisively: the set tells the task's work from its absence. */
  | { readonly kind: "decisive" }
  /** Every check passes on the foundation and the records show the items it decides held before: they still hold. */
  | { readonly kind: "held"; readonly items: readonly [string, ...string[]] }
  /** No check fails there decisively and not every one passes: some check reached no verdict, or none ran. */
  | { readonly kind: "unverdicted" }
  /** Every check passes there and the records do not show what it decides held before: the typed reason. */
  | { readonly kind: "unheld"; readonly evidence: UnheldEvidence };

/**
 * The red run's verdict on the whole set by the held-set rule: decisive when at least one check
 * fails on the foundation decisively, for the reason the task's work is missing there. Only a set
 * whose every check passes there reads `evidenceOf`, which decides it held or unheld from the
 * records; any other set reaches no verdict as a whole.
 */
export async function redRunSetVerdict(runs: readonly CheckRun[], evidenceOf: () => Promise<HoldEvidence>): Promise<RedRunSetVerdict> {
  if (runs.some(failsDecisively)) return { kind: "decisive" };
  const holdsWhole = runs.length > 0 && runs.every((run) => run.exitCode === 0 && redRunProblem(run) === null);
  if (!holdsWhole) return { kind: "unverdicted" };
  const evidence = await evidenceOf();
  if (evidence.kind === "still-holds") return { kind: "held", items: evidence.items };
  return { kind: "unheld", evidence };
}

/** Whether the set as a whole is rejected: it neither tells the task's work from its absence nor shows its items held. */
export function setRejected(set: RedRunSetVerdict): set is Extract<RedRunSetVerdict, { readonly kind: "unverdicted" | "unheld" }> {
  return set.kind === "unverdicted" || set.kind === "unheld";
}

/** The set's line in a red run's report; null for a decisive set, which needs none. */
export function redRunSetLine(set: RedRunSetVerdict): string | null {
  switch (set.kind) {
    case "decisive":
      return null;
    case "held":
      return `HELD, the set: every check passes on the foundation, and ${set.items.join(", ")} held before the correction that put them in scope, so they still hold`;
    case "unverdicted":
      return `REJECTED, the set: no check of it fails on the foundation and not every one passes there. ${heldSetRuleText(HELD_SET_RULE)}`;
    case "unheld":
      return `REJECTED, the set: every check passes on the foundation, and ${unheldReason(set.evidence)}. ${heldSetRuleText(HELD_SET_RULE)}`;
  }
}

/** One check's line in a red run's report. */
export function redRunVerdict(run: CheckRun): string {
  const problem = redRunProblem(run);
  if (problem !== null) return `REJECTED: ${problem}`;
  return failsDecisively(run) ? "fails on the foundation: its verdict is that the behaviour is missing" : "passes on the foundation: kept, as a guard of behaviour that already holds";
}

/**
 * define_check's red run of its one check on the foundation, as the author is shown it. A check that
 * passes there carries what a set whose every check passes there shows (`evidenceOf`, read only then),
 * so the author is told the set rule its own task is held to.
 */
export async function redRunPreview(
  report: CheckRunReport,
  timeoutSeconds: number,
  checkoutDir: string,
  evidenceOf: () => Promise<HoldEvidence>,
): Promise<CheckRedRunPreview> {
  if (report.kind === "files_refused") {
    return { kind: "files_refused", detail: `the check files cannot be placed on the foundation: ${report.detail}` };
  }
  if (report.kind === "product_changed") return { kind: "product_changed", detail: `on the foundation, ${describeProductChange(report)}` };
  const [run] = report.runs;
  if (run === undefined) throw new SuiteRunMissing(checkoutDir);
  const rejection = redRunProblem(run);
  const holdsAlready = rejection === null && !failsDecisively(run) ? await evidenceOf() : null;
  return { kind: "ran", run, timeoutSeconds, rejection, holdsAlready };
}

/** probe_foundation's run of one command on the foundation, as the author is shown it; nothing of it is recorded. */
export function foundationProbeOf(report: CheckRunReport, timeoutSeconds: number, checkoutDir: string): FoundationProbe {
  if (report.kind === "files_refused") {
    return { kind: "files_refused", detail: `the check files cannot be placed on the foundation: ${report.detail}` };
  }
  if (report.kind === "product_changed") return { kind: "product_changed", detail: `on the foundation, ${describeProductChange(report)}` };
  const [run] = report.runs;
  if (run === undefined) throw new SuiteRunMissing(checkoutDir);
  return { kind: "ran", run, timeoutSeconds };
}

/**
 * Where a check task's checks are red-run and where its files go, as its brief states it: the
 * foundation, never today's main, named by the task whose merge it is. Its commit is not named: the
 * cell's repository is a throwaway one of a single commit, which never holds it.
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
 * The stored check files, read-only: the implementer must see what the checks read to satisfy them,
 * and one that cannot see them may recreate one, which the ownership gate refuses.
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
 * Every check already stored in the project, as the check author's brief states them: independent
 * authors can fix incompatible output formats for the same line unless each sees
 * the other's checks. The rule is stated; a contradiction that still slips through is
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
