import { execFile } from "node:child_process";
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

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** No GIT_* variable of Ashara's process reaches git: GIT_DIR or GIT_CONFIG_* would redirect it. */
function hostGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

/** git against an explicit git dir and work tree, hardened; rejects on a non-zero exit like execFile. */
export async function runHostGit(repo: HostRepo, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "git",
    [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...HARDENING, ...args],
    { cwd: repo.workTree, env: hostGitEnv(), maxBuffer: MAX_OUTPUT_BYTES },
  );
}

/**
 * git against an explicit git dir with no work tree: for commands that read committed objects only
 * (ls-tree, log, cat-file). Pathspecs are literal, so an owned path is never read as a glob or as
 * pathspec magic. stdout is bytes: a blob is not necessarily text.
 */
export async function runHostGitObjects(gitDir: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    [`--git-dir=${gitDir}`, "--literal-pathspecs", ...HARDENING, ...args],
    { cwd: gitDir, env: hostGitEnv(), maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer" },
  );
  return stdout;
}

/** `git init` creates the git dir, so it runs before there is a HostRepo; hardened all the same. */
export async function initHostRepo(path: string): Promise<void> {
  await execFileAsync("git", [...HARDENING, "init", "-b", "main", "--", path], { cwd: path, env: hostGitEnv() });
}
