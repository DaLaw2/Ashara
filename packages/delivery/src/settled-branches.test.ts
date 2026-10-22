import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000b1", "test");
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A target under a fresh workdir base, holding `branches` off main and a worktree of each in `worktrees`. */
function targetWithBranches(branches: readonly string[], worktrees: readonly string[] = []): { readonly base: string; readonly target: string; readonly branches: () => string[] } {
  const base = mkdtempSync(join(tmpdir(), "ashara-settled-"));
  made.push(base);
  const target = join(base, "projects", "p");
  mkdirSync(target, { recursive: true });
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["commit", "-q", "--allow-empty", "-m", "init"]);
  for (const branch of branches) git(target, ["branch", branch]);
  for (const branch of worktrees) git(target, ["worktree", "add", "-q", join(base, branch.replace(/\//g, "-")), branch]);
  return { base, target, branches: () => git(target, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"]).split("\n") };
}

/** A board read by status alone: which path set each status is not the release's business. */
function boardOf(statuses: ReadonlyMap<WorkItemId, WorkItemStatus>): { listIdsByStatus(wanted: readonly WorkItemStatus[]): Promise<WorkItemId[]> } {
  return { listIdsByStatus: async (wanted) => [...statuses].filter(([, s]) => wanted.includes(s)).map(([id]) => id) };
}

describe("releaseBranchesOfSettledTasks: branch release follows the settled status, not the path that set it", () => {
  test("every Abandoned or Completed task's branches and worktree are gone; a task still open keeps its own", async () => {
    const [abandoned, completed, abandonedCheck, pending, blockedCheck, unknown] = Array.from({ length: 6 }, () => createWorkItemId());
    const fixture = targetWithBranches(
      [`task/${abandoned}`, `task/${completed}`, `check/${abandonedCheck}`, `task/${pending}`, `check/${blockedCheck}`, `task/${unknown}`],
      [`task/${abandoned}`],
    );
    const board = boardOf(
      new Map<WorkItemId, WorkItemStatus>([
        [abandoned, "Abandoned"],
        [completed, "Completed"],
        [abandonedCheck, "Abandoned"],
        [pending, "Pending"],
        [blockedCheck, "Blocked"],
      ]),
    );

    const summary = await releaseBranchesOfSettledTasks({
      workItemRepo: board,
      projects: { listWithWorkspace: async () => [{ id: PROJECT, workspacePath: fixture.target }] },
      workdirBase: fixture.base,
      logger: recordingLogger(),
    });

    expect(summary).toEqual({ released: 3, left: 0, checkouts: 0, targetsFailed: 0 });
    expect(fixture.branches().sort()).toEqual(["main", `task/${pending}`, `check/${blockedCheck}`, `task/${unknown}`].sort());
    expect(existsSync(join(fixture.base, `task-${abandoned}`))).toBe(false);
  });

  test("every throwaway checkout a cut-short check left is removed, whichever task it ran for; a task's own worktree is kept", async () => {
    const [completed, pending] = Array.from({ length: 2 }, () => createWorkItemId());
    const fixture = targetWithBranches([`task/${pending}`], [`task/${pending}`]);
    const left = [`post-merge-checks-${completed}-s1`, `define-check-1-${pending}-s2`].map((name) => join(fixture.base, "checkouts", name));
    for (const dir of left) git(fixture.target, ["worktree", "add", "-q", "--detach", dir, "main"]);
    // A registration whose directory a crash already removed is released too.
    rmSync(left[1], { recursive: true, force: true });

    const summary = await releaseBranchesOfSettledTasks({
      workItemRepo: boardOf(new Map<WorkItemId, WorkItemStatus>([[completed, "Completed"], [pending, "Pending"]])),
      projects: { listWithWorkspace: async () => [{ id: PROJECT, workspacePath: fixture.target }] },
      workdirBase: fixture.base,
      logger: recordingLogger(),
    });

    expect(summary).toEqual({ released: 0, left: 0, checkouts: 2, targetsFailed: 0 });
    const registered = git(fixture.target, ["worktree", "list", "--porcelain"]);
    expect(registered).not.toContain("checkouts");
    expect(registered).toContain(`task-${pending}`);
    expect(existsSync(left[0])).toBe(false);
  });

  test("a target with no repository yet holds no branch, and one outside the workdir base is refused, not read", async () => {
    const fixture = targetWithBranches([]);
    const fresh = join(fixture.base, "projects", "fresh");
    const elsewhere = mkdtempSync(join(tmpdir(), "ashara-settled-outside-"));
    made.push(elsewhere);
    const summary = await releaseBranchesOfSettledTasks({
      workItemRepo: boardOf(new Map()),
      projects: {
        listWithWorkspace: async () => [
          { id: PROJECT, workspacePath: fresh },
          { id: PROJECT, workspacePath: elsewhere },
        ],
      },
      workdirBase: fixture.base,
      logger: recordingLogger(),
    });
    expect(summary).toEqual({ released: 0, left: 0, checkouts: 0, targetsFailed: 1 });
  });
});
