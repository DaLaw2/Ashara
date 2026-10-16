import { describeErrorChain } from "@ashara/shared";
import { clearWorktreeSlot, removeThrowawayCheckouts, runHostGit, targetRepo, treeHasEntry } from "@ashara/execution-infra";
import { taskBranchName } from "./merge.js";
import { checkBranchName } from "./task-checks.js";

/** What one target's release of settled tasks' branches did. */
interface SettledBranchRelease {
  readonly released: number;
  /** Branches of settled tasks, and throwaway checkouts, still in the target: each is retried by the next release. */
  readonly left: number;
  /** Throwaway checkouts removed (removeThrowawayCheckouts). */
  readonly checkouts: number;
}

/** The kinds of branch an attempt works on, each named by its task's id. */
const BRANCH_KINDS: readonly ((taskId: string) => string)[] = [taskBranchName, checkBranchName];

/**
 * First removes every throwaway checkout the target still has registered: the caller runs this only
 * while no attempt is in flight, so each one is a check's checkout a crash or a faulted cleanup
 * left (removeThrowawayCheckouts). Then deletes, in the target at `targetPath`, every task branch and check branch (with its worktree slot
 * under `workdirBase`: git refuses to delete a branch a worktree holds) whose task is in `settled`,
 * the tasks no attempt runs for and whose branch nothing reads. The caller decides which tasks those
 * are; every path that settles a task is covered without a call of its own. A target with no
 * repository holds no branch. A branch that cannot be released is logged at warn with its cause and
 * counted as left, never a verdict; a target whose branches cannot be listed throws.
 */
export async function releaseSettledBranches(
  workdirBase: string,
  targetPath: string,
  settled: ReadonlySet<string>,
): Promise<SettledBranchRelease> {
  if (!(await treeHasEntry(targetPath, ".git"))) return { released: 0, left: 0, checkouts: 0 };
  const checkouts = await removeThrowawayCheckouts(workdirBase, targetPath);
  const repo = targetRepo(targetPath);
  const prefixes = BRANCH_KINDS.map((kind) => kind(""));
  const { stdout } = await runHostGit(repo, ["for-each-ref", "--format=%(refname:lstrip=2)", ...prefixes.map((p) => `refs/heads/${p}`)]);
  let released = 0;
  let left = checkouts.left;
  for (const branch of stdout.split("\n").filter((line) => line !== "")) {
    const prefix = prefixes.find((p) => branch.startsWith(p));
    if (prefix === undefined || !settled.has(branch.slice(prefix.length))) continue;
    try {
      await clearWorktreeSlot(workdirBase, targetPath, branch);
      await runHostGit(repo, ["branch", "-D", branch]);
      released += 1;
    } catch (e) {
      left += 1;
      console.warn(`[settled-branches] the branch ${branch} of a settled task could not be released and is left in ${targetPath}; the next release retries it: ${describeErrorChain(e)}`);
    }
  }
  return { released, left, checkouts: checkouts.removed };
}
