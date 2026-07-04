import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// GIT-SAFETY (b, mig-phase-2 t2)
//
// The agent-runner subprocess's OS-level working directory must be the task's
// own worktree (workDir), never the Ashara repo checkout (asharaSourceDir).
// The coding agent's command-policy (agent-runner/tools/command-policy.ts)
// allows destructive git subcommands (reset, checkout, restore, stash) and
// only validates PATH ARGUMENTS against the agent's configured workingDir —
// it does not, and cannot, validate the process's actual cwd. If the spawned
// process's cwd were the Ashara repo, a destructive git command with no path
// argument (e.g. `git reset --hard`) would run against this repository.
//
// runnerScript is resolved to an ABSOLUTE path independent of the spawn cwd:
// asharaSourceDir defaults to "." (server/src/config.ts), so once cwd is
// workDir, a relative runnerScript would resolve against the wrong directory
// and `npx tsx <script>` would fail to find it.
// ---------------------------------------------------------------------------

export interface AgentSpawnLocation {
  /** The subprocess's OS-level working directory: always the task's own worktree. */
  readonly cwd: string;
  /** Absolute path to agent-runner's entry point, independent of `cwd`. */
  readonly runnerScript: string;
}

export function buildAgentSpawnLocation(
  asharaSourceDir: string,
  workDir: string,
): AgentSpawnLocation {
  return {
    cwd: workDir,
    runnerScript: resolve(asharaSourceDir, "packages/agent-runner/src/runner.ts"),
  };
}
