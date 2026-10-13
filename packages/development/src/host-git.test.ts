import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { commitMerge, tentativeMerge } from "./merge.js";
import { commitPartialWork, createWorkdir, ensureTargetGitInit, getChangedFiles } from "./workspace.js";

const run = promisify(execFile);
const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function setup(name: string): Promise<{ root: string; target: string; marker: (tag: string) => string }> {
  const root = await mkdtemp(join(tmpdir(), `ashara-host-git-${name}-`));
  scratch.push(root);
  const target = join(root, "project");
  await ensureTargetGitInit(target);
  return { root, target, marker: (tag) => join(root, `PWNED_${tag}`) };
}

async function pwned(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith("PWNED_"));
}

// What a cell can do to the trees it mounts; Z0's git on those trees must run none of it.
describe("Z0's git never runs code a cell planted", () => {
  test("a rewritten gitlink and a nested repository in the worktree", async () => {
    const { root, target, marker } = await setup("worktree");
    const { workDir, repo } = await createWorkdir(join(root, "work"), target, "task/probe");

    // The gitlink now names a git dir the cell planted, whose config runs a program.
    const planted = join(workDir, "planted");
    await run("git", ["init", "-q", "--bare", planted]);
    await run("git", ["--git-dir", planted, "config", "core.bare", "false"]);
    await run("git", ["--git-dir", planted, "config", "core.fsmonitor", `touch ${marker("gitlink")}; false`]);
    await writeFile(join(workDir, ".git"), "gitdir: planted\n");

    // A nested repository with the same trap, which `add -A` registers as a gitlink.
    const nested = join(workDir, "nested");
    await mkdir(nested);
    await run("git", ["init", "-q", nested]);
    await run("git", ["-C", nested, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "n"]);
    await run("git", ["-C", nested, "config", "core.fsmonitor", `touch ${marker("nested")}; false`]);
    await writeFile(join(workDir, "work.txt"), "agent output\n");

    expect(await getChangedFiles(repo)).toContain("work.txt");
    expect(await commitPartialWork(repo, "partial")).toMatchObject({ committed: true });
    await writeFile(join(nested, "more.txt"), "x\n");
    await getChangedFiles(repo);

    expect(await pwned(root)).toEqual([]);
    // The commit landed on the real task branch, not in the planted git dir.
    const { stdout } = await run("git", ["-C", target, "log", "--format=%s", "-1", "task/probe"]);
    expect(stdout.trim()).toBe("partial");
  });

  test("a hook in the target repository does not run on the merge commit", async () => {
    const { root, target, marker } = await setup("hooks");
    const { workDir, repo } = await createWorkdir(join(root, "work"), target, "task/hooked");
    await writeFile(join(workDir, "work.txt"), "agent output\n");
    await commitPartialWork(repo, "work");

    const hook = join(target, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\ntouch ${marker("hook")}\n`);
    await chmod(hook, 0o755);
    expect((await tentativeMerge(target, "task/hooked")).status).toBe("clean");
    await commitMerge(target, "hooked");

    expect(await pwned(root)).toEqual([]);
  });
});
