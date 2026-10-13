import { access, constants, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import type { ProductObservation, EndpointProbe } from "@ashara/shared";
import { deriveEndpoints } from "./endpoints.js";
import { prepare, ToolchainError } from "../project-toolchain.js";
import type { ToolchainDeps, ToolchainLogFn } from "../project-toolchain.js";
import type { CommandRunner } from "../verify-core.js";

/**
 * Product observation.
 *
 * This observer knows exactly ONE way to check a running product: probe the HTTP
 * endpoints the project DECLARES. That is a narrow competence and it is stated as
 * one — every project outside it returns `not-observable` with the reason, rather
 * than a failed boot. Run 39 observed a Go CLI, got `booted: false` with
 * "no package.json", and acceptance published that as a product defect against a
 * product that worked. A false negative dressed as a defect is worse than an
 * honest refusal.
 *
 * Nothing here may grow into a per-language launcher. A launch command is only
 * ever DERIVED from a declaration the project made about itself; when no
 * declaration answers, the ladder terminates in a refusal, never in a guess.
 */

export interface ObserveDeps {
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<unknown>;
  /**
   * Injected command runner for toolchain preparation. Required — the caller
   * at the composition root decides which runner to supply. The absence of a
   * default is the mechanism (mirroring CoreVerifyDeps.runCommand and
   * ToolchainDeps.runCommand): a caller that forgets gets a compile error,
   * not silent host execution.
   */
  readonly toolchainRunner: CommandRunner;
  readonly toolchainLog?: ToolchainLogFn;
}

export interface HttpEndpoint {
  readonly method: string;
  readonly path: string;
}

/** A launch command derived from one declaration the project made about itself. */
interface LaunchCommand {
  /** The declaration it came from, phrased for a reader of the failure detail. */
  readonly declaredBy: string;
  readonly argv: readonly [string, ...string[]];
  /** Environment this rung's command needs — scoped to the rung, never global. */
  readonly env: Readonly<Record<string, string>>;
}

const MANIFEST_FILE = "package.json";
const BOOT_WINDOW_MS = 3000;
const PROBE_TIMEOUT_MS = 3000;

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
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
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

function notObservable(
  cause: "no-declared-surface" | "no-launch-command" | "toolchain-unprepared" | "launch-failed",
  detail: string,
): ProductObservation {
  return { kind: "not-observable", cause, detail: detail.slice(0, 4000) };
}

function bootFailed(detail: string): ProductObservation {
  return { kind: "boot-failed", detail: detail.slice(0, 4000) || "the product produced no output" };
}

/**
 * The HTTP surface the project declares, from BOTH sources that count as the
 * project speaking: its ProjectContract, and its own routing code. An empty union
 * is not "nothing to check and therefore fine" — it is this observer having no
 * competence here, and the caller is told so by name.
 */
async function declaredHttpSurface(
  targetProjectPath: string,
  contractEntryPoint: string | null,
  contractEndpoints: ReadonlyArray<HttpEndpoint> | undefined,
): Promise<{ readonly endpoints: readonly HttpEndpoint[] } | { readonly derivationError: string }> {
  const seen = new Set<string>();
  const merged: HttpEndpoint[] = [];
  const add = (ep: HttpEndpoint): void => {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ method: ep.method, path: ep.path });
  };

  for (const ep of contractEndpoints ?? []) add(ep);

  try {
    const derivation = await deriveEndpoints(targetProjectPath, contractEntryPoint);
    for (const ep of derivation.endpoints) add(ep);
  } catch (e: unknown) {
    return { derivationError: e instanceof Error ? e.message : String(e) };
  }

  return { endpoints: merged };
}

/**
 * The launch ladder. Each rung reads ONE declaration the project made and either
 * answers or records why it declined; a caller that exhausts the ladder gets every
 * decline verbatim, so "I could not start this" is self-diagnosing.
 */
