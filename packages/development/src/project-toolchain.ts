import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// ProjectToolchain (Phase T, ADR-032 §1).
//
// Every verification position — integration gate (tsc), smoke (boot), and the
// agent-worktree verify — must evaluate a target project in an environment
// that reproduces the project's OWN build semantics: dependencies installed,
// code generation run, tool binaries resolved LOCALLY (never fetched from the
// registry). This module is that one owned helper; t2 wires the three callers.
//
// Two runs died to the absence of this single environment:
//   - Run 9: the integration gate ran tsc without ever running `prisma
//     generate`. The agent's worktree had a freshly generated Prisma client
//     (its own side effect); the gate's assembled tree did not (the generated
//     client under node_modules/.prisma is gitignored). Four correct todos
//     endpoints were abandoned on `prisma.todo` TS2339 while the identical
//     code compiled green in the agent worktree.
//   - Run 8 R8-F6a: a name-squatting registry package called `tsc` was fetched
//     and executed because a bare `npx <tool>` auto-installs from the registry.
//
// Safe bin resolution (R8-F6a class): no command this module runs can ever
// fetch a project-controlled package from the registry. The ONLY commands are
// (a) the package manager itself (bun/npm — trusted binaries on the host), and
// (b) code-generation tools invoked by their ABSOLUTE local-bin path
// (node_modules/.bin/<tool>), which the OS resolves as a filesystem path and
// can never satisfy from the registry. assertSafeCommand enforces this at the
// single execution choke point, so a bare `npx prisma`/`npx tsc` is not merely
// untested but impossible to emit.
// ---------------------------------------------------------------------------

const INSTALL_TIMEOUT_MS = 120_000;
const CODEGEN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_EXCERPT = 2000;

const STATE_FILE_RELATIVE = join("node_modules", ".ashara-toolchain.json");

// ---------------------------------------------------------------------------
// Package-manager detection
// ---------------------------------------------------------------------------

export type NodePackageManager = "bun" | "npm";

// Precedence: bun BEFORE npm. An explicit bun lockfile is a positive signal
// the project's build was authored with bun; `npm install` auto-writes a
// package-lock.json on every run, so its presence is a weaker signal. When
// both are present we therefore trust the bun lockfile. No lockfile at all
// but a package.json → npm (the lowest-common-denominator manager that ships
// with Node; we cannot assume bun is installed without a positive signal).
const LOCKFILE_PRECEDENCE: ReadonlyArray<{ file: string; manager: NodePackageManager }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
];

const INSTALL_COMMAND: Readonly<Record<NodePackageManager, readonly string[]>> = {
  bun: ["bun", "install"],
  npm: ["npm", "install"],
};

// ---------------------------------------------------------------------------
// Codegen detection table (marker file → codegen tool). Derived from project
// reality, NOT from any config format (contract-declared build steps arrive in
// migration Phase 9; do not invent a parallel config here). Only prisma is
// implemented now — a future generator (e.g. drizzle-kit) is one more row.
//
//   markerFile   — its presence in the tree implies the codegen step applies.
//   bin          — the tool name under node_modules/.bin (local-bin resolution).
//   args         — arguments to the tool.
//   outputMarker — the generated artifact; its ABSENCE forces regeneration even
//                  when the marker fingerprint is unchanged (Run 9: the client
//                  under node_modules/.prisma was simply never generated in the
//                  gate's assembled tree).
// ---------------------------------------------------------------------------

interface CodegenStep {
  readonly name: string;
  readonly markerFile: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly outputMarker: string;
}

