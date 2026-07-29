import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";

// ---------------------------------------------------------------------------
// Sandbox container configuration (p0-isolation)
//
// The image name+tag are the sole source of truth for which container image
// agent-runner processes execute in. Referenced nowhere else — one place, not
// scattered (CLAUDE.md Target Generality: config, not literal).
// ---------------------------------------------------------------------------

export const SANDBOX_IMAGE = "ashara-sandbox";
export const SANDBOX_TAG = "0.1.0";

// Fixed mount points inside the container. All env-var paths the agent reads
// are translated from host paths to these before spawn.
const CONTAINER_WORK_DIR = "/workspace";
const CONTAINER_ASHARA_DIR = "/ashara";

// Relative path from the Ashara source root to the runner entry point.
const RUNNER_RELATIVE = "packages/agent-runner/src/runner.ts";

// Container name prefix — combined with taskId and a monotonic suffix to
// give each container a deterministic identity for stop/rm.
const CONTAINER_NAME_PREFIX = "ashara-agent";

// Vars that derive from the host filesystem layout and must not leak into
// the container — the container image supplies its own.
const HOST_ONLY_VARS = new Set([
  "HOME", "PATH", "SHELL", "USER", "TMPDIR", "TERM",
]);

// npm metadata vars point to host paths (cache dir, prefix, config path).
// The Containerfile sets its own npm_config_cache to /tmp/npm-cache.
function isHostOnlyVar(key: string): boolean {
  if (HOST_ONLY_VARS.has(key)) return true;
  if (key.startsWith("npm_config_") || key.startsWith("npm_package_")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Typed error (Discipline C: self-diagnosing, structured context)
// ---------------------------------------------------------------------------

export class ContainerSpawnError extends Error {
  readonly context: {
    readonly operation: string;
    readonly containerName: string;
    readonly taskId: string;
    readonly exitCode: number | null;
    readonly cause: string;
    readonly stderr: string;
  };

  constructor(ctx: ContainerSpawnError["context"]) {
    super(
      `container ${ctx.operation} failed for task ${ctx.taskId} ` +
      `(container=${ctx.containerName}, exit=${ctx.exitCode}): ${ctx.cause}`,
    );
    this.name = "ContainerSpawnError";
    this.context = ctx;
  }
}

// ---------------------------------------------------------------------------
// Enumerated mount set (Discipline A: allowlist, not denylist)
//
// Each entry is a path the agent-runner actually needs from the Ashara
// checkout. Together they replace the old whole-checkout mount that
// exposed .env, .git, and every other root file to any command the
// agent can run (cat, grep, head, tail are all in the command allowlist).
//
// How this list was derived (2026-07-29):
//   - node_modules: tsx runtime + third-party deps + @ashara/* symlinks
//   - packages/agent-runner: entry point (RUNNER_RELATIVE)
//   - packages/shared, llm-gateway, development: direct @ashara/* imports
//     in agent-runner/src/ (traced through acl/development-acl.ts)
//   - packages/memory: transitive via development → dispatch-utils.ts:4
//   - tsconfig.json: every package extends "../../tsconfig.json"
//   - package.json: Node module resolution for workspace packages
// ---------------------------------------------------------------------------

interface AsharaMountEntry {
  /** Path relative to the Ashara source directory on the host */
  readonly hostRelative: string;
  /** Absolute path inside the container */
  readonly containerPath: string;
  /** Expected filesystem type for fail-closed validation */
  readonly kind: "file" | "directory";
}

export const ASHARA_MOUNT_ENTRIES: readonly AsharaMountEntry[] = [
  { hostRelative: "node_modules",          containerPath: `${CONTAINER_ASHARA_DIR}/node_modules`,          kind: "directory" },
  { hostRelative: "packages/agent-runner", containerPath: `${CONTAINER_ASHARA_DIR}/packages/agent-runner`, kind: "directory" },
  { hostRelative: "packages/shared",       containerPath: `${CONTAINER_ASHARA_DIR}/packages/shared`,       kind: "directory" },
  { hostRelative: "packages/llm-gateway",  containerPath: `${CONTAINER_ASHARA_DIR}/packages/llm-gateway`,  kind: "directory" },
  { hostRelative: "packages/development",  containerPath: `${CONTAINER_ASHARA_DIR}/packages/development`,  kind: "directory" },
  { hostRelative: "packages/memory",       containerPath: `${CONTAINER_ASHARA_DIR}/packages/memory`,       kind: "directory" },
  { hostRelative: "tsconfig.json",         containerPath: `${CONTAINER_ASHARA_DIR}/tsconfig.json`,         kind: "file" },
  { hostRelative: "package.json",          containerPath: `${CONTAINER_ASHARA_DIR}/package.json`,          kind: "file" },
];

// ---------------------------------------------------------------------------
// Typed error for missing mount paths (Discipline C)
// ---------------------------------------------------------------------------

export class MissingMountPathError extends Error {
  readonly context: {
    readonly path: string;
    readonly expected: "file" | "directory";
    readonly asharaSourceDir: string;
    readonly operation: string;
  };

  constructor(path: string, expected: "file" | "directory", asharaSourceDir: string) {
    super(
      `Required mount path missing: ${path} (expected ${expected}) — ` +
      `cannot start agent container. Ashara source dir: ${asharaSourceDir}`,
    );
    this.name = "MissingMountPathError";
    this.context = { path, expected, asharaSourceDir, operation: "validateMountPaths" };
  }
}

/**
 * Validates that every path in ASHARA_MOUNT_ENTRIES exists and has the
 * expected type. Fail-closed (Discipline A): a missing path throws
 * MissingMountPathError rather than falling back to mounting the root
 * or spawning with an incomplete mount set.
 */
export function validateMountPaths(asharaSourceDir: string): void {
  const resolvedAshara = resolve(asharaSourceDir);
  for (const entry of ASHARA_MOUNT_ENTRIES) {
    const hostPath = join(resolvedAshara, entry.hostRelative);
    if (!existsSync(hostPath)) {
      throw new MissingMountPathError(hostPath, entry.kind, resolvedAshara);
    }
    const stat = statSync(hostPath);
    if (entry.kind === "directory" && !stat.isDirectory()) {
      throw new MissingMountPathError(hostPath, entry.kind, resolvedAshara);
    }
    if (entry.kind === "file" && !stat.isFile()) {
      throw new MissingMountPathError(hostPath, entry.kind, resolvedAshara);
    }
  }
}

// ---------------------------------------------------------------------------
// Path translation
// ---------------------------------------------------------------------------

/**
 * Thrown when a host path falls outside the work directory and therefore
 * cannot be translated to a container-side path. Carries both paths so a
 * caller can act on the structured fields rather than parsing a message.
 */
export class PathOutsideWorkDir extends Error {
  readonly hostPath: string;
  readonly hostWorkDir: string;
  readonly operation: string;

  constructor(hostPath: string, hostWorkDir: string) {
    super(
      `Path ${hostPath} is not under work directory ${hostWorkDir} — ` +
      `cannot translate to container path`,
    );
    this.name = "PathOutsideWorkDir";
    this.hostPath = hostPath;
    this.hostWorkDir = hostWorkDir;
    this.operation = "translateHostPath";
  }
}

/**
 * Translates a host path under the work directory to its container-side
 * equivalent under /workspace. Fails closed if the path is not under
 * workDir — this is the code-level enforcement of criterion 2 (only the
 * work directory is shared with the container). A path outside it would
 * be inaccessible inside the container; accepting it silently would hide
 * a broken assumption about where the file actually lives.
 */
export function translateHostPath(
  hostPath: string,
  hostWorkDir: string,
): string {
  const resolved = resolve(hostPath);
  const resolvedWork = resolve(hostWorkDir);
  if (resolved !== resolvedWork && !resolved.startsWith(resolvedWork + "/")) {
    throw new PathOutsideWorkDir(hostPath, hostWorkDir);
  }
  const rel = relative(resolvedWork, resolved);
  return rel === "" ? CONTAINER_WORK_DIR : join(CONTAINER_WORK_DIR, rel);
}

// ---------------------------------------------------------------------------
// Container environment
// ---------------------------------------------------------------------------

export interface ContainerEnvPaths {
  readonly briefPath: string;
  readonly outputPath: string;
  readonly workDir: string;
  readonly catalogPath: string;
  readonly capability: string;
}

/**
 * Builds the environment for the container from the host's sanitized env.
 * Filters out host-filesystem-specific vars (PATH, HOME, npm metadata) and
 * translates ASHARA_* path vars to their container-side equivalents.
 */
export function buildContainerEnv(
  sanitizedHostEnv: Record<string, string>,
  hostWorkDir: string,
  paths: ContainerEnvPaths,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizedHostEnv)) {
    if (!isHostOnlyVar(key)) {
      env[key] = value;
    }
  }
  env["ASHARA_BRIEF_PATH"] = translateHostPath(paths.briefPath, hostWorkDir);
  env["ASHARA_OUTPUT_PATH"] = translateHostPath(paths.outputPath, hostWorkDir);
  env["ASHARA_WORKING_DIR"] = CONTAINER_WORK_DIR;
  env["ASHARA_CATALOG_PATH"] = translateHostPath(paths.catalogPath, hostWorkDir);
  env["AGENT_CAPABILITY"] = paths.capability;
  return env;
}

