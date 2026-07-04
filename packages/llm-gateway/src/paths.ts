import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CWD-independent Ashara root anchoring (rp-t2 — subprocess CWD blindness)
//
// agent-runner subprocesses run with process.cwd() set to the task's own git
// worktree (server/agent-spawn.ts sets cwd = workDir), NOT the Ashara source
// checkout. A cwd-relative config default therefore silently mis-resolves in
// that subprocess: config/models.toml is not found and routing profiles fall
// through to capability logic. Observed live (Run 11 attempt 1, $1.48 burned).
//
// Anchoring to THIS module's on-disk location (import.meta.url) instead of
// process.cwd() makes those defaults correct by construction regardless of the
// subprocess cwd. The @ashara/llm-gateway package always resolves into the
// same repo checkout the server runs from (workspace/symlinked node_modules),
// so import.meta.url points inside that checkout in every process.
// ---------------------------------------------------------------------------

/**
 * Resolves the Ashara monorepo root by walking up from this module's on-disk
 * directory until a directory carrying the monorepo signature is found (a
 * `config/models.toml` file and a `packages/` directory). CWD-independent by
 * design — see the module header for why process.cwd() cannot be trusted in
 * agent-runner subprocesses.
 *
 * If no ancestor matches (e.g. an exotic single-file bundle outside the repo),
 * it falls back to process.cwd() to preserve the prior resolution behavior
 * rather than throwing — callers of the anchored path already degrade
 * gracefully on a missing file (see loadModelsWithFallback).
 */
export function resolveAsharaRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parsePath(dir);

  for (;;) {
    if (
      existsSync(join(dir, "config", "models.toml")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }

  return process.cwd();
}
