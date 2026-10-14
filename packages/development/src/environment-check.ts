import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BuiltEnvironment,
  Cell,
  CellSpec,
  EnvironmentBuildRequest,
  EnvironmentDefinition,
  EnvironmentImagePrune,
  HostRepo,
} from "@ashara/execution-infra";
import {
  ENVIRONMENT_DEFINITION_PATH,
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  parseEnvironmentDefinition,
  readEnvironmentDefinition,
  recipePaths,
  runHostGit,
} from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { environmentBuildPassed } from "@ashara/workplace";
import type { EnvironmentCheckPort, EnvironmentCheckReport, EnvironmentCommandsRun, EnvironmentTestRun, LogTail } from "@ashara/workplace";
import { freshWorktreeRepo, targetRepo } from "./host-git.js";
import { TreePathRefused, readTreeFile } from "./tree-read.js";
import type { TreeFileRead } from "./tree-read.js";
import { cleanupWorkdir } from "./workspace.js";

// Z0's half of the environment substrate (s-platform-role-m1): build_environment for the
// environment role during its attempt, and the substrate gate that checks environment work in
// place of per-task verify. Nothing here runs anything the agent wrote on the host: the
// definition is read through the safe tree reader and from committed blobs, the image is built by
// podman from the committed build context only, and every command runs in a cell. ADR-074
// addendum 2 d72: environment work may touch recipe files only, and its gate is the image build
// and the toolchain probe, never the product's build or test on a tree that holds no product.

const MAX_DEFINITION_BYTES = 64 * 1024;
/** Longest end of a command's stdout or stderr kept for the model and the gate record. */
const TEST_LOG_TAIL_CHARS = 4000;
const CHECK_REF_PREFIX = "refs/ashara/environment-check/";
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The branch every task branch starts from; environment work is diffed against their merge base. */
const MAIN_BRANCH = "main";

/** Builds (or reuses) the image of an environment version; the composition root wires execution-infra's builder. */
export interface EnvironmentImages {
  build(request: EnvironmentBuildRequest): Promise<BuiltEnvironment>;
  /**
   * Removes the project's images of every version but `keepVersion` (null: main defines none)
   * that no container uses; only images labelled ashara.managed are touched.
   */
  prune(projectId: ProjectId, keepVersion: string): Promise<EnvironmentImagePrune>;
}

/**
 * The team's statement of the stack (chosen and why), kept on a work item with the version it holds
 * for: an environment task's own statement with the version its gate tested, or, for an
 * implementation whose verified merge changed the environment's build context, the statement of the
 * version it ran on with the version the merge produced (ADR-074 addendum 2 d72 B3).
 */
export interface EnvironmentStatementStore {
  record(taskId: WorkItemId, statement: string, version: string): Promise<void>;
  /**
   * The statement of the project's most recently completed environment or implementation task that recorded it for
   * `version`, or null when none did.
   */
  forVersion(projectId: ProjectId, version: string): Promise<string | null>;
}

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
type EnvironmentCheckoutPurpose = "environment-check" | "substrate-gate" | "verify" | "verify-probe";

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
  /** Creates a cell from `image` with the given role that mounts `hostPath` (with its `.git` masked). */
  readonly createCell: (spec: Pick<CellSpec, "image" | "role"> & { readonly hostPath: string }) => Promise<Cell>;
  readonly teardownCell: (cell: Cell) => Promise<void>;
}

/**
 * A tested environment: the image and the definition the gate passed, which the post-merge check
 * runs again on the merged tree.
 */
export interface TestedEnvironment {
  readonly version: string;
  readonly imageRef: string;
  readonly definition: EnvironmentDefinition;
}

function tailOf(text: string, alreadyTruncated: boolean): LogTail {
  if (text.length <= TEST_LOG_TAIL_CHARS) return { text, truncated: alreadyTruncated };
  return { text: text.slice(-TEST_LOG_TAIL_CHARS), truncated: true };
}

async function runCommand(cell: Cell, command: string, timeoutSeconds: number): Promise<EnvironmentTestRun> {
  const result = await cell.exec(["sh", "-c", command], { timeoutSeconds });
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: tailOf(result.stdout, result.stdoutTruncated),
    stderr: tailOf(result.stderr, result.stderrTruncated),
  };
}

/** The checkout's untracked or modified paths, as hardened host git reports them. */
async function leftOverPaths(repo: HostRepo): Promise<string[]> {
  const { stdout } = await runHostGit(repo, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]);
  // Each record is "XY <path>"; --no-renames keeps every record to one path.
  return stdout.split("\0").filter((record) => record !== "").map((record) => record.slice(3));
}

/**
 * Checks `commit` out into a fresh detached worktree of the target, runs `use` with one cell from
 * `imageRef` mounting it and the checkout's repo, and removes the checkout and the cell afterwards;
 * a substrate failure throws.
 */
