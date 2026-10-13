import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostRepo } from "@ashara/execution-infra";

class HostRepoUnresolved extends Error {
  constructor(
    readonly workDir: string,
    readonly targetProjectPath: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`cannot resolve the git dir of worktree ${JSON.stringify(workDir)} of ${JSON.stringify(targetProjectPath)}: ${reason}`, options);
    this.name = "HostRepoUnresolved";
  }
}

/** The target checkout. Its `.git` is reachable only by the verifier cell, which mounts it read-only. */
export function targetRepo(targetProjectPath: string): HostRepo {
  return { gitDir: join(targetProjectPath, ".git"), workTree: targetProjectPath };
}

/**
 * Reads a linked worktree's git dir from the gitlink `git worktree add` just wrote. Only valid
 * before any cell has mounted the worktree; the result is then carried, never re-read.
 */
export async function freshWorktreeRepo(targetProjectPath: string, workDir: string): Promise<HostRepo> {
  let gitlink: string;
  try {
    gitlink = await readFile(join(workDir, ".git"), "utf8");
  } catch (err) {
    throw new HostRepoUnresolved(workDir, targetProjectPath, "the gitlink cannot be read", { cause: err });
  }
  const match = /^gitdir: (.+)\n?$/.exec(gitlink);
  if (match?.[1] === undefined) {
    throw new HostRepoUnresolved(workDir, targetProjectPath, `the gitlink is not "gitdir: <path>": ${JSON.stringify(gitlink.slice(0, 200))}`);
  }
  let gitDir: string;
  let adminRoot: string;
  try {
    gitDir = await realpath(resolve(workDir, match[1]));
    adminRoot = await realpath(join(targetProjectPath, ".git", "worktrees"));
  } catch (err) {
    throw new HostRepoUnresolved(workDir, targetProjectPath, `the gitlink names ${JSON.stringify(match[1])}, which cannot be resolved`, { cause: err });
  }
  const fromAdmin = relative(adminRoot, gitDir);
  if (fromAdmin === "" || fromAdmin.startsWith("..") || isAbsolute(fromAdmin) || fromAdmin.includes(sep)) {
    throw new HostRepoUnresolved(workDir, targetProjectPath, `the gitlink names ${JSON.stringify(gitDir)}, not a worktree admin dir of the target`);
  }
  return { gitDir, workTree: workDir };
}
