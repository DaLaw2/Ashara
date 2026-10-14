import { runHostGit } from "@ashara/execution-infra";
import { targetRepo } from "../host-git.js";
import type { StoredCheckFile } from "../task-checks.js";

// Separation of duties held by Z0, not by the model (story s-platform-role-m1, sprint0-run D5;
// ADR-074 addendum 2 d72 B1): an implementation task's branch may not change what another role
// writes. Two kinds of path are protected: the environment recipe (the definition, its
// containerfile and the recipe files it names), the platform role's, because checks run in the
// image it builds; and every stored check file, the check author's who wrote it. Nothing else is
// fenced: the product's layout and manifests are the product's, and a change to an input the
// recipe reads is accepted when the environment rebuilt from the merge passes (post-merge).

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Longest part of the branch's diff of the recipe carried to the environment task; a cut is marked. */
const MAX_RECIPE_DIFF_CHARS = 16000;

/** A git step of the ownership gate printed something that is not what it must print. */
class OwnershipDiffFailed extends Error {
  constructor(
    readonly taskId: string,
    readonly step: string,
    readonly detail: string,
  ) {
    super(`ownership gate of task ${taskId}: ${step} failed: ${detail}`);
    this.name = "OwnershipDiffFailed";
  }
}

type OwnershipVerdict =
  | { readonly kind: "clean" }
  /**
   * Only recipe files were changed: the work needs an environment change, which the platform role
   * makes. `diff` is the branch's diff of those files against its merge base.
   */
  | { readonly kind: "environment_change"; readonly paths: readonly string[]; readonly diff: string; readonly reason: string }
  /** A stored check file was changed (with or without recipe files): the task's failure. */
  | { readonly kind: "refused"; readonly recipePaths: readonly string[]; readonly checkPaths: readonly string[]; readonly reason: string };

async function mergeBase(targetProjectPath: string, taskId: string, branch: string): Promise<string> {
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["merge-base", "--end-of-options", "refs/heads/main", `refs/heads/${branch}`]);
  const base = stdout.trim();
  if (!COMMIT_HASH.test(base)) throw new OwnershipDiffFailed(taskId, "merge-base", `printed ${JSON.stringify(stdout)}`);
  return base;
}

/**
 * The paths the task branch added, changed or deleted since it left main (the merge base), from
 * the target's own git (hardened host git, no renames: a rename is a deletion and an addition).
 */
export async function branchChangedPaths(targetProjectPath: string, taskId: string, branch: string): Promise<readonly string[]> {
  const base = await mergeBase(targetProjectPath, taskId, branch);
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["diff", "--name-only", "-z", "--no-renames", base, `refs/heads/${branch}`, "--"]);
  return stdout.split("\0").filter((path) => path !== "");
}

/** The branch's diff of `paths` against its merge base, as text; a cut is marked. */
async function recipeDiff(targetProjectPath: string, taskId: string, branch: string, paths: readonly string[]): Promise<string> {
  const base = await mergeBase(targetProjectPath, taskId, branch);
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), [
    "diff", "--no-renames", "--no-color", "--no-ext-diff", base, `refs/heads/${branch}`, "--", ...paths,
  ]);
  if (stdout.length <= MAX_RECIPE_DIFF_CHARS) return stdout;
  return `${stdout.slice(0, MAX_RECIPE_DIFF_CHARS)}\n[diff cut at ${MAX_RECIPE_DIFF_CHARS} of ${stdout.length} characters]`;
}

/**
 * Checks the task branch against the paths its role may not write: `recipe` (the recipe of the
 * environment on main, recipePaths) and every stored check file of the project. Run before the
 * tentative merge.
 */
export async function checkBranchOwnership(
  targetProjectPath: string,
  taskId: string,
  branch: string,
  recipe: readonly string[],
  checkFiles: readonly StoredCheckFile[],
): Promise<OwnershipVerdict> {
  const changed = await branchChangedPaths(targetProjectPath, taskId, branch);
  const recipeHits = changed.filter((path) => recipe.includes(path));
  const checkHits = changed.flatMap((path) => {
    const owners = [...new Set(checkFiles.filter((file) => file.path === path).map((file) => file.taskId))];
    return owners.length === 0 ? [] : [{ path, owners }];
  });
  if (recipeHits.length === 0 && checkHits.length === 0) return { kind: "clean" };

  const recipeRule =
    `the environment recipe (${recipe.join(", ")}) belongs to the platform role; a change to it is made by an ` +
    `environment task. The branch changed these recipe files: ${recipeHits.join(", ")}`;
  if (checkHits.length === 0) {
    return {
      kind: "environment_change",
      paths: recipeHits,
      diff: await recipeDiff(targetProjectPath, taskId, branch, recipeHits),
      reason: `${recipeRule}. Nothing was merged; an environment task is requested for the change (ADR-074 addendum 2 d66 b)`,
    };
  }
  const checkRule =
    `check files belong to the check author. The branch changed these stored check files: ` +
    checkHits.map((hit) => `${hit.path} (checks of task ${hit.owners.join(", ")})`).join(", ");
  const restore = "Restore every listed path to main's content (delete it if main has none) and finish again; nothing was merged";
  return {
    kind: "refused",
    recipePaths: recipeHits,
    checkPaths: checkHits.map((hit) => hit.path),
    reason: [checkRule, ...(recipeHits.length > 0 ? [recipeRule] : []), restore].join(". "),
  };
}
