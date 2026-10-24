import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepEnds } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { EnvironmentImages } from "./current-environment.js";
import type { BuiltEnvironment } from "./environment-build.js";
import type { EnvironmentCheckReport, EnvironmentTestRun } from "./environment-report.js";
import type { EnvironmentBuildContext } from "./environment.js";
import { EnvironmentBuildFailed, EnvironmentVersionUnresolved } from "./errors.js";
import { runHostGit } from "./host-git.js";
import type { HostRepo } from "./host-git.js";
import type { Cell, CellSpec } from "./podman.js";
import { elidedOutput } from "./process-runner.js";
import { freshWorktreeRepo, targetRepo } from "./target-repo.js";
import { cleanupWorkdir } from "./worktree.js";

// The image half of an environment check: a commit of the task's worktree kept under its own ref,
// the image built from that commit's build context, and the definition's commands run in cells on
// fresh checkouts. Nothing here runs anything the agent wrote on the host: the image is built by
// podman from the committed build context only, and every command runs in a cell.

/** Most characters of a command's stdout or stderr kept, head and tail, for the model and the gate record. */
const TEST_LOG_CHARS = 4000;
const CHECK_REF_PREFIX = "refs/ashara/environment-check/";
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A git step of the environment check printed something that is not what it must print. */
class EnvironmentCheckCommitFailed extends Error {
  constructor(
    readonly taskId: string,
    readonly step: string,
    readonly detail: string,
  ) {
    super(`environment check of task ${taskId}: ${step} failed: ${detail}`);
    this.name = "EnvironmentCheckCommitFailed";
  }
}

/** Which check a fresh checkout is for: each has its own directory. */
type EnvironmentCheckoutPurpose = "environment-check" | "substrate-gate" | "verify" | "verify-probe" | "foundation-build";

/** Everything one environment check needs of its dispatch. */
export interface EnvironmentCheckScope {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId;
  /** The task's worktree, as a cell-writable tree. */
  readonly workDir: string;
  /** The worktree's git dir, resolved before any cell mounted it. */
  readonly repo: HostRepo;
  /** The target checkout, whose repository the fresh checkouts are worktrees of. */
  readonly targetProjectPath: string;
  /** Where a fresh checkout for `purpose` goes: a path that does not exist, under the substrate's mount root. */
  readonly checkoutDir: (purpose: EnvironmentCheckoutPurpose) => string;
  readonly images: EnvironmentImages;
  /** Creates a cell from `image` with the given role that mounts `hostPath` (its `.git` replaced by the cell's own repository). */
  readonly createCell: (spec: Pick<CellSpec, "image" | "role"> & { readonly hostPath: string }) => Promise<Cell>;
  readonly teardownCell: (cell: Cell) => Promise<void>;
  /** The process's shutdown: every command the check runs in a cell is interrupted by it. */
  readonly signal: AbortSignal;
}

/**
 * `command` in `cell` by `sh -c`, its streams cut to TEST_LOG_CHARS with every cut counted. `signal`
 * aborting interrupts it: it throws CellExecInterrupted, never a run.
 */
export async function runEnvironmentCommand(cell: Cell, command: string, timeoutSeconds: number, signal: AbortSignal): Promise<EnvironmentTestRun> {
  const result = await cell.exec(["sh", "-c", command], { timeoutSeconds, signal });
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: keepEnds(elidedOutput(result.stdout, result.stdoutCut), TEST_LOG_CHARS),
    stderr: keepEnds(elidedOutput(result.stderr, result.stderrCut), TEST_LOG_CHARS),
  };
}

/** Which checkout a cell mounts: `commit` of the target, for `purpose`, in a cell of `role` from `imageRef`. */
interface CheckoutCellOf {
  readonly purpose: EnvironmentCheckoutPurpose;
  readonly role: string;
  readonly imageRef: string;
  readonly commit: string;
}

/**
 * Checks `commit` out into a fresh detached worktree of the target, runs `use` with one cell from
 * `imageRef` mounting it and the checkout's repo, and removes the checkout and the cell afterwards;
 * a substrate failure throws.
 */