async function deriveLaunchCommand(
  targetProjectPath: string,
  contractEntryPoint: string | null,
  declines: string[],
): Promise<LaunchCommand | null> {
  const fromManifest = await manifestStartScript(targetProjectPath, declines);
  if (fromManifest !== null) return fromManifest;

  return executableEntryPoint(targetProjectPath, contractEntryPoint, declines);
}

/**
 * Rung 1 — the start command an npm-style manifest declares. This reads a
 * declaration ("start me like this"); it does not infer a language, and a project
 * without the manifest simply falls through instead of being called broken.
 */
async function manifestStartScript(
  targetProjectPath: string,
  declines: string[],
): Promise<LaunchCommand | null> {
  const manifestPath = join(targetProjectPath, MANIFEST_FILE);
  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch {
    declines.push(`no ${MANIFEST_FILE} at ${targetProjectPath}`);
    return null;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch (e: unknown) {
    declines.push(`${MANIFEST_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const startScript = readStartScript(manifest);
  if (startScript === null) {
    declines.push(`${MANIFEST_FILE} declares no non-empty scripts.start`);
    return null;
  }

  const argv = toArgv(startScript);
  if (argv === null) {
    declines.push(`${MANIFEST_FILE} scripts.start is blank`);
    return null;
  }

  // The manifest's own binaries: a declared start script is written expecting them
  // on PATH, so this belongs to THIS rung and to no other.
  const localBin = join(targetProjectPath, "node_modules", ".bin");
  const parentPath = process.env.PATH;
  return {
    declaredBy: `${MANIFEST_FILE} scripts.start ("${startScript}")`,
    argv,
    env: {
      PATH: parentPath !== undefined && parentPath !== "" ? `${localBin}${delimiter}${parentPath}` : localBin,
      NODE_ENV: "production",
    },
  };
}

/**
 * Rung 2 — the contract's declared entry point, when the file is executable. An
 * executable file is self-describing on POSIX (shebang or native binary), so this
 * rung runs a Go binary, a shell script, or a Python entry point without knowing
 * which it is. It deliberately refuses a non-executable entry point rather than
 * prefixing a runtime: `node <entry>` was the hardcode that made this whole
 * observer web-app-shaped.
 */
async function executableEntryPoint(
  targetProjectPath: string,
  contractEntryPoint: string | null,
  declines: string[],
): Promise<LaunchCommand | null> {
  if (contractEntryPoint === null) {
    declines.push("the ProjectContract declares no entry point");
    return null;
  }
  const entryPath = join(targetProjectPath, contractEntryPoint);
  try {
    await access(entryPath, constants.X_OK);
  } catch {
    declines.push(
      `the contract's entry point "${contractEntryPoint}" is not an executable file, so nothing states how to run it`,
    );
    return null;
  }
  return {
    declaredBy: `the ProjectContract entry point "${contractEntryPoint}" (executable)`,
    argv: [entryPath],
    env: {},
  };
}

function readStartScript(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) return null;
  const scripts: unknown = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null || !("start" in scripts)) return null;
  const start: unknown = scripts.start;
  if (typeof start !== "string") return null;
  const trimmed = start.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toArgv(command: string): readonly [string, ...string[]] | null {
  const [head, ...tail] = command.split(/\s+/).filter((part) => part.length > 0);
  return head === undefined ? null : [head, ...tail];
}


/**
 * A single required object rather than positional parameters with defaults: the
 * contract is what tells this observer which endpoints to probe and which entry
 * point to launch, and a defaulted positional made `observeProduct(path)`
 * typecheck while silently observing nothing. The caller must state the contract
 * even when it is `null`.
 */
export interface ObserveRequest {
  readonly targetProjectPath: string;
  readonly contractEntryPoint: string | null;
  readonly contractEndpoints: ReadonlyArray<HttpEndpoint> | null;
  readonly deps: ObserveDeps;
}

