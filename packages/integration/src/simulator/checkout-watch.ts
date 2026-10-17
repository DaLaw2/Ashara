import type { Violation } from "./invariants.js";

/** git subcommands that change a checkout's index or work tree. */
const MUTATING = new Set(["merge", "commit", "reset", "checkout", "clean", "add", "rm", "stash", "cherry-pick", "rebase", "revert", "am", "apply"]);

/** What ends a staged merge when its own task runs it. */
const ENDS_STAGING = new Set(["commit", "reset", "merge --abort"]);

/** The subcommand and the arguments after it, skipping git's own options (`-c k=v`, `--git-dir=`). */
function commandOf(args: readonly string[]): { readonly name: string; readonly rest: readonly string[] } | null {
  const at = args.findIndex((arg) => !arg.startsWith("-") && !arg.includes("="));
  const name = at < 0 ? undefined : args[at];
  return name === undefined ? null : { name, rest: args.slice(at + 1) };
}

/** The checkout a host git call works on: its explicit work tree (runHostGit always names one), else its cwd. */
function workTreeOf(args: readonly string[], cwd: string): string {
  const named = args.find((arg) => arg.startsWith("--work-tree="));
  return named === undefined ? cwd : named.slice("--work-tree=".length);
}

/**
 * I7, the merge-queue clause: a tentative merge staged in a checkout by one
 * task's finalize belongs to that task until it commits or undoes it. Another task changing that
 * checkout meanwhile (its own merge on top, a reset, its recovery's `merge --abort`) is two
 * finalizes overlapping on one checkout, which the checkout lock exists to prevent. Judged on the
 * host git calls of a batch's tasks, before each runs.
 */
export class CheckoutWatch {
  private readonly staged = new Map<string, string>();

  constructor(private readonly report: (violation: Violation) => void) {}

  /** A git call about to run on behalf of `taskId` (null outside a batch's tasks: not judged). */
  observe(taskId: string | null, args: readonly string[], cwd: string, step: number): void {
    if (taskId === null) return;
    const command = commandOf(args);
    if (command === null || !MUTATING.has(command.name)) return;
    const phrase = command.name === "merge" && command.rest.includes("--abort") ? "merge --abort" : command.name;
    const tree = workTreeOf(args, cwd);
    const owner = this.staged.get(tree);
    if (owner !== undefined && owner !== taskId) {
      this.report({
        invariant: "I7",
        step,
        statement: `task ${taskId} ran git ${phrase} on ${tree} while task ${owner}'s tentative merge was staged there: two finalizes overlapped on one checkout`,
        key: `I7:checkout-overlap:${phrase}`,
      });
      return;
    }
    if (phrase === "merge") this.staged.set(tree, taskId);
    else if (owner === taskId && ENDS_STAGING.has(phrase)) this.staged.delete(tree);
  }

  /** A task's lane ended: whatever it left staged is no longer a finalize in flight. */
  taskEnded(taskId: string): void {
    for (const [tree, owner] of this.staged) if (owner === taskId) this.staged.delete(tree);
  }
}
