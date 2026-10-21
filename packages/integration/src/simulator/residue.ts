import { access, readdir } from "node:fs/promises";
import { z } from "zod";
import type { GitRunner } from "@ashara/execution-infra";
import type { WorkItemStatus } from "@ashara/delivery";
import { describeErrorChain } from "@ashara/shared";
import type { FakeCell } from "./fake-podman.js";
import type { QueryPlant } from "./faults.js";
import type { Snapshot, Violation } from "./invariants.js";

/**
 * The statuses after which nothing of a work item runs again on the host: Abandoned is terminal (a
 * give-up, a supersession or a client's stop alike), and a Completed item's work is on main. The one
 * edge out of Completed reopens it to Pending, and an item seen out of these is not judged.
 */
const SETTLED: ReadonlySet<string> = new Set(["Completed", "Abandoned"] satisfies readonly WorkItemStatus[]);

/** The label every cell carries naming the work item it runs for (the podman contract the substrate writes). */
const CELL_TASK_LABEL = "ashara.task";

/** What the host holds that names a work item: branches, worktree registrations, directories, cells. */
interface HostResidue {
  readonly branches: readonly string[];
  readonly worktrees: ReadonlyArray<{ readonly path: string; readonly branch: string | null }>;
  readonly directories: readonly string[];
  readonly cells: readonly FakeCell[];
}

/** The observer could not read what the host holds: the residue clause cannot be judged, so the run fails. */
class ResidueUnreadable extends Error {
  constructor(
    readonly what: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`the residue clause could not read ${what} at ${path}: ${describeErrorChain(cause)}`, { cause });
    this.name = "ResidueUnreadable";
  }
}

const absentPath = z.object({ code: z.literal("ENOENT") });

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (absentPath.safeParse(err).success) return false;
    throw new ResidueUnreadable("whether the path exists", path, err);
  }
}

async function gitText(git: GitRunner, repository: string, args: readonly string[]): Promise<string> {
  try {
    return (await git.text({ args, cwd: repository })).stdout;
  } catch (err) {
    throw new ResidueUnreadable(`git ${args.join(" ")}`, repository, err);
  }
}

