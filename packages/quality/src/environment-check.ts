import type {
  EnvironmentCheckReport,
  EnvironmentCheckScope,
  EnvironmentStatementSource,
  EnvironmentTestRun,
  HostRepo,
} from "@ashara/execution-infra";
import {
  ENVIRONMENT_DEFINITION_PATH,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  TreePathRefused,
  buildAndProbe,
  commitForCheck,
  readTreeFile,
  recipePaths,
  runEnvironmentCommand,
  runHostGit,
  runProbeOnCheckout,
  withCheckoutCell,
  worktreeCommitLine,
} from "@ashara/execution-infra";
import type { TreeFileRead } from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";
import type { WorkItemId } from "@ashara/shared";
import type { EnvironmentCheckPort } from "@ashara/workplace";
import { parseEnvironmentDefinition, readEnvironmentDefinition } from "./environment-definition.js";
import type { EnvironmentDefinition } from "./environment-definition.js";
import { environmentBuildPassed, environmentCheckVerdict } from "./environment-verdict.js";
import type { EnvironmentCommandsRun } from "./environment-verdict.js";

// Z0's half of the environment substrate (s-platform-role-m1): build_environment for the
// environment role during its attempt, and the substrate gate that checks environment work in
// place of per-task verify. The image build and every command in a cell are execution-infra's
// (checkout-cell.ts); what is checked here is the gate's: the definition read through the safe
// tree reader, the recipe-only scope, and the product's commands on the merge. ADR-074 addendum 2
// d72: environment work may touch recipe files only, and its gate is the image build and the
// toolchain probe, never the product's build or test on a tree that holds no product.

const MAX_DEFINITION_BYTES = 64 * 1024;
/** The branch every task branch starts from; environment work is diffed against their merge base. */
const MAIN_BRANCH = "main";

/**
 * The team's statement of the stack (chosen and why), kept on a work item with the version it holds
 * for: an environment task's own statement with the version its gate tested, or, for an
 * implementation whose verified merge changed the environment's build context, the statement of the
 * version it ran on with the version the merge produced (ADR-074 addendum 2 d72 B3).
 */
export interface EnvironmentStatementStore extends EnvironmentStatementSource {
  record(taskId: WorkItemId, statement: string, version: string): Promise<void>;
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

/** The checkout's untracked or modified paths, as hardened host git reports them. */
async function leftOverPaths(repo: HostRepo): Promise<string[]> {
  const { stdout } = await runHostGit(repo, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]);
  // Each record is "XY <path>"; --no-renames keeps every record to one path.
  return stdout.split("\0").filter((record) => record !== "").map((record) => record.slice(3));
}

/**
 * The paths the work up to `commit` added, changed or deleted since it left main (the merge base),
 * that are no recipe file (ADR-074 addendum 2 d72 B1): environment work may touch the recipe only.
 * The recipe is the one `definition` (the work's) names, and the one main's definition at the merge
 * base names, so a recipe file the work stops naming may still be deleted. A merge base with no
 * readable definition (Sprint 0) adds nothing.
 */
async function outOfScope(scope: EnvironmentCheckScope, commit: string, definition: EnvironmentDefinition): Promise<EnvironmentCheckReport | null> {
  const base = await worktreeCommitLine(scope, "merge-base", ["merge-base", MAIN_BRANCH, commit]);
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
 * build_environment's port: reads environment/environment.toml from the worktree through the safe
 * tree reader and validates it, commits the worktree to the check ref, refuses work outside the
 * recipe, builds the image from that commit and runs `probe` on a fresh checkout. The tool is given
 * the verdict on that report.
 */
export function environmentCheckPort(scope: EnvironmentCheckScope): EnvironmentCheckPort {
  return {
    check: async (testTimeoutSeconds) => environmentCheckVerdict(await checkEnvironmentWork(scope, testTimeoutSeconds)),
  };
}

async function checkEnvironmentWork(scope: EnvironmentCheckScope, testTimeoutSeconds: number): Promise<EnvironmentCheckReport> {
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
  return buildAndProbe(scope, "environment-check", commit, definition, definition.probe, "environment-check", testTimeoutSeconds);
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
  const head = await worktreeCommitLine(scope, "rev-parse HEAD", ["rev-parse", "--verify", "HEAD^{commit}"]);
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
  const report = await buildAndProbe(scope, "substrate-gate", head, definition, definition.probe, "ci", testTimeoutSeconds);
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
  return runProbeOnCheckout(scope, "verify-probe", role, tested.imageRef, commit, tested.definition.probe, timeoutSeconds);
}

/**
 * The definition's `build` from `imageRef` on a fresh checkout of `commit`, a red run's foundation
 * (W11 D2): the merge gate's first step, run before any check there, so a check that fails only
 * because the product does not build is never read as a check that tells the task's work from its
 * absence. The command is the environment's own, never one Ashara names. The cell has no network; a
 * substrate failure throws.
 */
export function runFoundationBuild(
  scope: EnvironmentCheckScope,
  role: string,
  imageRef: string,
  commit: string,
  definition: EnvironmentDefinition,
  timeoutSeconds: number,
): Promise<EnvironmentTestRun> {
  return withCheckoutCell(scope, "foundation-build", role, imageRef, commit, (cell) => runEnvironmentCommand(cell, definition.build, timeoutSeconds));
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
    const build = await runEnvironmentCommand(cell, tested.definition.build, timeoutSeconds);
    if (!environmentBuildPassed(build)) return { kind: "build_failed", build };
    const test = await runEnvironmentCommand(cell, tested.definition.test, timeoutSeconds);
    return { kind: "ran", build, test, leftOver: await leftOverPaths(repo) };
  });
}
