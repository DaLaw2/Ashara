import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// Deterministic check execution (Phase 2, mig-phase-2).
//
// Single implementation behind both the in-process development verify() and the
// out-of-process agent-runner runInlineVerify() adapters — pure functions plus
// an injected CommandRunner, no shared runtime state.
//
// Containment is structural, not enumerative: callers inject a CommandRunner
// built from the Provisioner abstraction (provisionerAsRunner in
// execution-service.ts). The in-container path (agent-runner) injects
// defaultRunCommand because it is already inside the agent container.
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LENGTH = 2000;
export const CHECK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP check pattern — recognizes assertions like:
//   GET /path returns 200
//   POST /api/items returns 201
//   GET /:code returns 3xx  (range match)
// ---------------------------------------------------------------------------

const HTTP_CHECK_PATTERN = /^(GET|POST|PUT|DELETE|PATCH|HEAD) (\/\S+) returns (\d{3}|\dxx)(?: with (json-array|json-object|json|non-empty))?$/;

export function isHttpCheck(cmd: string): boolean {
  return HTTP_CHECK_PATTERN.test(cmd);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoreCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

export interface CoreTierResult {
  readonly status: "pass" | "fail" | "skipped" | "error";
  readonly details: string;
  readonly checks?: CoreCheckResult[];
  readonly issues?: string[];
}

export const defaultRunCommand: CommandRunner = (command, cwd, timeout) => {
  const proc = spawn(command[0], command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => proc.kill(), timeout);

  return (async () => {
    try {
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.on("close", resolve);
        proc.on("error", reject);
      });

      const combined = (stdout + stderr).trim();
      // POLICY default: null exit code (process killed by signal) is failure, not unknown.
      return { exitCode: exitCode ?? 1, output: truncateOutput(combined) };
    } finally {
      clearTimeout(timer);
    }
  })();
};

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;
  return output.slice(-MAX_OUTPUT_LENGTH);
}

// ---------------------------------------------------------------------------
// HTTP check internals
// ---------------------------------------------------------------------------

export class AppBootError extends Error {
  constructor(
    public readonly workDir: string,
    public readonly detail: string,
  ) {
    super(`HTTP check boot failed in ${workDir}: ${detail}`);
    this.name = "AppBootError";
  }
}

type BodyShape = "json-array" | "json-object" | "json" | "non-empty";

interface ParsedHttpCheck {
  readonly method: string;
  readonly path: string;
  readonly raw: string;
  readonly matchesStatus: (actual: number) => boolean;
  readonly statusLabel: string;
  readonly bodyShape: BodyShape | null;
}

function resolveTestPath(path: string): string {
  return path.replace(/:(\w+)/g, "__test__");
}

function parseHttpCheck(cmd: string): ParsedHttpCheck | null {
  const match = HTTP_CHECK_PATTERN.exec(cmd);
  if (!match) return null;
  const [, method, rawPath, statusStr, shapeStr] = match;
  const path = resolveTestPath(rawPath);
  const bodyShape = (shapeStr as BodyShape | undefined) ?? null;

  if (statusStr.endsWith("xx")) {
    const rangeDigit = parseInt(statusStr[0], 10);
    return {
      method,
      path,
      raw: cmd,
      matchesStatus: (actual) => Math.floor(actual / 100) === rangeDigit,
      statusLabel: statusStr,
      bodyShape,
    };
  }

  const expected = parseInt(statusStr, 10);
  return {
    method,
    path,
    raw: cmd,
    matchesStatus: (actual) => actual === expected,
    statusLabel: statusStr,
    bodyShape,
  };
}