// ---------------------------------------------------------------------------
// Container name
// ---------------------------------------------------------------------------

let containerSeq = 0;

export function buildContainerName(taskId: string): string {
  // Podman container names allow [a-zA-Z0-9_.-]. Sanitize taskId chars that
  // violate this to avoid silent podman failures.
  const safe = taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${CONTAINER_NAME_PREFIX}-${safe}-${++containerSeq}`;
}

// ---------------------------------------------------------------------------
// Podman invocation
// ---------------------------------------------------------------------------

export function buildPodmanRunArgs(
  containerName: string,
  hostWorkDir: string,
  asharaSourceDir: string,
  env: Record<string, string>,
): string[] {
  const resolvedWork = resolve(hostWorkDir);
  const resolvedAshara = resolve(asharaSourceDir);

  const args: string[] = [
    "run",
    "--name", containerName,
    // Auto-remove the container on exit so stopped/completed containers do
    // not accumulate. Idempotent with the explicit `podman rm -f` in
    // terminateContainer (which swallows "no such container").
    "--rm",
    // Map the caller's uid so files the agent writes into the work directory
    // stay readable by the host without permission fixup.
    "--userns=keep-id",
    // Work directory: the only writable path shared with the host (criterion 2).
    // :z for SELinux relabeling (Rocky 10.2, enforcing).
    "-v", `${resolvedWork}:${CONTAINER_WORK_DIR}:z`,
    // Container working directory is the task worktree.
    "-w", CONTAINER_WORK_DIR,
  ];

  // Ashara source: enumerated read-only mounts of exactly the paths the
  // agent-runner needs. The old single-root mount exposed .env and every
  // other file at the checkout root to cat/grep/head — commands the
  // CommandPolicy allowlist permits. This allowlist replaces that denylist.
  for (const entry of ASHARA_MOUNT_ENTRIES) {
    const hostPath = join(resolvedAshara, entry.hostRelative);
    args.push("-v", `${hostPath}:${entry.containerPath}:ro,z`);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(
    `${SANDBOX_IMAGE}:${SANDBOX_TAG}`,
    // npx cannot traverse the .bin/ symlink from a read-only mount — invoke
    // tsx's CLI directly via node (established fact from image investigation).
    "node",
    `${CONTAINER_ASHARA_DIR}/node_modules/tsx/dist/cli.mjs`,
    `${CONTAINER_ASHARA_DIR}/${RUNNER_RELATIVE}`,
  );

  return args;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawns the agent-runner inside a podman container and returns the podman
 * client ChildProcess for stdio collection. The client forwards the
 * container's stdout/stderr and exits when the container does.
 *
 * Fails closed: if podman is missing the spawn emits an `error` event; if
 * the image is missing podman exits with code 125 and output.json is absent,
 * so resolveAgentOutput throws AgentSpawnError.
 */
export function spawnContainer(
  containerName: string,
  hostWorkDir: string,
  asharaSourceDir: string,
  env: Record<string, string>,
): ChildProcess {
  // Fail closed: every required path must exist before spawn. A missing
  // path throws MissingMountPathError — never fall back to the old root
  // mount and never spawn with an incomplete mount set.
  validateMountPaths(asharaSourceDir);
  const args = buildPodmanRunArgs(containerName, hostWorkDir, asharaSourceDir, env);
  return spawn("podman", args, {
    stdio: ["ignore", "pipe", "pipe"],
    // No detached:true — the podman client is a single process, not a
    // wrapper chain. Termination goes through `podman stop <name>`, not
    // process-group signaling. Not being detached also means the client
    // dies with the server on SIGTERM/SIGINT, which is fine because the
    // container has --rm and cleans itself up.
  });
}

/**
 * Stops and removes a container by name. Idempotent — succeeds even if the
 * container is already stopped or removed (errors swallowed by podmanExec).
 *
 * This is the ONLY correct termination path: killing the podman CLIENT
 * process does not stop the container — the container continues running
 * as an orphan. `podman stop` sends SIGTERM to PID 1 inside the container,
 * waits `graceSeconds`, then escalates to SIGKILL.
 */
export async function terminateContainer(
  containerName: string,
  graceSeconds: number = 5,
): Promise<void> {
  await podmanExec(["stop", "--time", String(graceSeconds), containerName]);
  // Belt + suspenders with --rm: the container should auto-remove on exit,
  // but an explicit rm -f handles the edge case where --rm did not fire.
  await podmanExec(["rm", "-f", containerName]);
}

/**
 * Runs a podman subcommand, swallowing "no such container" errors (the
 * container was already cleaned up). Other errors are logged at warn but
 * never thrown — termination is best-effort, and a throw here would mask
 * the real outcome of the agent run.
 */
function podmanExec(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile("podman", args, (error, _stdout, stderr) => {
      if (error) {
        const msg = stderr || (error instanceof Error ? error.message : String(error));
        if (!msg.includes("no such container")) {
          console.warn(`[podman ${args[0]}] ${msg.slice(0, 200)}`);
        }
      }
      resolve();
    });
  });
}
