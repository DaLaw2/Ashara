import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AsharaRootNotFound } from "./errors.js";

// ---------------------------------------------------------------------------
// CWD-independent Ashara root anchoring (rp-t2 — CWD blindness)
//
// A process whose cwd is not the Ashara source checkout (the agent subprocess
// once ran in the task's worktree) mis-resolves a cwd-relative config default:
// config/models.toml is not found and routing profiles fall through to
// capability logic. Observed live (Run 11 attempt 1, $1.48 burned).
//
// Anchoring to THIS module's on-disk location (import.meta.url) instead of
// process.cwd() makes those defaults correct by construction whatever the cwd.
// The @ashara/model-access package always resolves into the same repo checkout
// the server runs from (workspace/symlinked node_modules), so import.meta.url
// points inside that checkout.
// ---------------------------------------------------------------------------

/**
 * Resolves the Ashara monorepo root by walking up from this module's on-disk
 * directory until a directory carrying the monorepo signature is found (a
 * `config/models.toml` file and a `packages/` directory). CWD-independent by
 * design — see the module header for why process.cwd() cannot be trusted.
 *
 * Throws {@link AsharaRootNotFound} when no ancestor matches (e.g. a bundle
 * outside the repo): the cwd would be an evidence default, a directory that
 * merely happens to be where the process started.
 */
function resolveAsharaRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parsePath(dir);
  const searched: string[] = [];

  for (;;) {
    searched.push(dir);
    if (
      existsSync(join(dir, "config", "models.toml")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }

  throw new AsharaRootNotFound(searched);
}

/**
 * Resolves the models.toml path the same way for every reader of that file
 * (routing profiles, thinking policy). Precedence, highest first:
 *   1. an explicit `configPath` argument (test/caller override),
 *   2. the `ASHARA_MODELS_CONFIG` env var (operator override),
 *   3. the module-anchored repo default `<ashara-root>/config/models.toml`.
 * The default is anchored to the Ashara checkout via `resolveAsharaRoot()`, not
 * to process.cwd(): a process whose cwd is elsewhere silently fails to find a
 * cwd-relative default.
 */
export function resolveModelsConfigPath(configPath?: string): string {
  return configPath
    ?? loadModelsConfigPathEnvOverride()
    ?? join(resolveAsharaRoot(), "config", "models.toml");
}

/** Optional operator override for the models.toml config path (`ASHARA_MODELS_CONFIG`). */
function loadModelsConfigPathEnvOverride(): string | undefined {
  const value = process.env["ASHARA_MODELS_CONFIG"];
  if (!value || value.trim() === "") return undefined;
  return value;
}