async function withCheckoutCell<T>(
  scope: EnvironmentCheckScope,
  purpose: EnvironmentCheckoutPurpose,
  role: string,
  imageRef: string,
  commit: string,
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

/** The definition's `probe` in one cell from `imageRef` on a fresh checkout of `commit`. */
function runProbeOnCheckout(
  scope: EnvironmentCheckScope,
  purpose: EnvironmentCheckoutPurpose,
  role: string,
  imageRef: string,
  commit: string,
  definition: EnvironmentDefinition,
  timeoutSeconds: number,
): Promise<EnvironmentTestRun> {
  return withCheckoutCell(scope, purpose, role, imageRef, commit, (cell) => runCommand(cell, definition.probe, timeoutSeconds));
}

/**
 * Builds the image of `definition` as committed at `commit`, then runs `probe` on a fresh checkout
 * of that commit. A definition, image build or version the agent got wrong is a report; a
 * substrate failure throws.
 */
async function buildAndProbe(
  scope: EnvironmentCheckScope,
  purpose: EnvironmentCheckoutPurpose,
  commit: string,
  definition: EnvironmentDefinition,
  role: string,
  timeoutSeconds: number,
): Promise<EnvironmentCheckReport> {
  let built: BuiltEnvironment;
  try {
    built = await scope.images.build({ projectId: scope.projectId, repoGitDir: scope.repo.gitDir, commit, definition });
  } catch (err) {
    if (err instanceof EnvironmentBuildFailed) {
      return { kind: "build_failed", version: err.version, detail: err.detail, log: { text: err.logTail, truncated: err.logTruncated } };
    }
    if (err instanceof EnvironmentVersionUnresolved) return { kind: "definition_refused", detail: err.reason };
    throw err;
  }
  const probe = await runProbeOnCheckout(scope, purpose, role, built.imageRef, commit, definition, timeoutSeconds);
  return {
    kind: "tested",
    version: built.version,
    imageRef: built.imageRef,
    build: built.reused ? { kind: "reused" } : { kind: "built", log: built.log },
    probe,
  };
}

async function gitLine(scope: EnvironmentCheckScope, step: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runHostGit(scope.repo, args);
  const line = stdout.trim();
  if (!COMMIT_HASH.test(line)) throw new EnvironmentCheckCommitFailed(scope.taskId, step, `printed ${JSON.stringify(stdout)}`);
  return line;
}

/**
 * The paths the work up to `commit` added, changed or deleted since it left main (the merge base),
 * that are no recipe file (ADR-074 addendum 2 d72 B1): environment work may touch the recipe only.
 * The recipe is the one `definition` (the work's) names, and the one main's definition at the merge
 * base names, so a recipe file the work stops naming may still be deleted. A merge base with no
 * readable definition (Sprint 0) adds nothing.
 */
async function outOfScope(scope: EnvironmentCheckScope, commit: string, definition: EnvironmentDefinition): Promise<EnvironmentCheckReport | null> {
  const base = await gitLine(scope, "merge-base", ["merge-base", MAIN_BRANCH, commit]);
  const recipe = new Set(recipePaths(definition));
  try {
    for (const path of recipePaths(await readEnvironmentDefinition(scope.repo.gitDir, base))) recipe.add(path);
  } catch (err) {
    if (!(err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved)) throw err;
  }
  const { stdout } = await runHostGit(scope.repo, ["diff", "--name-only", "-z", "--no-renames", base, commit]);
  const paths = stdout.split("\0").filter((path) => path !== "" && !recipe.has(path));
  return paths.length === 0 ? null : { kind: "out_of_scope", recipe: [...recipe], paths };
}

/**
 * Commits the worktree's current files to a commit kept under refs/ashara/environment-check/<task>,
 * never on the task branch: the environment version is a digest over committed blobs. Each check
 * replaces the ref, so environment_builds.commit names a commit that stays reachable until the next.
 */
async function commitForCheck(scope: EnvironmentCheckScope): Promise<string> {
  if (!REF_SEGMENT.test(scope.taskId)) {
    throw new EnvironmentCheckCommitFailed(scope.taskId, "name the check ref", "the task id is not a valid ref segment");
  }
  await runHostGit(scope.repo, ["add", "-A"]);
  const tree = await gitLine(scope, "write-tree", ["write-tree"]);
  const parent = await gitLine(scope, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = await gitLine(scope, "commit-tree", [
    "commit-tree", tree, "-p", parent, "-m", `ashara: environment check of task ${scope.taskId}`,
  ]);
  await runHostGit(scope.repo, ["update-ref", `${CHECK_REF_PREFIX}${scope.taskId}`, commit]);
  return commit;
}

/**
 * build_environment's port: reads environment/environment.toml from the worktree through the safe
 * tree reader and validates it, commits the worktree to the check ref, refuses work outside the
 * recipe, builds the image from that commit and runs `probe` on a fresh checkout.
 */
export function environmentCheckPort(scope: EnvironmentCheckScope): EnvironmentCheckPort {
  return {
    async check(testTimeoutSeconds: number): Promise<EnvironmentCheckReport> {
      let read: TreeFileRead;
      try {
        read = await readTreeFile(scope.workDir, ENVIRONMENT_DEFINITION_PATH, MAX_DEFINITION_BYTES);
      } catch (err) {
        if (err instanceof TreePathRefused) return { kind: "definition_refused", detail: err.message };
        throw err;
      }
      if (read.kind === "absent") return { kind: "definition_refused", detail: `${ENVIRONMENT_DEFINITION_PATH} does not exist in the workspace` };
      if (read.truncated) {
        return { kind: "definition_refused", detail: `${ENVIRONMENT_DEFINITION_PATH} is larger than ${MAX_DEFINITION_BYTES} bytes` };
      }
      let definition: EnvironmentDefinition;
      try {
        definition = parseEnvironmentDefinition(read.text, ENVIRONMENT_DEFINITION_PATH);
      } catch (err) {
        if (err instanceof EnvironmentDefinitionInvalid) return { kind: "definition_refused", detail: err.issues.join("; ") };
        throw err;
      }

      const commit = await commitForCheck(scope);
      let committed: EnvironmentDefinition;
      try {
        committed = await readEnvironmentDefinition(scope.repo.gitDir, commit);
      } catch (err) {
        if (err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved) {
          return { kind: "definition_refused", detail: describeErrorChain(err) };
        }
        throw err;
      }
      if (JSON.stringify(committed) !== JSON.stringify(definition)) {
        return { kind: "definition_refused", detail: `${ENVIRONMENT_DEFINITION_PATH} changed while it was being read; call build_environment again` };
      }
      const refused = await outOfScope(scope, commit, definition);
      if (refused !== null) return refused;
      return buildAndProbe(scope, "environment-check", commit, definition, "environment-check", testTimeoutSeconds);
    },
  };
}

/** The substrate gate's verdict on environment work's committed work. */
export type SubstrateGateRun = { readonly report: EnvironmentCheckReport; readonly tested: TestedEnvironment | null };

/**
 * The environment gate (checkedBy "substrate"), run by Z0 on the task branch's committed head in
 * place of per-task verify: the definition parses, the branch touches recipe files only, the image
 * builds (recorded in environment_builds), and `probe` passes on a fresh checkout of the head in a
 * CI cell from that image.
 */
export async function runSubstrateGate(scope: EnvironmentCheckScope, testTimeoutSeconds: number): Promise<SubstrateGateRun> {
  const head = await gitLine(scope, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
  let definition: EnvironmentDefinition;
  try {
    definition = await readEnvironmentDefinition(scope.repo.gitDir, head);
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved) {
      return { report: { kind: "definition_refused", detail: describeErrorChain(err) }, tested: null };
    }
    throw err;
  }
  const refused = await outOfScope(scope, head, definition);
  if (refused !== null) return { report: refused, tested: null };
  const report = await buildAndProbe(scope, "substrate-gate", head, definition, "ci", testTimeoutSeconds);
  return { report, tested: report.kind === "tested" ? { version: report.version, imageRef: report.imageRef, definition } : null };
}

/**
 * The post-merge run of environment work's gate: `probe` from `tested`'s image on a fresh checkout of
 * `commit` (the tentative merge). The cell has no network; a substrate failure throws.
 */
export function runPostMergeProbe(
  scope: EnvironmentCheckScope,
  role: string,
  tested: TestedEnvironment,
  commit: string,
  timeoutSeconds: number,
): Promise<EnvironmentTestRun> {
  return runProbeOnCheckout(scope, "verify-probe", role, tested.imageRef, commit, tested.definition, timeoutSeconds);
}

/**
 * The product's `build` then `test` from `tested`'s image on a fresh checkout of `commit` (the
 * tentative merge), and what the checkout holds afterwards that the commit does not: the scaffold's
 * gate, and the check of an environment rebuilt from a merge that changed its build context
 * (ADR-074 addendum 2 d72 B2, B3). They are one run: a `test` that reads what `build` produced
 * passes only after it. The cell has no network; a substrate failure throws.
 */
export function runPostMergeEnvironmentCommands(
  scope: EnvironmentCheckScope,
  role: string,
  tested: TestedEnvironment,
  commit: string,
  timeoutSeconds: number,
): Promise<EnvironmentCommandsRun> {
  return withCheckoutCell(scope, "verify", role, tested.imageRef, commit, async (cell, repo): Promise<EnvironmentCommandsRun> => {
    const build = await runCommand(cell, tested.definition.build, timeoutSeconds);
    if (!environmentBuildPassed(build)) return { kind: "build_failed", build };
    const test = await runCommand(cell, tested.definition.test, timeoutSeconds);
    return { kind: "ran", build, test, leftOver: await leftOverPaths(repo) };
  });
}
