import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { deriveEndpoints } from "./endpoints.js";
import { ROUTE_REGISTRATION_PATTERN, SOURCE_FILE_PATTERN } from "./internal.js";
import type { GateResult } from "./types.js";
import { prepare, ToolchainError } from "../project-toolchain.js";
import type { ToolchainDeps, ToolchainLogFn, ToolchainResult } from "../project-toolchain.js";
import type { CommandRunner } from "../verify-core.js";

const execFileAsync = promisify(execFile);

export interface SmokeTestDeps {
  /** Toolchain preparer (install + codegen), run before boot. Default: real prepare(). */
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<ToolchainResult>;
  /** Runner passed to prepare(). The boot itself is always a real process. */
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

// ---------------------------------------------------------------------------
// Smoke test — start the target project, then probe every derived endpoint.
// A 404 proves the route is not mounted at runtime (400/401/422/500 all prove
// it is). An unreachable server or unresolvable port is a FAILURE, never a
// silent pass (E2E Run 7: unparseable port made smoke pass while all /api/*
// routes 404ed unseen).
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("pickFreePort: server.address() returned no port")));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface ProbeResult {
  readonly status: number | null;
  readonly detail: string;
}

async function probeEndpoint(port: number, method: string, path: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: controller.signal,
      ...(hasBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    return { status: response.status, detail: `HTTP ${response.status}` };
  } catch (e) {
    return { status: null, detail: String(e).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}

async function isHttpResponsive(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await probeEndpoint(port, "GET", "/");
    if (probe.status !== null) return true;
    await delay(500);
  }
  return false;
}

export async function runSmokeTest(
  targetProjectPath: string,
  deps: SmokeTestDeps = {},
  contractEntryPoint: string | null = null,
): Promise<GateResult> {
  try {
    const pkgJsonPath = join(targetProjectPath, "package.json");
    const hasPkgJson = await access(pkgJsonPath).then(
      () => true,
      () => false,
    );
    if (!hasPkgJson) {
      return { passed: false, output: "no package.json — cannot determine start command" };
    }

    // Reproduce the project's build semantics BEFORE boot: install dependencies
    // and run codegen so the started process resolves its imports (a start
    // script needs real node_modules; a prisma app needs the generated client).
    // Fail-closed: a toolchain failure fails the gate with the typed context
    // rather than booting an unprepared tree that would crash unexplained.
    const prepareFn = deps.prepareToolchain ?? prepare;
    try {
      await prepareFn(targetProjectPath, { runCommand: deps.toolchainRunner, log: deps.toolchainLog });
    } catch (e: unknown) {
      if (e instanceof ToolchainError) {
        const ctx = e.context;
        const excerpt = ctx.outputExcerpt ? `; output: ${ctx.outputExcerpt.slice(0, 300)}` : "";
        return {
          passed: false,
          output:
            `toolchain preparation failed at step "${e.step}": ${ctx.detail}` +
            (ctx.command ? ` [${ctx.command.join(" ")}]` : "") +
            (ctx.exitCode !== undefined ? ` (exit ${ctx.exitCode})` : "") +
            excerpt,
        };
      }
      return { passed: false, output: `toolchain preparation error: ${String(e).slice(0, 500)}` };
    }

    const pkgContent = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, unknown> | undefined;

    let startCmd: string | null = null;
    if (scripts && typeof scripts.start === "string") {
      startCmd = scripts.start;
    }

    if (!startCmd && contractEntryPoint !== null) {
      const exists = await access(join(targetProjectPath, contractEntryPoint)).then(
        () => true,
        () => false,
      );
      if (exists) {
        startCmd = `node ${contractEntryPoint}`;
      }
    }

    if (!startCmd) {
      return { passed: false, output: "no start script or entry point found" };
    }

    const assignedPort = await pickFreePort();

    const parts = startCmd.split(" ");
    // Match `npm start` behavior: the target project's node_modules/.bin must
    // be on PATH so bare binaries in start scripts (ts-node, nodemon) resolve.
    const localBin = join(targetProjectPath, "node_modules", ".bin");
    const pathWithLocalBin =
      process.env.PATH !== undefined && process.env.PATH !== ""
        ? `${localBin}${delimiter}${process.env.PATH}`
        : localBin;
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: targetProjectPath,
      env: {
        ...process.env,
        PATH: pathWithLocalBin,
        NODE_ENV: "production",
        PORT: String(assignedPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Fail-safe reap (finding f, E2E Run 11): a smoke-boot app was left orphaned
    // in the process table because the old killProc sent a single un-awaited
    // SIGTERM and never escalated. Signal the whole boot process group (proc is
    // spawned detached, so it leads one), AWAIT exit, and escalate to SIGKILL so
    // no booted app survives the gate.
    const hasProcExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
    const signalProc = (signal: NodeJS.Signals): void => {
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          // process group already gone or not detached — fall through to direct kill
        }
      }
      try {
        proc.kill(signal);
      } catch {
        // already reaped — nothing to signal
      }
    };
    const killProc = async (): Promise<void> => {
      if (hasProcExited()) return;
      const exited = new Promise<void>((resolveExit) => {
        if (hasProcExited()) {
          resolveExit();
          return;
        }
        proc.once("exit", () => resolveExit());
      });
      signalProc("SIGTERM");
      await Promise.race([exited, delay(2000)]);
      if (hasProcExited()) return;
      signalProc("SIGKILL");
      await Promise.race([exited, delay(2000)]);
    };

    type StartupOutcome =
      | { readonly kind: "spawn-error"; readonly error: NodeJS.ErrnoException }
      | { readonly kind: "exited" }
      | { readonly kind: "running" };

    const startup = await new Promise<StartupOutcome>((resolveStartup) => {
      // The 'error' listener stays attached for the process lifetime so a
      // later kill/signal failure can never become an uncaught exception.
      proc.on("error", (error: NodeJS.ErrnoException) =>
        resolveStartup({ kind: "spawn-error", error }),
      );
      proc.on("close", () => resolveStartup({ kind: "exited" }));
      setTimeout(() => resolveStartup({ kind: "running" }), 3000);
    });

    if (startup.kind === "spawn-error") {
      return {
        passed: false,
        output:
          `smoke test failed: could not spawn start command "${startCmd}"` +
          ` (${startup.error.code ?? "unknown code"}: ${startup.error.message}).` +
          ` The command's binary was not found or not executable even with` +
          ` ${localBin} on PATH — check that the start script's binary is installed.`,
      };
    }

    if (startup.kind === "exited") {
      return {
        passed: false,
        output: `process crashed: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
      };
    }

    try {
      // Strategy 1: the port we assigned via the PORT env var.
      // Strategy 2 (fallback): a port the app printed to stdout/stderr, for
      // apps that ignore PORT. If neither responds, the smoke test FAILS.
      let port: number | null = (await isHttpResponsive(assignedPort)) ? assignedPort : null;
      let parsedPort: number | null = null;
      if (port === null) {
        const portMatch = (stdout + stderr).match(
          /(?:listening|started|port)\s*(?:on\s*)?:?\s*(\d{2,5})/i,
        );
        if (portMatch) {
          parsedPort = parseInt(portMatch[1], 10);
          if (parsedPort !== assignedPort && (await isHttpResponsive(parsedPort))) {
            port = parsedPort;
          }
        }
      }

      if (port === null) {
        return {
          passed: false,
          output: [
            `smoke test failed: process is running but returned no HTTP response on assigned port ${assignedPort}` +
              (parsedPort !== null
                ? ` or stdout-parsed port ${parsedPort}`
                : " (no port found in stdout/stderr)"),
            `stdout: ${stdout.slice(0, 300)}`,
            `stderr: ${stderr.slice(0, 300)}`,
          ].join("\n"),
        };
      }

      const derivation = await deriveEndpoints(targetProjectPath, contractEntryPoint);
      const notes =
        derivation.notes.length > 0 ? ` (notes: ${derivation.notes.join("; ")})` : "";

      if (derivation.endpoints.length === 0) {
        console.log(
          `smoke test: zero endpoints derived from ${targetProjectPath} — falling back to GET / check${notes}`,
        );
        const probe = await probeEndpoint(port, "GET", "/");
        if (probe.status !== null && probe.status < 500) {
          return {
            passed: true,
            output: `process started, zero endpoints derived${notes}, GET / returned ${probe.status}`,
          };
        }
        return {
          passed: false,
          output: `process started but GET / ${probe.status !== null ? `returned ${probe.status}` : `got no response (${probe.detail})`} — zero endpoints derived${notes}`,
        };
      }

      const failures: string[] = [];
      for (const endpoint of derivation.endpoints) {
        const probe = await probeEndpoint(port, endpoint.method, endpoint.path);
        if (probe.status === 404) {
          failures.push(`  - ${endpoint.method} ${endpoint.path} → 404 (route not mounted)`);
        } else if (probe.status === null) {
          failures.push(`  - ${endpoint.method} ${endpoint.path} → no response (${probe.detail})`);
        }
      }

      if (failures.length > 0) {
        return {
          passed: false,
          output: [
            `smoke test failed: ${failures.length} of ${derivation.endpoints.length} derived endpoint(s) unreachable on port ${port}:`,
            ...failures,
            "A 404 means the route is not mounted at runtime even though its source file exists. " +
              `Likely cause: the entry point no longer mounts the router.${notes}`,
          ].join("\n"),
        };
      }

      return {
        passed: true,
        output: `smoke test passed: ${derivation.endpoints.length} endpoint(s) probed on port ${port}, none returned 404${notes}`,
      };
    } finally {
      await killProc();
    }
  } catch (e) {
    return { passed: false, output: `smoke test error: ${String(e).slice(0, 500)}` };
  }
}
