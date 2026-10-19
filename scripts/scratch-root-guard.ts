import path from "node:path";
import { resolveScratchRoot } from "./scratch-root.js";

// vitest's globalSetup: every temporary file a test makes goes through os.tmpdir(), which follows
// TMPDIR, so the run's TMPDIR is pinned to the resolved scratch root before any worker starts,
// whichever way vitest was started. A root that is absent or full stops the run before any test
// with ScratchRootUnavailableError, instead of letting the tests write their scratch to the disk.

/**
 * Sets `env.TMPDIR` to `root`; returns the different value it replaced, or null.
 * @testseam scratch-root.test.ts drives it with planted environments
 */
export function pinTmpdirToScratchRoot(env: Record<string, string | undefined>, root: string): string | null {
  const previous = env["TMPDIR"];
  env["TMPDIR"] = root;
  if (previous === undefined || previous === "" || path.resolve(previous) === root) return null;
  return previous;
}

/** @testseam vitest.config.ts names this file as globalSetup, a reference knip does not read */
export default function setup(): void {
  const root = resolveScratchRoot();
  const replaced = pinTmpdirToScratchRoot(process.env, root);
  if (replaced !== null) console.warn(`scratch-root-guard: TMPDIR was ${replaced}; this run's temporary files go under the scratch root ${root} instead`);
}