const APP_STARTUP_WAIT_MS = 3_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("pickFreePort: no port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function probeHttp(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number | null; body: string; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT_MS);
  try {
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: controller.signal,
      ...(hasBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    const body = await response.text();
    return { status: response.status, body, detail: `HTTP ${response.status}` };
  } catch (e) {
    return { status: null, body: "", detail: String(e).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}

async function isHttpResponsive(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await probeHttp(port, "GET", "/");
    if (probe.status !== null) return true;
    await delay(500);
  }
  return false;
}

interface AppHandle {
  readonly port: number;
  readonly kill: () => Promise<void>;
}

async function bootApp(workDir: string): Promise<AppHandle> {
  const pkgJsonPath = join(workDir, "package.json");
  const hasPkgJson = await access(pkgJsonPath).then(() => true, () => false);
  if (!hasPkgJson) {
    throw new AppBootError(workDir, "no package.json found");
  }

  const pkgContent = await readFile(pkgJsonPath, "utf-8");
  // contract-erasing: package.json has a well-known shape (npm spec)
  const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
  // contract-erasing: scripts is Record<string, string>
  const scripts = pkg.scripts as Record<string, unknown> | undefined;

  let startCmd: string | null = null;
  if (scripts && typeof scripts.start === "string") startCmd = scripts.start;
  if (!startCmd) {
    throw new AppBootError(workDir, "no start script in package.json");
  }

  const port = await pickFreePort();
  const parts = startCmd.split(" ");
  const localBin = join(workDir, "node_modules", ".bin");
  const pathWithLocalBin =
    process.env.PATH !== undefined && process.env.PATH !== ""
      ? `${localBin}${delimiter}${process.env.PATH}`
      : localBin;

  const proc = spawn(parts[0], parts.slice(1), {
    cwd: workDir,
    env: { ...process.env, PATH: pathWithLocalBin, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const hasProcExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  const signalProc = (signal: NodeJS.Signals): void => {
    if (proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch (e: unknown) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) {
          console.warn(`[checkRunner] Failed to signal process group ${proc.pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    try {
      proc.kill(signal);
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) {
        console.warn(`[checkRunner] Failed to signal process ${proc.pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  const killProc = async (): Promise<void> => {
    if (hasProcExited()) return;
    const exited = new Promise<void>((r) => {
      if (hasProcExited()) { r(); return; }
      proc.once("exit", () => r());
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

  const startup = await new Promise<StartupOutcome>((resolve) => {
    proc.on("error", (error: NodeJS.ErrnoException) => resolve({ kind: "spawn-error", error }));
    proc.on("close", () => resolve({ kind: "exited" }));
    setTimeout(() => resolve({ kind: "running" }), APP_STARTUP_WAIT_MS);
  });

  if (startup.kind === "spawn-error") {
    throw new AppBootError(workDir, `spawn error: ${startup.error.message}`);
  }
  if (startup.kind === "exited") {
    throw new AppBootError(workDir, `process exited immediately: ${(stdout + stderr).slice(0, 500)}`);
  }

  let detectedPort: number | null = (await isHttpResponsive(port)) ? port : null;
  if (detectedPort === null) {
    const portMatch = (stdout + stderr).match(/(?:listening|started|port)\s*(?:on\s*)?:?\s*(\d{2,5})/i);
    if (portMatch) {
      const parsedPort = parseInt(portMatch[1], 10);
      if (parsedPort !== port && (await isHttpResponsive(parsedPort))) {
        detectedPort = parsedPort;
      }
    }
  }

  if (detectedPort === null) {
    await killProc();
    throw new AppBootError(
      workDir,
      `app started but not responding on port ${port}: ${(stdout + stderr).slice(0, 500)}`,
    );
  }

  return { port: detectedPort, kill: killProc };
}

export function validateBodyShape(body: string, shape: BodyShape): { valid: boolean; actual: string } {
  switch (shape) {
    case "non-empty":
      return { valid: body.length > 0, actual: body.length > 0 ? "non-empty" : "empty" };
    case "json": {
      try {
        JSON.parse(body);
        return { valid: true, actual: "valid JSON" };
      } catch {
        return { valid: false, actual: "invalid JSON" };
      }
    }
    case "json-array": {
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) return { valid: true, actual: "json-array" };
        if (parsed === null) return { valid: false, actual: "null" };
        return { valid: false, actual: typeof parsed === "object" ? "object" : typeof parsed };
      } catch {
        return { valid: false, actual: "invalid JSON" };
      }
    }
    case "json-object": {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { valid: true, actual: "json-object" };
        }
        if (parsed === null) return { valid: false, actual: "null" };
        if (Array.isArray(parsed)) return { valid: false, actual: "array" };
        return { valid: false, actual: typeof parsed };
      } catch {
        return { valid: false, actual: "invalid JSON" };
      }
    }
  }
}

async function executeHttpChecks(
  workDir: string,
  checks: string[],
): Promise<CoreCheckResult[]> {
  const parsed = checks
    .map(parseHttpCheck)
    .filter((p): p is ParsedHttpCheck => p !== null);
  if (parsed.length === 0) return [];

  let app: AppHandle;
  try {
    app = await bootApp(workDir);
  } catch (e) {
    const detail = e instanceof AppBootError ? e.detail : String(e);
    return checks.map((cmd) => ({
      name: cmd,
      passed: false,
      output: `failed to boot app for HTTP check: ${detail}`,
    }));
  }

  try {
    const results: CoreCheckResult[] = [];
    for (const check of parsed) {
      const probe = await probeHttp(app.port, check.method, check.path);
      if (probe.status === null) {
        results.push({
          name: check.raw,
          passed: false,
          output: `no response: ${probe.detail}`,
        });
        continue;
      }

      const statusPassed = check.matchesStatus(probe.status);
      if (!statusPassed) {
        results.push({
          name: check.raw,
          passed: false,
          output: `${check.method} ${check.path} -> ${probe.status} (expected ${check.statusLabel})`,
        });
        continue;
      }

      if (check.bodyShape !== null) {
        const shapeResult = validateBodyShape(probe.body, check.bodyShape);
        results.push({
          name: check.raw,
          passed: shapeResult.valid,
          output: shapeResult.valid
            ? `${check.method} ${check.path} -> ${probe.status} (expected ${check.statusLabel}), body: ${check.bodyShape}`
            : `${check.method} ${check.path} -> ${probe.status} (expected ${check.statusLabel}), expected ${check.bodyShape}, got ${shapeResult.actual}`,
        });
      } else {
        results.push({
          name: check.raw,
          passed: true,
          output: `${check.method} ${check.path} -> ${probe.status} (expected ${check.statusLabel})`,
        });
      }
    }
    return results;
  } finally {
    await app.kill();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeterministicOutcome {
  readonly tier: CoreTierResult;
}

export async function runDeterministicChecks(
  run: CommandRunner,
  workDir: string,
  customChecks: string[],
): Promise<DeterministicOutcome> {
  const shellChecks = customChecks.filter((c) => !isHttpCheck(c));
  const httpChecks = customChecks.filter(isHttpCheck);

  const results: CoreCheckResult[] = [];
  let allPassed = true;

  for (const cmd of shellChecks) {
    const { exitCode, output } = await run(["sh", "-c", cmd], workDir, CHECK_TIMEOUT_MS);
    const passed = exitCode === 0;
    if (!passed) allPassed = false;
    results.push({ name: cmd, passed, output });
  }

  if (httpChecks.length > 0) {
    const httpResults = await executeHttpChecks(workDir, httpChecks);
    for (const r of httpResults) {
      if (!r.passed) allPassed = false;
      results.push(r);
    }
  }

  // The identity element of a conjunction always reads as "fine" — a property
  // of arithmetic, not evidence about the world (Discipline A). An empty loop
  // that never falsified allPassed must not be reported as "pass".
  if (results.length === 0) {
    return {
      tier: {
        status: "skipped",
        details: "no checks executed — nothing to verify",
        checks: [],
      },
    };
  }

  const failCount = results.filter((r) => !r.passed).length;

  return {
    tier: {
      status: allPassed ? "pass" : "fail",
      details: allPassed
        ? `All ${results.length} checks passed`
        : `${failCount}/${results.length} checks failed`,
      checks: results,
    },
  };
}