export async function withCheckoutCell<T>(
  scope: EnvironmentCheckScope,
  { purpose, role, imageRef, commit }: CheckoutCellOf,
  use: (cell: Cell, repo: HostRepo) => Promise<T>,
): Promise<T> {
  const dir = scope.checkoutDir(purpose);
  await mkdir(dirname(dir), { recursive: true });
  await runHostGit(targetRepo(scope.targetProjectPath), ["worktree", "add", "--detach", dir, commit]);
  try {
    // Read before the cell mounts the checkout: its gitlink is then never re-read.
    const repo = await freshWorktreeRepo(scope.targetProjectPath, dir);
    const cell = await scope.createCell({ image: imageRef, role, hostPath: dir });
    try {
      return await use(cell, repo);
    } finally {
      await scope.teardownCell(cell);
    }
  } finally {
    await cleanupWorkdir(dir, scope.targetProjectPath);
  }
}

/** The definition's `probe` command in one cell from `imageRef` on a fresh checkout of `commit`. */
export function runProbeOnCheckout(
  scope: EnvironmentCheckScope,
  { probe, timeoutSeconds, ...checkout }: CheckoutCellOf & { readonly probe: string; readonly timeoutSeconds: number },
): Promise<EnvironmentTestRun> {
  return withCheckoutCell(scope, checkout, (cell) => runEnvironmentCommand(cell, probe, timeoutSeconds, scope.signal));
}

/**
 * Builds the image of `definition`'s build context as committed at `commit`, then runs the `probe`
 * command on a fresh checkout of that commit. A definition, image build or version the agent got
 * wrong is a report; a substrate failure throws.
 */
export async function buildAndProbe(
  scope: EnvironmentCheckScope,
  { purpose, commit, definition, probe, role, timeoutSeconds }: {
    readonly purpose: EnvironmentCheckoutPurpose;
    readonly commit: string;
    readonly definition: EnvironmentBuildContext;
    readonly probe: string;
    readonly role: string;
    readonly timeoutSeconds: number;
  },
): Promise<EnvironmentCheckReport> {
  let built: BuiltEnvironment;
  try {
    built = await scope.images.build({ projectId: scope.projectId, repoGitDir: scope.repo.gitDir, commit, definition });
  } catch (err) {
    if (err instanceof EnvironmentBuildFailed) {
      return { kind: "build_failed", version: err.version, detail: err.detail, log: err.log };
    }
    if (err instanceof EnvironmentVersionUnresolved) return { kind: "definition_refused", detail: err.reason };
    throw err;
  }
  const probeRun = await runProbeOnCheckout(scope, { purpose, role, imageRef: built.imageRef, commit, probe, timeoutSeconds });
  return {
    kind: "tested",
    version: built.version,
    imageRef: built.imageRef,
    build: built.reused ? { kind: "reused" } : { kind: "built", log: built.log },
    probe: probeRun,
  };
}

/** One line of `git` output on the task's worktree that must be a commit id; anything else throws. */
export async function worktreeCommitLine(scope: EnvironmentCheckScope, step: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runHostGit(scope.repo, args);
  const line = stdout.trim();
  if (!COMMIT_HASH.test(line)) throw new EnvironmentCheckCommitFailed(scope.taskId, step, `printed ${JSON.stringify(stdout)}`);
  return line;
}

/**
 * Commits the worktree's current files to a commit kept under refs/ashara/environment-check/<task>,
 * never on the task branch: the environment version is a digest over committed blobs. Each check
 * replaces the ref, so environment_builds.commit names a commit that stays reachable until the next.
 */
export async function commitForCheck(scope: EnvironmentCheckScope): Promise<string> {
  if (!REF_SEGMENT.test(scope.taskId)) {
    throw new EnvironmentCheckCommitFailed(scope.taskId, "name the check ref", "the task id is not a valid ref segment");
  }
  await runHostGit(scope.repo, ["add", "-A"]);
  const tree = await worktreeCommitLine(scope, "write-tree", ["write-tree"]);
  const parent = await worktreeCommitLine(scope, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = await worktreeCommitLine(scope, "commit-tree", [
    "commit-tree", tree, "-p", parent, "-m", `ashara: environment check of task ${scope.taskId}`,
  ]);
  await runHostGit(scope.repo, ["update-ref", `${CHECK_REF_PREFIX}${scope.taskId}`, commit]);
  return commit;
}