const CODEGEN_STEPS: ReadonlyArray<CodegenStep> = [
  {
    name: "prisma",
    markerFile: join("prisma", "schema.prisma"),
    bin: "prisma",
    args: ["generate"],
    outputMarker: join("node_modules", ".prisma", "client"),
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolchainStep = "detect" | "coherence" | "install" | "codegen";

export interface ToolchainErrorContext {
  readonly cwd: string;
  readonly detail: string;
  readonly command?: readonly string[];
  readonly exitCode?: number;
  readonly outputExcerpt?: string;
  /**
   * Coherence step (Run 10, report §5 #1): the two files whose module settings
   * disagree — tsconfig.json and package.json. Present so the failure names the
   * exact artifacts a fix must touch (attribution-by-construction).
   */
  readonly files?: readonly string[];
  /** Coherence step: a concrete remediation the scaffold can apply directly. */
  readonly fixHint?: string;
}

/**
 * Typed, self-diagnosing toolchain failure (Discipline C). Reading the message
 * alone identifies the step, the exact argv, the cwd, the exit code, and an
 * output excerpt. Fail-closed (Discipline A): any step failure throws — there
 * is no partial-success return.
 */
export class ToolchainError extends Error {
  constructor(
    public readonly step: ToolchainStep,
    public readonly context: ToolchainErrorContext,
  ) {
    const cmd = context.command ? ` [${context.command.join(" ")}]` : "";
    const code = context.exitCode !== undefined ? ` (exit ${context.exitCode})` : "";
    super(`toolchain ${step} failed at ${context.cwd}${cmd}${code}: ${context.detail}`);
    this.name = "ToolchainError";
  }
}

// open-by-design: log payloads carry caller-defined diagnostic fields
export type ToolchainLogFn = (event: Record<string, unknown>) => void;

export interface ToolchainDeps {
  /**
   * Injected command runner — same seam as verify-core's CommandRunner
   * (packages/development/src/verify-core.ts). Required — no fallback. The
   * absence of a default is the mechanism: a caller that forgets to inject a
   * runner gets a compile error, not silent host execution (Discipline A,
   * mirroring CoreVerifyDeps.runCommand).
   */
  readonly runCommand: CommandRunner;
  readonly log?: ToolchainLogFn;
}

export interface CodegenOutcome {
  readonly name: string;
  readonly ran: boolean;
  readonly reason: string;
}

export interface ToolchainResult {
  readonly manager: NodePackageManager | null;
  readonly installRan: boolean;
  readonly installReason: string;
  readonly codegen: readonly CodegenOutcome[];
}

// ---------------------------------------------------------------------------
// Safe-command choke point (R8-F6a class). Every command routed through here
// is either the package manager itself or an absolute local-bin path. A bare
// `npx <tool>` (which auto-installs from the registry) throws BEFORE spawning.
// ---------------------------------------------------------------------------

// Whole-segment suffix, matched after resolving the path. dirname(resolve(bin))
// must END WITH `<sep>node_modules<sep>.bin` — i.e. the executable is a DIRECT
// child of a node_modules/.bin directory. resolve() collapses any `..`, so a
// traversal-escape form like `/x/node_modules/.bin/../../../sh` (which resolves
// to `/sh`) can never satisfy this even though the literal string contains the
// segment. A substring includes() check would be fooled by exactly that shape.
const LOCAL_BIN_PARENT_SUFFIX = `${sep}node_modules${sep}.bin`;

function isPackageManagerCommand(command: readonly string[]): boolean {
  const bin = command[0];
  return bin === "bun" || bin === "npm";
}

function isLocalBinCommand(command: readonly string[]): boolean {
  const bin = command[0];
  if (!isAbsolute(bin)) return false;
  return dirname(resolve(bin)).endsWith(LOCAL_BIN_PARENT_SUFFIX);
}

// SAFE_SYSTEM_BINARIES deleted: containment is structural (podman
// --network=none / --userns=keep-id), not string-based. Same reasoning
// as the ALLOWED_CHECK_COMMANDS deletion (ADR-068, cycle 126).

/**
 * The single security invariant for Node toolchain commands: a command is safe
 * to spawn iff it is the package manager itself (bun/npm) or an executable
 * resolving to a direct child of a node_modules/.bin directory. Non-Node
 * toolchain preparation runs inside a container where containment is structural
 * (--network controlled, --userns=keep-id, single mount), not string-based.
 */
export function isSafeToolchainCommand(command: readonly string[]): boolean {
  if (command.length === 0) return false;
  return isPackageManagerCommand(command) || isLocalBinCommand(command);
}

function assertSafeCommand(command: readonly string[], step: ToolchainStep, cwd: string): void {
  if (isSafeToolchainCommand(command)) return;
  // Fail-closed: an unrecognized executable could be a name-squatted registry
  // package or a traversal-escape path. Never spawn it.
  throw new ToolchainError(step, {
    cwd,
    detail:
      command.length === 0
        ? "empty command"
        : "unsafe command: only the package manager (bun/npm) or an absolute " +
          "node_modules/.bin path may be executed; a registry-fetching or " +
          "traversal-escape form is refused",
    command,
  });
}

async function runStep(
  run: CommandRunner,
  command: readonly string[],
  cwd: string,
  timeout: number,
  step: ToolchainStep,
): Promise<void> {
  assertSafeCommand(command, step, cwd);
  let result: { exitCode: number; output: string };
  try {
    result = await run([...command], cwd, timeout);
  } catch (err) {
    // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolchainError(step, { cwd, detail, command });
  }
  if (result.exitCode !== 0) {
    throw new ToolchainError(step, {
      cwd,
      detail: `command exited non-zero`,
      command,
      exitCode: result.exitCode,
      outputExcerpt: result.output.slice(-MAX_OUTPUT_EXCERPT),
    });
  }
}

// ---------------------------------------------------------------------------
// Fingerprints & persisted skip state
// ---------------------------------------------------------------------------

interface Fingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

// mtime+size, not a content hash. Gates run per task; hashing large lockfiles
// on every verify buys nothing — install itself is the authority on lockfile
// content, and any real edit touches mtime. When in doubt we reinstall (a
// missing/invalid fingerprint is treated as changed), i.e. we fail toward
// correctness, never toward an under-provisioned tree.
async function fingerprint(path: string): Promise<Fingerprint | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Fingerprint a codegen MARKER, distinguishing genuine absence from an
 * inability to confirm absence. ENOENT (the parent chain resolves but the file
 * is not there) → null → the codegen step does not apply, skip. Any OTHER stat
 * error (EACCES, EIO, ENOTDIR, …) means the marker MIGHT exist but we cannot
 * read it — we must NOT silently skip codegen (that is the fail-open asymmetry a
 * bare fingerprint() would introduce), so we re-throw and the caller fails the
 * step with a typed, self-diagnosing error.
 */
async function statMarkerFingerprint(path: string): Promise<Fingerprint | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

function fingerprintsEqual(a: Fingerprint | null, b: Fingerprint | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

interface ToolchainState {
  readonly lockfile: Fingerprint | null;
  readonly codegen: Record<string, Fingerprint>;
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== "object" || value === null) return false;
  // contract-erasing: narrowing for Fingerprint, which has a known shape {mtimeMs, size}
  const v = value as Record<string, unknown>;
  return typeof v.mtimeMs === "number" && typeof v.size === "number";
}

// Hand-written type guard rather than Zod: zod is not a direct dependency of
// @ashara/development (adding it would trip knip's unlisted-dependency check)
// and this shape is small. An unparseable/invalid state file yields null →
// treated as "no prior state" → reinstall + regenerate (fail toward correctness).
function parseState(raw: string): ToolchainState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // contract-erasing: narrowing for ToolchainState, which has a known shape
  const obj = parsed as Record<string, unknown>;

  const lockfile = obj.lockfile === null ? null : isFingerprint(obj.lockfile) ? obj.lockfile : undefined;
  if (lockfile === undefined) return null;

  const codegenRaw = obj.codegen;
  if (typeof codegenRaw !== "object" || codegenRaw === null) return null;
  const codegen: Record<string, Fingerprint> = {};
  for (const [key, value] of Object.entries(codegenRaw)) {
    if (!isFingerprint(value)) return null;
    codegen[key] = value;
  }

  return { lockfile, codegen };
}

async function loadState(targetPath: string): Promise<ToolchainState | null> {
  try {
    const raw = await readFile(join(targetPath, STATE_FILE_RELATIVE), "utf-8");
    return parseState(raw);
  } catch {
    return null;
  }
}

async function saveState(targetPath: string, state: ToolchainState, log?: ToolchainLogFn): Promise<void> {
  const statePath = join(targetPath, STATE_FILE_RELATIVE);
  try {
    // node_modules exists whenever we reach here (install ran, or was skipped
    // because it already existed); the mkdir guarantees the write succeeds and
    // keeps the state file inside node_modules so a wiped tree drops it too.
    await mkdir(join(targetPath, "node_modules"), { recursive: true });
    await writeFile(statePath, JSON.stringify(state), "utf-8");
  } catch (err) {
    // Non-fatal: a missing skip-state only costs a redundant install/codegen
    // next time (correctness preserved). Log at warn level (Discipline C).
    // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
    const detail = err instanceof Error ? err.message : String(err);
    log?.({ event: "toolchain_state_write_failed", level: "warn", path: statePath, detail });
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function detectManager(targetPath: string): Promise<NodePackageManager> {
  for (const { file, manager } of LOCKFILE_PRECEDENCE) {
    if (await pathExists(join(targetPath, file))) {
      return manager;
    }
  }
  return "npm";
}

// ---------------------------------------------------------------------------
// Non-Node project preparation
// ---------------------------------------------------------------------------

// NON_NODE_MANIFESTS / prepareNonNode deleted: the hardcoded {Cargo.toml →
// cargo build, go.mod → go mod download} table gave known stacks a prepare
// step while unseen stacks (Zig, Elixir) got a silent no-op. The long-term
// replacement is LLM-generated Containerfiles (ADR-015); until then, non-Node
// projects skip prepare honestly, same as they did for 42 runs before e668ddfc.

// ---------------------------------------------------------------------------
// prepare — the module entry point
// ---------------------------------------------------------------------------

/**
 * Make a target project's tree build-ready: detect its package manager, install
 * dependencies, and run any code generation the project's own layout implies
 * (prisma today), so a downstream tsc/boot/probe reproduces the project's build
 * semantics. Idempotent and bounded: install is skipped when node_modules is
 * present and the lockfile fingerprint is unchanged; each codegen step is
 * skipped when its marker fingerprint is unchanged AND its output is present.
 *
 * Fail-closed (Discipline A): a missing package.json, an install failure, or a
 * codegen failure throws a typed ToolchainError; there is no partial-success
 * return. The caller (gate/smoke/verify) decides whether that is fatal to it.
 */
export async function prepare(targetPath: string, deps: ToolchainDeps): Promise<ToolchainResult> {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new ToolchainError("detect", {
      cwd: String(targetPath),
      detail: "targetPath must be a non-empty path",
    });
  }
  if (!isAbsolute(targetPath)) {
    throw new ToolchainError("detect", { cwd: targetPath, detail: "targetPath must be absolute" });
  }

  const run = deps.runCommand;
  const log = deps.log;

  if (!(await pathExists(join(targetPath, "package.json")))) {
    log?.({ event: "toolchain_no_manifest", cwd: targetPath });
    return {
      manager: null,
      installRan: false,
      installReason: "no package.json — non-Node prepare deferred to ADR-015 (LLM-generated Containerfile)",
      codegen: [],
    };
  }

  const manager = await detectManager(targetPath);
  const priorState = await loadState(targetPath);
  log?.({ event: "toolchain_detect", cwd: targetPath, manager, hadPriorState: priorState !== null });

  // ---- Install -----------------------------------------------------------
  // Fingerprint the lockfile actually present for the detected manager (bun has
  // two candidates); a project with no lockfile fingerprints as null.
  let lockfilePath: string | null = null;
  for (const { file, manager: m } of LOCKFILE_PRECEDENCE) {
    if (m === manager && (await pathExists(join(targetPath, file)))) {
      lockfilePath = join(targetPath, file);
      break;
    }
  }
  const lockfileFp = lockfilePath ? await fingerprint(lockfilePath) : null;

  const nodeModulesExists = await pathExists(join(targetPath, "node_modules"));
  const lockfileUnchanged = priorState !== null && fingerprintsEqual(priorState.lockfile, lockfileFp);
  const skipInstall = nodeModulesExists && lockfileUnchanged;

  let installRan: boolean;
  let installReason: string;
  if (skipInstall) {
    installRan = false;
    installReason = "node_modules present and lockfile fingerprint unchanged";
  } else {
    installRan = true;
    installReason = !nodeModulesExists
      ? "node_modules absent"
      : priorState === null
        ? "no prior toolchain state"
        : "lockfile fingerprint changed";
    log?.({ event: "toolchain_install", cwd: targetPath, manager, reason: installReason, command: INSTALL_COMMAND[manager] });
    await runStep(run, INSTALL_COMMAND[manager], targetPath, INSTALL_TIMEOUT_MS, "install");
  }
  log?.({ event: "toolchain_install_decision", cwd: targetPath, ran: installRan, reason: installReason });

  // ---- Codegen -----------------------------------------------------------
  const codegen: CodegenOutcome[] = [];
  const nextCodegenState: Record<string, Fingerprint> = {};

  for (const step of CODEGEN_STEPS) {
    const markerPath = join(targetPath, step.markerFile);
    let markerFp: Fingerprint | null;
    try {
      markerFp = await statMarkerFingerprint(markerPath);
    } catch (err) {
      // Non-ENOENT stat error: we cannot confirm the marker is absent, so we
      // must not skip codegen (fail-closed). Surface a typed, self-diagnosing
      // error rather than silently proceeding to an under-generated tree.
      // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolchainError("codegen", {
        cwd: targetPath,
        detail: `cannot stat codegen marker ${step.markerFile}: ${detail}`,
      });
    }
    if (markerFp === null) {
      // Marker genuinely absent → the codegen step does not apply to this project.
      continue;
    }

    const outputPresent = await pathExists(join(targetPath, step.outputMarker));
    const priorFp = priorState?.codegen[step.name] ?? null;
    const markerUnchanged = fingerprintsEqual(priorFp, markerFp);
    const shouldRun = !outputPresent || !markerUnchanged;

    if (shouldRun) {
      const reason = !outputPresent
        ? `generated output ${step.outputMarker} absent`
        : "marker fingerprint changed";
      const command = [join(targetPath, "node_modules", ".bin", step.bin), ...step.args];
      log?.({ event: "toolchain_codegen", cwd: targetPath, step: step.name, reason, command });
      await runStep(run, command, targetPath, CODEGEN_TIMEOUT_MS, "codegen");
      codegen.push({ name: step.name, ran: true, reason });
      // Re-fingerprint the marker after a successful run so the skip check is
      // stable on the next prepare.
      nextCodegenState[step.name] = (await fingerprint(markerPath)) ?? markerFp;
    } else {
      codegen.push({ name: step.name, ran: false, reason: "output present and marker fingerprint unchanged" });
      nextCodegenState[step.name] = markerFp;
    }
  }

  log?.({ event: "toolchain_codegen_decision", cwd: targetPath, steps: codegen });

  await saveState(targetPath, { lockfile: lockfileFp, codegen: nextCodegenState }, log);

  return { manager, installRan, installReason, codegen };
}
