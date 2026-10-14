import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkspaceSnapshotFailed } from "./errors.js";

const execFileAsync = promisify(execFile);

/** One run of the `git` binary. Absent `env` inherits the process environment; absent `maxBuffer` is execFile's own. */
interface GitInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

/**
 * Every host git call goes through this port. Both methods reject like execFile on a non-zero
 * exit: the rejection carries `code` and `stderr` (a string from `text`, a Buffer from `bytes`).
 */
export interface GitRunner {
  text(invocation: GitInvocation): Promise<{ stdout: string; stderr: string }>;
  bytes(invocation: GitInvocation): Promise<Buffer>;
}

function execOptions(invocation: GitInvocation): { cwd: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } {
  return {
    cwd: invocation.cwd,
    ...(invocation.env === undefined ? {} : { env: invocation.env }),
    ...(invocation.maxBuffer === undefined ? {} : { maxBuffer: invocation.maxBuffer }),
  };
}

/** The policy default: the host's `git`, by execFile, never a shell. */
export const execFileGitRunner: GitRunner = {
  text: (invocation) => execFileAsync("git", [...invocation.args], execOptions(invocation)),
  async bytes(invocation) {
    const { stdout } = await execFileAsync("git", [...invocation.args], { ...execOptions(invocation), encoding: "buffer" });
    return stdout;
  },
};

let gitRunner: GitRunner = execFileGitRunner;

/**
 * Chooses the runner every later host git call of this process uses. Called by the composition
 * root only: git calls are module functions here, so the choice is process-wide.
 */
export function useGitRunner(runner: GitRunner): void {
  gitRunner = runner;
}

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
  return gitRunner.text({
    args: [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...HARDENING, ...args],
    cwd: repo.workTree,
    env: hostGitEnv(),
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

/**
 * git against an explicit git dir with no work tree: for commands that read committed objects only
 * (ls-tree, log, cat-file). Pathspecs are literal, so a build context path is never read as a glob or as
 * pathspec magic. stdout is bytes: a blob is not necessarily text.
 */
export async function runHostGitObjects(gitDir: string, args: readonly string[]): Promise<Buffer> {
  return gitRunner.bytes({
    args: [`--git-dir=${gitDir}`, "--literal-pathspecs", ...HARDENING, ...args],
    cwd: gitDir,
    env: hostGitEnv(),
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

/**
 * The one commit of a cell's repository: a fixed neutral identity and date, so it carries nothing
 * of who ran Ashara, or when. No system, global or per-user config, ignore or attributes file is
 * read, so the host's git settings never shape what the cell sees.
 */
const SNAPSHOT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "workspace",
  GIT_AUTHOR_EMAIL: "workspace@cell.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "workspace",
  GIT_COMMITTER_EMAIL: "workspace@cell.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
};
const SNAPSHOT_HARDENING = [...HARDENING, "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null"];
const SNAPSHOT_BRANCH = "main";
const execFailureSchema = z.object({ code: z.unknown().optional(), stderr: z.unknown().optional() });

/**
 * Creates `gitDir`, a fresh repository whose one commit, on `main`, holds `workTree`'s content as
 * git sees it (its own ignore rules apply; any `.git` entry is never content). No remote, no other
 * ref, no hooks, no template, and no path of the host in its config: it is what a cell mounts as
 * its own repository. `workTree` is cell-written, so the same hardening as every host git call
 * applies, and nothing here ever reads `workTree`'s own `.git`. Throws WorkspaceSnapshotFailed.
 */
export async function snapshotRepository(workTree: string, gitDir: string): Promise<void> {
  const env = { ...hostGitEnv(), ...SNAPSHOT_ENV };
  const git = async (step: string, args: readonly string[]): Promise<string> => {
    const argv = [...SNAPSHOT_HARDENING, ...args];
    try {
      const { stdout } = await gitRunner.text({ args: argv, cwd: workTree, env, maxBuffer: MAX_OUTPUT_BYTES });
      return stdout.trim();
    } catch (err) {
      const failure = execFailureSchema.safeParse(err);
      const exitCode = failure.success && typeof failure.data.code === "number" ? failure.data.code : null;
      const stderr = failure.success && typeof failure.data.stderr === "string" ? failure.data.stderr : "";
      throw new WorkspaceSnapshotFailed(workTree, step, ["git", ...argv], exitCode, stderr, { cause: err });
    }
  };
  const repo = [`--git-dir=${gitDir}`];
  await git("init", ["init", "--quiet", "--bare", "--template=", `--initial-branch=${SNAPSHOT_BRANCH}`, "--", gitDir]);
  await git("config", [...repo, "config", "core.bare", "false"]);
  await git("add", [...repo, `--work-tree=${workTree}`, "add", "--all", "--", "."]);
  const tree = await git("write-tree", [...repo, "write-tree"]);
  const commit = await git("commit-tree", [...repo, "commit-tree", tree, "-m", "workspace snapshot"]);
  await git("update-ref", [...repo, "update-ref", `refs/heads/${SNAPSHOT_BRANCH}`, commit]);
}

/** `git init` creates the git dir, so it runs before there is a HostRepo; hardened all the same. */
export async function initHostRepo(path: string): Promise<void> {
  await gitRunner.text({ args: [...HARDENING, "init", "-b", "main", "--", path], cwd: path, env: hostGitEnv() });
}

/**
 * git in a directory of Ashara's own checkout, never a target's: unhardened and with the process
 * environment, as a developer's own `git` there runs.
 */
export async function runOwnRepoGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return gitRunner.text({ args, cwd });
}