/** `git worktree list --porcelain`: blank-line separated records, each `worktree <path>` then its attributes. */
function parseWorktrees(porcelain: string): Array<{ path: string; branch: string | null }> {
  const records: Array<{ path: string; branch: string | null }> = [];
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line !== "");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) continue;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    records.push({ path, branch: ref === null ? null : ref.replace(/^refs\/heads\//, "") });
  }
  return records;
}

/**
 * What the host holds for one project: every branch but main and every worktree but the main
 * checkout of the target at `repository`, every directory directly under `workdirBase`, and every
 * cell still running. Read through the run's git broker, never a faulted seam. A target with no
 * repository yet holds no branch or worktree.
 */
async function readHostResidue(
  git: GitRunner,
  workdirBase: string,
  repository: string | null,
  cells: readonly FakeCell[],
): Promise<HostResidue> {
  let branches: string[] = [];
  let worktrees: Array<{ path: string; branch: string | null }> = [];
  if (repository !== null && (await exists(`${repository}/.git`))) {
    branches = (await gitText(git, repository, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]))
      .split("\n")
      .filter((name) => name !== "" && name !== "main");
    worktrees = parseWorktrees(await gitText(git, repository, ["worktree", "list", "--porcelain"])).filter(
      (tree) => tree.path !== repository,
    );
  }
  let directories: string[];
  try {
    directories = (await readdir(workdirBase, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    throw new ResidueUnreadable("the workdir base's entries", workdirBase, err);
  }
  return { branches, worktrees, directories, cells };
}

/**
 * I7, the residue clause, judged at the end of a run: for every settled work item (SETTLED), no
 * branch, no worktree registration, no directory under the workdir base and no running cell that
 * names it remains. Whatever path settled the item (a merge, a give-up, a supersession, a stop),
 * what it held on the host is released; one left is a cleanup a non-happy path skipped.
 *
 * An item is named here by its id appearing in the branch, the worktree's path or branch, the
 * directory's name, or the cell's task label: the oracle states no branch naming of production's,
 * so a branch of any kind that carries the id is judged.
 *
 * Judged only for an item a fault-free cycle ran to its end after it was first seen settled
 * (ResidueWatch): production releases a settled item's holdings on the cycle after it settles, and a
 * cycle that carried a fault may have had its release faulted, which the next cycle retries.
 *
 * Blind spots: real podman (the fake runtime's table is what is judged, not a container a real
 * runtime failed to remove), the system temporary directory and anything outside the workdir base
 * (the cell's state directories, the run's key directory), the target's other refs (tags, notes,
 * remote-tracking refs, stashes), and every path the simulator does not drive (the owner's HTTP
 * status change, a project deleted outright). The continuous runner itself is not run: run.ts
 * reproduces its order (full cycles until one stops, then onHalt's cell teardown and halted cycles
 * only), so a change to that order the runner makes and run.ts does not is not judged. A run whose
 * every cycle after an item settled carried a fault does not judge that item.
 */
export async function checkResidue(
  step: number,
  snapshot: Snapshot,
  judgeable: (itemId: string) => boolean,
  host: { readonly git: GitRunner; readonly workdirBase: string; readonly cells: readonly FakeCell[] },
): Promise<Violation[]> {
  const settled = snapshot.items.filter((item) => SETTLED.has(item.status) && judgeable(item.id));
  if (settled.length === 0) return [];
  const residue = await readHostResidue(host.git, host.workdirBase, snapshot.project.workspacePath, host.cells);
  const violations: Violation[] = [];
  for (const item of settled) {
    const left = [
      ...residue.branches
        .filter((branch) => branch.includes(item.id))
        .map((branch) => ({ kind: "branch", what: `branch ${branch}` })),
      ...residue.worktrees
        .filter((tree) => tree.path.includes(item.id) || (tree.branch !== null && tree.branch.includes(item.id)))
        .map((tree) => ({ kind: "worktree", what: `worktree ${tree.path} (${tree.branch ?? "detached"})` })),
      ...residue.directories
        .filter((name) => name.includes(item.id))
        .map((name) => ({ kind: "directory", what: `directory ${name} under the workdir base` })),
      ...residue.cells
        .filter((cell) => cell.labels[CELL_TASK_LABEL] === item.id)
        .map((cell) => ({ kind: "cell", what: `cell ${cell.name}` })),
    ];
    for (const kind of new Set(left.map((each) => each.kind))) {
      const named = left.filter((each) => each.kind === kind).map((each) => each.what);
      violations.push({
        invariant: "I7",
        step,
        statement:
          `"${item.title}" is ${item.status}, yet the host still holds its ${named.join(", ")}: a cleanup the ` +
          `path that settled it skipped`,
        key: `I7:residue:${kind}:${item.title}`,
      });
    }
  }
  return violations;
}

/**
 * When each settled item became judgeable by the residue clause: the count of fault-free cycles run
 * to their end when the item was first seen settled, against the count since. An item seen out of
 * a settled status (a reopened check task) starts again when it settles again.
 */
export class ResidueWatch {
  private cleanCycles = 0;
  private readonly settledAt = new Map<string, number>();

  /** One runCycle returned; `faultFree` when no fault was injected while it ran. */
  cycleRan(faultFree: boolean): void {
    if (faultFree) this.cleanCycles += 1;
  }

  observe(snapshot: Snapshot): void {
    for (const item of snapshot.items) {
      if (!SETTLED.has(item.status)) this.settledAt.delete(item.id);
      else if (!this.settledAt.has(item.id)) this.settledAt.set(item.id, this.cleanCycles);
    }
  }

  readonly judgeable = (itemId: string): boolean => {
    const at = this.settledAt.get(itemId);
    return at !== undefined && this.cleanCycles > at;
  };
}

const sentText = z.union([z.string(), z.object({ text: z.string() }).loose()]);
const settledParams = z.tuple([z.literal("Completed"), z.literal("Abandoned")]);

/**
 * The read of the tasks whose host holdings are released leaves out the Abandoned ones: every
 * give-up path's cleanup is skipped, and a merged task's is not. drizzle sends (query, params).
 */
export const abandonedReleaseSkipped: QueryPlant = (args) => {
  const parsed = sentText.safeParse(args[0]);
  if (!parsed.success || !settledParams.safeParse(args[1]).success) return null;
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  if (!/from "work_items" where "work_items"\."status" in \(\$1, \$2\)/.test(text)) return null;
  return [args[0], ["Completed", "Completed"], ...args.slice(2)];
};
