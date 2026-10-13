import type {
  BuiltEnvironment,
  Cell,
  CellSpec,
  EnvironmentBuildRequest,
  EnvironmentDefinition,
  HostRepo,
} from "@ashara/execution-infra";
import {
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  parseEnvironmentDefinition,
  readEnvironmentDefinition,
  runHostGit,
} from "@ashara/execution-infra";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { EnvironmentCheckPort, EnvironmentCheckReport, EnvironmentTestRun, LogTail } from "@ashara/workplace";
import { TreePathRefused, readTreeFile } from "./tree-read.js";
import type { TreeFileRead } from "./tree-read.js";

// Z0's half of the environment substrate (s-platform-role-m1): build_environment for the
// environment role during its attempt, and the substrate gate that checks a Sprint 0 task
// in place of per-task verify. Nothing here runs anything the agent wrote on the host: the
// definition is read through the safe tree reader and from committed blobs, the image is
// built by podman from committed owned files only, and `test` runs in a cell.

const DEFINITION_PATH = "environment/environment.toml";
const MAX_DEFINITION_BYTES = 64 * 1024;
/** Longest end of the test's stdout or stderr kept for the model and the gate record. */
const TEST_LOG_TAIL_CHARS = 4000;
const CHECK_REF_PREFIX = "refs/ashara/environment-check/";
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Builds (or reuses) the image of an environment version; the composition root wires execution-infra's builder. */
export interface EnvironmentImages {
  build(request: EnvironmentBuildRequest): Promise<BuiltEnvironment>;
}

/** Keeps the Sprint 0 statement (the stack chosen and why) on its work item; t-dispatch-by-env-version reads it. */
export interface EnvironmentStatementStore {
  record(taskId: WorkItemId, statement: string): Promise<void>;
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

/** Everything one environment check needs of its dispatch. */
export interface EnvironmentCheckScope {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId;
  /** The task's worktree, as a cell-writable tree. */
  readonly workDir: string;
  /** The worktree's git dir, resolved before any cell mounted it. */
  readonly repo: HostRepo;
  readonly images: EnvironmentImages;
  /** Creates a cell from `image` with the given role that mounts `hostPath` (with its `.git` read-only). */
  readonly createCell: (spec: Pick<CellSpec, "image" | "role"> & { readonly hostPath: string }) => Promise<Cell>;
  readonly teardownCell: (cell: Cell) => Promise<void>;
}

/** A tested environment: what the gate's post-merge check runs again on the merged tree. */
export interface TestedEnvironment {
  readonly imageRef: string;
  readonly test: string;
}

function tailOf(text: string, alreadyTruncated: boolean): LogTail {
  if (text.length <= TEST_LOG_TAIL_CHARS) return { text, truncated: alreadyTruncated };
  return { text: text.slice(-TEST_LOG_TAIL_CHARS), truncated: true };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the definition's `test` in a fresh cell from `imageRef` that mounts `hostPath`. The cell
 * has no network (execution-infra's cells all run with --network=none).
 */
export async function runEnvironmentTest(
  scope: Pick<EnvironmentCheckScope, "createCell" | "teardownCell">,
  role: string,
  imageRef: string,
  hostPath: string,
  command: string,
  timeoutSeconds: number,
): Promise<EnvironmentTestRun> {
  const cell = await scope.createCell({ image: imageRef, role, hostPath });
  try {
    const result = await cell.exec(["sh", "-c", command], { timeoutSeconds });
    return {
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: tailOf(result.stdout, result.stdoutTruncated),
      stderr: tailOf(result.stderr, result.stderrTruncated),
    };
  } finally {
    await scope.teardownCell(cell);
  }
}

/**
 * Builds the image of `definition` as committed at `commit` and runs its `test` in a fresh cell
 * mounting the worktree. A definition, build or version the agent got wrong is a report; a
 * substrate failure throws.
 */
async function buildAndTest(
  scope: EnvironmentCheckScope,
  commit: string,
  definition: EnvironmentDefinition,
  testRole: string,
  testTimeoutSeconds: number,
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
  const test = await runEnvironmentTest(scope, testRole, built.imageRef, scope.workDir, definition.test, testTimeoutSeconds);
  return {
    kind: "tested",
    version: built.version,
    imageRef: built.imageRef,
    build: built.reused ? { kind: "reused" } : { kind: "built", log: built.log },
    test,
  };
}

async function gitLine(scope: EnvironmentCheckScope, step: string, args: readonly string[]): Promise<string> {
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
 * tree reader and validates it, then commits the worktree to the check ref, builds the image from
 * that commit and runs `test` in a fresh cell mounting the worktree.
 */
export function environmentCheckPort(scope: EnvironmentCheckScope): EnvironmentCheckPort {
  return {
    async check(testTimeoutSeconds: number): Promise<EnvironmentCheckReport> {
      let read: TreeFileRead;
      try {
        read = await readTreeFile(scope.workDir, DEFINITION_PATH, MAX_DEFINITION_BYTES);
      } catch (err) {
        if (err instanceof TreePathRefused) return { kind: "definition_refused", detail: err.message };
        throw err;
      }
      if (read.kind === "absent") return { kind: "definition_refused", detail: `${DEFINITION_PATH} does not exist in the workspace` };
      if (read.truncated) {
        return { kind: "definition_refused", detail: `${DEFINITION_PATH} is larger than ${MAX_DEFINITION_BYTES} bytes` };
      }
      let definition: EnvironmentDefinition;
      try {
        definition = parseEnvironmentDefinition(read.text, DEFINITION_PATH);
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
          return { kind: "definition_refused", detail: messageOf(err) };
        }
        throw err;
      }
      if (JSON.stringify(committed) !== JSON.stringify(definition)) {
        return { kind: "definition_refused", detail: `${DEFINITION_PATH} changed while it was being read; call build_environment again` };
      }
      return buildAndTest(scope, commit, definition, "environment-check", testTimeoutSeconds);
    },
  };
}

/** The substrate gate's verdict on a Sprint 0 task's committed work. */
export type SubstrateGateRun = { readonly report: EnvironmentCheckReport; readonly tested: TestedEnvironment | null };

/**
 * The Sprint 0 gate (checkedBy "substrate"), run by Z0 on the task branch's committed head in
 * place of per-task verify: the definition parses, the image builds (recorded in
 * environment_builds) and `test` runs in a fresh CI cell from that image.
 */
export async function runSubstrateGate(scope: EnvironmentCheckScope, testTimeoutSeconds: number): Promise<SubstrateGateRun> {
  const head = await gitLine(scope, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
  let definition: EnvironmentDefinition;
  try {
    definition = await readEnvironmentDefinition(scope.repo.gitDir, head);
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved) {
      return { report: { kind: "definition_refused", detail: messageOf(err) }, tested: null };
    }
    throw err;
  }
  const report = await buildAndTest(scope, head, definition, "ci", testTimeoutSeconds);
  return { report, tested: report.kind === "tested" ? { imageRef: report.imageRef, test: definition.test } : null };
}
