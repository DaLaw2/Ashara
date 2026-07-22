import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ROUTE_REGISTRATION_PATTERN, SOURCE_FILE_PATTERN } from "./internal.js";
import { observeProduct } from "./observe.js";
import type { GateResult } from "./types.js";
import type { ToolchainLogFn } from "../project-toolchain.js";
import type { CommandRunner } from "../verify-core.js";

const execFileAsync = promisify(execFile);

export interface SmokeTestDeps {
  readonly prepareToolchain?: (targetPath: string, deps?: unknown) => Promise<unknown>;
  readonly toolchainRunner?: CommandRunner;
  readonly toolchainLog?: ToolchainLogFn;
}

// ---------------------------------------------------------------------------
// Smoke trigger — beyond wiring tasks (title match), any sync whose git diff
// touched the entry point or a route file changes the HTTP surface and must
// be smoke tested (E2E Run 7: a later task rewrote src/index.ts, unmounted
// all routers, and smoke never ran again).
// ---------------------------------------------------------------------------

async function readGitBlob(repo: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], { cwd: repo });
    return stdout;
  } catch {
    return null;
  }
}

export async function detectHttpSurfaceChange(
  targetProjectPath: string,
  preSyncHead: string | null,
  contractEntryPoint: string | null = null,
): Promise<string | null> {
  let changedFiles: string[];
  try {
    // Greenfield (no pre-sync commit): everything now in HEAD came from this sync.
    // Single-ref diff (not preSyncHead..HEAD): the tentative merge (merge.ts
    // tentativeMerge) stages its result with --no-commit, so HEAD does not
    // advance past preSyncHead until commitMerge runs. A two-ref diff would
    // compare preSyncHead against itself and see nothing; `git diff <ref>`
    // compares `ref` against the working tree, which does include the merge.
    const args =
      preSyncHead !== null
        ? ["diff", "--name-only", preSyncHead]
        : ["ls-tree", "-r", "--name-only", "HEAD"];
    const { stdout } = await execFileAsync("git", args, { cwd: targetProjectPath });
    changedFiles = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (e) {
    // Fail-closed: if we cannot determine what the sync changed, run the
    // smoke test rather than silently skipping it.
    console.warn(
      `smoke trigger: git diff failed in ${targetProjectPath} — running smoke test fail-closed:`,
      e,
    );
    return "sync diff unavailable (fail-closed)";
  }

  if (contractEntryPoint !== null) {
    for (const file of changedFiles) {
      if (file === contractEntryPoint) {
        return `sync changed entry point ${file}`;
      }
    }
  }

  for (const file of changedFiles) {
    if (!SOURCE_FILE_PATTERN.test(file) || file.endsWith(".d.ts")) continue;
    let content: string | null = null;
    try {
      content = await readFile(join(targetProjectPath, file), "utf-8");
    } catch {
      // File was deleted by the sync — inspect its pre-sync version, since
      // deleting a route file also changes the HTTP surface.
      content = preSyncHead !== null ? await readGitBlob(targetProjectPath, preSyncHead, file) : null;
    }
    if (content !== null && ROUTE_REGISTRATION_PATTERN.test(content)) {
      return `sync changed route file ${file}`;
    }
  }

  return null;
}

export async function runSmokeTest(
  targetProjectPath: string,
  deps: SmokeTestDeps = {},
  contractEntryPoint: string | null = null,
): Promise<GateResult> {
  try {
    const observation = await observeProduct(targetProjectPath, {
      prepareToolchain: deps.prepareToolchain,
      toolchainRunner: deps.toolchainRunner,
      toolchainLog: deps.toolchainLog,
    }, contractEntryPoint);

    if (!observation.booted) {
      return { passed: false, output: `smoke test failed: ${observation.bootOutput}` };
    }

    const failures: string[] = [];
    for (const probe of observation.endpoints) {
      if (probe.status === 404) {
        failures.push(`  - ${probe.method} ${probe.path} → 404 (route not mounted)`);
      } else if (probe.status === null) {
        failures.push(`  - ${probe.method} ${probe.path} → no response (${probe.detail})`);
      }
    }

    if (failures.length > 0) {
      return {
        passed: false,
        output: [
          `smoke test failed: ${failures.length} of ${observation.endpoints.length} derived endpoint(s) unreachable on port ${observation.port}:`,
          ...failures,
          "A 404 means the route is not mounted at runtime even though its source file exists. " +
            "Likely cause: the entry point no longer mounts the router.",
        ].join("\n"),
      };
    }

    return {
      passed: true,
      output: `smoke test passed: ${observation.endpoints.length} endpoint(s) probed on port ${observation.port}, none returned 404`,
    };
  } catch (e) {
    return { passed: false, output: `smoke test error: ${String(e).slice(0, 500)}` };
  }
}