export async function observeProduct(request: ObserveRequest): Promise<ProductObservation> {
  const { targetProjectPath } = request;
  const deps = request.deps;
  const contractEntryPoint = request.contractEntryPoint;
  const contractEndpoints = request.contractEndpoints ?? undefined;
  // Observability is decided BEFORE anything is spawned: a product this observer
  // cannot judge is never launched, so no exit code of a CLI can be mistaken for a
  // verdict about it.
  const surface = await declaredHttpSurface(targetProjectPath, contractEntryPoint, contractEndpoints);
  if ("derivationError" in surface) {
    return notObservable(
      "no-declared-surface",
      `the declared HTTP surface of ${targetProjectPath} could not be read: ${surface.derivationError}`,
    );
  }
  const [firstEndpoint, ...otherEndpoints] = surface.endpoints;
  if (firstEndpoint === undefined) {
    return notObservable(
      "no-declared-surface",
      `${targetProjectPath} declares no HTTP endpoint — neither its ProjectContract nor its own routing code names one. ` +
        "This observer probes declared HTTP endpoints and nothing else, so it has no way to judge this product. " +
        "That is a limit of the observer, not a defect in the product.",
    );
  }

  const declines: string[] = [];
  const launch = await deriveLaunchCommand(targetProjectPath, contractEntryPoint, declines);
  if (launch === null) {
    return notObservable(
      "no-launch-command",
      `no launch command could be derived from anything ${targetProjectPath} declares about itself: ${declines.join("; ")}`,
    );
  }

  const prepareFn = deps.prepareToolchain ?? prepare;
  try {
    await prepareFn(targetProjectPath, { runCommand: deps.toolchainRunner, log: deps.toolchainLog });
  } catch (e: unknown) {
    // A failed install is indistinguishable from a host or network fault, so it is
    // never charged to the product as a defect.
    const detail = e instanceof ToolchainError
      ? `toolchain failed at "${e.step}": ${e.context.detail}`
      : `toolchain error: ${e instanceof Error ? e.message : String(e)}`;
    return notObservable("toolchain-unprepared", `${targetProjectPath} could not be made runnable — ${detail}`);
  }

  const assignedPort = await pickFreePort();
  const proc = spawn(launch.argv[0], [...launch.argv.slice(1)], {
    cwd: targetProjectPath,
    // PORT is how this observer tells the product where to serve; it is the only
    // instruction it gives, and the product's declared start command decides what
    // to do with it.
    env: { ...process.env, ...launch.env, PORT: String(assignedPort) },
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
          console.warn(`[observe] Failed to signal process group ${proc.pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    try {
      proc.kill(signal);
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) {
        console.warn(`[observe] Failed to signal process ${proc.pid}: ${e instanceof Error ? e.message : String(e)}`);
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
    setTimeout(() => resolve({ kind: "running" }), BOOT_WINDOW_MS);
  });

  const bootOutput = (): string => `${stdout}\n${stderr}`.slice(0, 4000);

  if (startup.kind === "spawn-error") {
    // The command the project declared could not be executed at all — the runtime
    // it names is missing from this host. That is our environment, not its code.
    return notObservable(
      "launch-failed",
      `${launch.declaredBy} could not be executed: ${startup.error.message}`,
    );
  }
  if (startup.kind === "exited") {
    return bootFailed(
      `the product declares ${surface.endpoints.length} HTTP endpoint(s) but the process started by ` +
        `${launch.declaredBy} exited instead of serving them: ${bootOutput()}`,
    );
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
      return bootFailed(
        `the product declares ${surface.endpoints.length} HTTP endpoint(s) but nothing answered HTTP on port ` +
          `${assignedPort} after starting it with ${launch.declaredBy}: ${bootOutput()}`,
      );
    }

    // Probed head-first so the result is non-empty by construction: a `booted`
    // observation can never claim a clean check of zero endpoints.
    const head = await probeEndpoint(port, firstEndpoint.method, firstEndpoint.path);
    const rest: EndpointProbe[] = [];
    for (const ep of otherEndpoints) {
      rest.push(await probeEndpoint(port, ep.method, ep.path));
    }

    return { kind: "booted", port, endpoints: [head, ...rest] };
  } finally {
    await killProc();
  }
}
