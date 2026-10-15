import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { InvalidTargetProjectPath, assertValidTargetProjectPath, sweepOrphanedWorktrees } from "./worktree.js";

// Discipline B: a target workspace lives only inside the workdir base, Ashara's own file area,
// and the startup sweep removes only task worktrees whose task is no longer active. Real
// filesystem throughout: the hazard is where a path resolves to.

const tempDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("assertValidTargetProjectPath", () => {
  test("a path inside the workdir base is accepted, whether or not it exists yet", async () => {
    const base = await makeDir("ashara-target-inside-");
    await expect(assertValidTargetProjectPath(join(base, "projects", "vision-123"), base)).resolves.toBeUndefined();
  });

  test("a path outside the workdir base, the base itself, or one that climbs out of it is refused", async () => {
    const base = await makeDir("ashara-target-base-");
    const elsewhere = await makeDir("ashara-target-elsewhere-");
    for (const target of [join(elsewhere, "project"), base, join(base, "..", "sibling", "project")]) {
      const refusal: unknown = await assertValidTargetProjectPath(target, base).catch((e: unknown) => e);
      expect(refusal, target).toBeInstanceOf(InvalidTargetProjectPath);
      expect(refusal).toMatchObject({ reason: expect.stringContaining("not inside the workdir base") });
    }
  });

  test("a symbolic link inside the base that leads out of it is refused", async () => {
    const base = await makeDir("ashara-target-link-");
    const outside = await makeDir("ashara-target-link-outside-");
    await mkdir(join(base, "projects"));
    await symlink(outside, join(base, "projects", "escape"));
    const refusal: unknown = await assertValidTargetProjectPath(join(base, "projects", "escape", "vision-1"), base).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(InvalidTargetProjectPath);
    expect(refusal).toMatchObject({ path: join(await realpath(outside), "vision-1") });
  });
});

describe("sweepOrphanedWorktrees", () => {
  test("removes task worktrees whose task is not active; keeps active ones and every other entry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const base = await makeDir("ashara-sweep-");
    for (const dir of ["task-done", "task-active", "projects", "records"]) await mkdir(join(base, dir));
    await writeFile(join(base, "task-done", "residue.txt"), "left by a crash\n");

    const sweep = await sweepOrphanedWorktrees(base, async () => ["active"]);

    expect(sweep).toEqual({ kind: "swept", removed: 1 });
    expect((await readdir(base)).sort()).toEqual(["projects", "records", "task-active"]);
    vi.restoreAllMocks();
  });

  test("a workdir base that does not exist yet is named, and the active tasks are never read", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const base = join(await makeDir("ashara-sweep-none-"), "work");
    const read = vi.fn(async () => []);
    expect(await sweepOrphanedWorktrees(base, read)).toEqual({ kind: "no-workdir-base" });
    expect(read).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("active tasks that cannot be read: failed, and no worktree is removed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = await makeDir("ashara-sweep-unread-");
    await mkdir(join(base, "task-x"));
    const cause = new Error("database unreachable");

    const sweep = await sweepOrphanedWorktrees(base, () => Promise.reject(cause));

    expect(sweep).toEqual({ kind: "failed", step: "read the active tasks", error: cause });
    expect(await readdir(base)).toEqual(["task-x"]);
    vi.restoreAllMocks();
  });
});
