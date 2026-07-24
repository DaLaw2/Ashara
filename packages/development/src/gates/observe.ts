import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

import type { ProductObservation, EndpointProbe } from "@ashara/shared";
import { deriveEndpoints } from "./endpoints.js";
import { prepare, ToolchainError } from "../project-toolchain.js";
import type { ToolchainDeps, ToolchainLogFn } from "../project-toolchain.js";
import type { CommandRunner } from "../verify-core.js";

export interface ObserveDeps {
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<unknown>;
  readonly toolchainRunner?: CommandRunner;
  readonly toolchainLog?: ToolchainLogFn;
}

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

async function probeEndpoint(port: number, method: string, path: string): Promise<EndpointProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: controller.signal,
      ...(hasBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    return { method, path, status: response.status, detail: `HTTP ${response.status}` };
  } catch (e) {
    return { method, path, status: null, detail: String(e).slice(0, 200) };
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

export async function observeProduct(
  targetProjectPath: string,
  deps: ObserveDeps = {},
  contractEntryPoint: string | null = null,
  contractEndpoints?: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): Promise<ProductObservation> {
  const pkgJsonPath = join(targetProjectPath, "package.json");
  const hasPkgJson = await access(pkgJsonPath).then(() => true, () => false);
  if (!hasPkgJson) {
    return { booted: false, port: null, endpoints: [], bootOutput: "no package.json" };
  }

  const prepareFn = deps.prepareToolchain ?? prepare;
  try {
    await prepareFn(targetProjectPath, { runCommand: deps.toolchainRunner, log: deps.toolchainLog });
  } catch (e: unknown) {
    const msg = e instanceof ToolchainError
      ? `toolchain failed at "${e.step}": ${e.context.detail}`
      : `toolchain error: ${String(e).slice(0, 500)}`;
    return { booted: false, port: null, endpoints: [], bootOutput: msg.slice(0, 4000) };
  }

  const pkgContent = await readFile(pkgJsonPath, "utf-8");
  const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
  const scripts = pkg.scripts as Record<string, unknown> | undefined;

  let startCmd: string | null = null;
  if (scripts && typeof scripts.start === "string") startCmd = scripts.start;
  if (!startCmd && contractEntryPoint !== null) {
    const exists = await access(join(targetProjectPath, contractEntryPoint)).then(() => true, () => false);
    if (exists) startCmd = `node ${contractEntryPoint}`;
  }
  if (!startCmd) {
    return { booted: false, port: null, endpoints: [], bootOutput: "no start script or entry point" };
  }

  const assignedPort = await pickFreePort();
  const parts = startCmd.split(" ");
  const localBin = join(targetProjectPath, "node_modules", ".bin");
  const pathWithLocalBin =
    process.env.PATH !== undefined && process.env.PATH !== ""
      ? `${localBin}${delimiter}${process.env.PATH}`
      : localBin;

  const proc = spawn(parts[0], parts.slice(1), {
    cwd: targetProjectPath,
    env: { ...process.env, PATH: pathWithLocalBin, NODE_ENV: "production", PORT: String(assignedPort) },
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
      try { process.kill(-proc.pid, signal); return; } catch { /* group gone */ }
    }
    try { proc.kill(signal); } catch { /* reaped */ }
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
    setTimeout(() => resolve({ kind: "running" }), 3000);
  });

  const bootOutput = (): string => `${stdout}\n${stderr}`.slice(0, 4000);

  if (startup.kind === "spawn-error") {
    return { booted: false, port: null, endpoints: [], bootOutput: `spawn error: ${startup.error.message}`.slice(0, 4000) };
  }
  if (startup.kind === "exited") {
    return { booted: false, port: null, endpoints: [], bootOutput: `process crashed: ${bootOutput()}` };
  }

  try {
    let port: number | null = (await isHttpResponsive(assignedPort)) ? assignedPort : null;
    if (port === null) {
      const portMatch = (stdout + stderr).match(/(?:listening|started|port)\s*(?:on\s*)?:?\s*(\d{2,5})/i);
      if (portMatch) {
        const parsedPort = parseInt(portMatch[1], 10);
        if (parsedPort !== assignedPort && (await isHttpResponsive(parsedPort))) {
          port = parsedPort;
        }
      }
    }

    if (port === null) {
      return { booted: false, port: null, endpoints: [], bootOutput: `no HTTP response on port ${assignedPort}: ${bootOutput()}` };
    }

    const derivation = await deriveEndpoints(targetProjectPath, contractEntryPoint);
    const seen = new Set<string>();
    const merged: Array<{ method: string; path: string }> = [];
    for (const ep of derivation.endpoints) {
      const key = `${ep.method} ${ep.path}`;
      if (!seen.has(key)) { seen.add(key); merged.push(ep); }
    }
    if (contractEndpoints) {
      for (const ep of contractEndpoints) {
        const key = `${ep.method} ${ep.path}`;
        if (!seen.has(key)) { seen.add(key); merged.push(ep); }
      }
    }
    const endpointsToProbe = merged.length > 0
      ? merged
      : [{ method: "GET" as const, path: "/" }];

    const probes: EndpointProbe[] = [];
    for (const ep of endpointsToProbe) {
      probes.push(await probeEndpoint(port, ep.method, ep.path));
    }

    return { booted: true, port, endpoints: probes, bootOutput: bootOutput() };
  } finally {
    await killProc();
  }
}
