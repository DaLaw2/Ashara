import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A repository as Z0 addresses it. Cells write the work tree, so Z0's git never discovers its
 * repository from that tree: a cell could rewrite a worktree's `.git` gitlink to a git dir it
 * planted, whose `core.fsmonitor` would then run on the host. The git dir is named explicitly,
 * from a place no cell can write.
 */
export interface HostRepo {
  readonly gitDir: string;
  readonly workTree: string;
}

/**
 * Configuration that would run a program, or read config from a cell-written nested repository,
 * is overridden on every call. `-c` values also reach the child processes git spawns.
 */
const HARDENING = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "submodule.recurse=false",
  "-c", "diff.ignoreSubmodules=all",
  "-c", "status.submoduleSummary=false",
];

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

/** No GIT_* variable of Ashara's process reaches git: GIT_DIR or GIT_CONFIG_* would redirect it. */
function hostGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
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

/** git against an explicit git dir and work tree, hardened; rejects on a non-zero exit like execFile. */
export async function runHostGit(repo: HostRepo, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "git",
    [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...HARDENING, ...args],
    { cwd: repo.workTree, env: hostGitEnv(), maxBuffer: 16 * 1024 * 1024 },
  );
}

/** `git init` creates the git dir, so it runs before there is a HostRepo; hardened all the same. */
export async function initHostRepo(path: string): Promise<void> {
  await execFileAsync("git", [...HARDENING, "init", "-b", "main", "--", path], { cwd: path, env: hostGitEnv() });
}
