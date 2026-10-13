import { ownedPathsCover, runHostGit } from "@ashara/execution-infra";
import { targetRepo } from "../host-git.js";
import type { StoredCheckFile } from "../task-checks.js";

// Separation of duties held by Z0, not by the model (story s-platform-role-m1, sprint0-run D5): an
// implementation task's branch may not change what another role writes. Environment files belong
// to the platform role (the current environment's owned set); a stored check file belongs to the
// check author who wrote it.

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  /** Only environment-owned paths were changed: the work needs an environment change, not a retry. */
  | { readonly kind: "environment_change_needed"; readonly paths: readonly string[]; readonly reason: string }
  /** A stored check file was changed (with or without environment paths): the task's failure. */
  | { readonly kind: "refused"; readonly environmentPaths: readonly string[]; readonly checkPaths: readonly string[]; readonly reason: string };

/**
 * The paths the task branch added, changed or deleted since it left main (the merge base), from
 * the target's own git (hardened host git, no renames: a rename is a deletion and an addition).
 */
export async function branchChangedPaths(targetProjectPath: string, taskId: string, branch: string): Promise<readonly string[]> {
  const repo = targetRepo(targetProjectPath);
  const { stdout: baseOut } = await runHostGit(repo, ["merge-base", "--end-of-options", "refs/heads/main", `refs/heads/${branch}`]);
  const base = baseOut.trim();
  if (!COMMIT_HASH.test(base)) throw new OwnershipDiffFailed(taskId, "merge-base", `printed ${JSON.stringify(baseOut)}`);
  const { stdout } = await runHostGit(repo, ["diff", "--name-only", "-z", "--no-renames", base, `refs/heads/${branch}`, "--"]);
  return stdout.split("\0").filter((path) => path !== "");
}

/**
 * Checks the task branch against the paths its role may not write: the current environment's
 * owned set and every stored check file of the project. Run before the tentative merge.
 */
export async function checkBranchOwnership(
  targetProjectPath: string,
  taskId: string,
  branch: string,
  owned: readonly string[],
  checkFiles: readonly StoredCheckFile[],
): Promise<OwnershipVerdict> {
  const changed = await branchChangedPaths(targetProjectPath, taskId, branch);
  const environmentPaths = changed.filter((path) => ownedPathsCover(owned, path));
  const checkHits = changed.flatMap((path) => {
    const owners = [...new Set(checkFiles.filter((file) => file.path === path).map((file) => file.taskId))];
    return owners.length === 0 ? [] : [{ path, owners }];
  });
  if (environmentPaths.length === 0 && checkHits.length === 0) return { kind: "clean" };

  const environmentRule =
    `environment files belong to the platform role; request an environment change. The branch changed these paths ` +
    `the environment owns [${owned.join(", ")}]: ${environmentPaths.join(", ")}`;
  if (checkHits.length === 0) {
    return {
      kind: "environment_change_needed",
      paths: environmentPaths,
      reason: `${environmentRule}. An implementation task may not change the environment (ADR-074 addendum 2 d63); nothing was merged`,
    };
  }
  const checkRule =
    `check files belong to the check author. The branch changed these stored check files: ` +
    checkHits.map((hit) => `${hit.path} (checks of task ${hit.owners.join(", ")})`).join(", ");
  const restore = "Restore every listed path to main's content (delete it if main has none) and finish again; nothing was merged";
  return {
    kind: "refused",
    environmentPaths,
    checkPaths: checkHits.map((hit) => hit.path),
    reason: [checkRule, ...(environmentPaths.length > 0 ? [environmentRule] : []), restore].join(". "),
  };
}
