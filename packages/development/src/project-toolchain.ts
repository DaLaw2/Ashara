import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { CommandRunner } from "./verify-core.js";
import { defaultRunCommand } from "./check-runner.js";

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

export type PackageManager = "bun" | "npm";

// Precedence: bun BEFORE npm. An explicit bun lockfile is a positive signal
// the project's build was authored with bun; `npm install` auto-writes a
// package-lock.json on every run, so its presence is a weaker signal. When
// both are present we therefore trust the bun lockfile. No lockfile at all
// but a package.json → npm (the lowest-common-denominator manager that ships
// with Node; we cannot assume bun is installed without a positive signal).
const LOCKFILE_PRECEDENCE: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
];

const INSTALL_COMMAND: Readonly<Record<PackageManager, readonly string[]>> = {
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

export type ToolchainLogFn = (event: Record<string, unknown>) => void;

export interface ToolchainDeps {
  /**
   * Injected command runner — same seam as verify-core's CommandRunner
   * (packages/development/src/verify-core.ts). Reused so all three consumers
   * (gate, smoke, agent-worktree verify) pass their existing runner. Tests
   * substitute a deterministic runner; no real install ever runs in a unit test.
   */
  readonly runCommand?: CommandRunner;
  readonly log?: ToolchainLogFn;
}

export interface CodegenOutcome {
  readonly name: string;
  readonly ran: boolean;
  readonly reason: string;
}

export interface ToolchainResult {
  readonly manager: PackageManager | null;
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

const SAFE_SYSTEM_BINARIES: ReadonlySet<string> = new Set([
  "cargo", "go", "python", "python3",
]);

function isSystemBinaryCommand(command: readonly string[]): boolean {
  return SAFE_SYSTEM_BINARIES.has(command[0]);
}

/**
 * The single security invariant, exported so it can be asserted directly: a
 * command is safe to spawn iff it is the package manager itself (bun/npm), an
 * executable resolving to a direct child of a node_modules/.bin directory, or a
 * known system binary (cargo/go/python). Any other form (notably a bare
 * `npx <tool>`/`bunx <tool>` that auto-installs from the registry, or a
 * traversal-escape path) is unsafe.
 */
export function isSafeToolchainCommand(command: readonly string[]): boolean {
  if (command.length === 0) return false;
  return isPackageManagerCommand(command) || isLocalBinCommand(command) || isSystemBinaryCommand(command);
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

async function detectManager(targetPath: string): Promise<PackageManager> {
  for (const { file, manager } of LOCKFILE_PRECEDENCE) {
    if (await pathExists(join(targetPath, file))) {
      return manager;
    }
  }
  return "npm";
}

// ---------------------------------------------------------------------------
// Module-system coherence (Run 10, report §5 #1 / defect 4a-i).
//
// Every verify position boots/type-checks the target as raw .ts (smoke runs
// `node src/index.ts`; the gate runs `tsc --noEmit`). Node decides a .ts file's
// module system from package.json "type"; tsc decides it from tsconfig
// "module". When those DISAGREE, tsc type-checks under one system while Node
// executes under the other, so gate-passing code boot-crashes: with tsconfig
// "module":"commonjs" and no package.json "type", Node reparses module-syntax
// .ts as ESM (`__dirname is not defined`, extensionless-import
// ERR_MODULE_NOT_FOUND) even though every import resolves under CommonJS.
//
// In Run 10 the scaffold shipped exactly this mismatch, stayed Completed, and
// ~6 innocent downstream wiring tasks boot-crashed and abandoned while smoke
// blamed whoever last touched the entry. This check makes the incoherent
// scaffold fail its OWN prepare() (attribution-by-construction) rather than
// cascade-freezing successors: the two disagreeing files and a concrete fix
// travel in the typed error.
//
// Fail toward NO false positives: a project with no tsconfig, no `module`
// setting, an unclassifiable `module` (node16/nodenext/preserve DEFER to
// package.json, so they are coherent by construction), or no TypeScript
// sources at all (JS-only) is left untouched.
// ---------------------------------------------------------------------------

type ModuleSystem = "cjs" | "esm";

// The package.json "type" that makes Node's runtime module system agree with a
// given tsconfig "module": CommonJS ↔ "commonjs", ES modules ↔ "module".
const PACKAGE_TYPE_FOR: Readonly<Record<ModuleSystem, "commonjs" | "module">> = {
  cjs: "commonjs",
  esm: "module",
};

const COHERENCE_TS_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
]);
const COHERENCE_TS_SCAN_MAX_DEPTH = 6;

/**
 * Classify a tsconfig `module` value into the module system it pins Node to, or
 * null when the setting does not pin one independently of package.json. Only
 * "commonjs" and the fixed ES-module targets (es6/es2015/es2020/es2022/esnext)
 * pin a system; node16/nodenext/preserve/amd/umd/system/none defer or are not
 * Node-runnable, so they can never be incoherent with package.json.
 */
function classifyTsconfigModule(moduleValue: string): ModuleSystem | null {
  const m = moduleValue.trim().toLowerCase();
  if (m === "commonjs") return "cjs";
  if (m.startsWith("es")) return "esm";
  return null;
}

// String-aware JSONC stripper: tsconfig.json permits // and /* */ comments and
// trailing commas, which JSON.parse rejects. Only used as a fallback after a
// strict JSON.parse fails, so clean tsconfigs are never reshaped.
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to the comment/trailing-comma-tolerant path.
  }
  try {
    return JSON.parse(stripJsonComments(raw).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

interface TsconfigModuleReading {
  readonly system: ModuleSystem;
  readonly rawModule: string;
  readonly path: string;
}

async function readTsconfigModule(targetPath: string): Promise<TsconfigModuleReading | null> {
  const tsconfigPath = join(targetPath, "tsconfig.json");
  let raw: string;
  try {
    raw = await readFile(tsconfigPath, "utf-8");
  } catch {
    return null; // no tsconfig → nothing to assess (skip, no false positive).
  }
  const parsed = parseJsonc(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const compilerOptions = (parsed as Record<string, unknown>).compilerOptions;
  if (typeof compilerOptions !== "object" || compilerOptions === null) return null;
  const moduleValue = (compilerOptions as Record<string, unknown>).module;
  if (typeof moduleValue !== "string") return null;
  const system = classifyTsconfigModule(moduleValue);
  if (system === null) return null;
  return { system, rawModule: moduleValue, path: tsconfigPath };
}

interface PackageTypeReading {
  readonly type: string | undefined;
  readonly path: string;
}

async function readPackageType(targetPath: string): Promise<PackageTypeReading | null> {
  const packageJsonPath = join(targetPath, "package.json");
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // an unparseable package.json is a separate defect, not ours.
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const typeValue = (parsed as Record<string, unknown>).type;
  return { type: typeof typeValue === "string" ? typeValue : undefined, path: packageJsonPath };
}

// Does the tree hold at least one runnable TypeScript source (not a .d.ts)? The
// coherence mismatch only bites when Node executes a .ts file, so a JS-only
// project is skipped. fs-based (not the injected runner) so a deterministic
// test runner cannot mask real sources, and bounded so a large tree is cheap.
async function hasTypeScriptSource(dir: string, depth: number): Promise<boolean> {
  if (depth > COHERENCE_TS_SCAN_MAX_DEPTH) return false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (COHERENCE_TS_SCAN_SKIP_DIRS.has(entry.name)) continue;
      if (await hasTypeScriptSource(join(dir, entry.name), depth + 1)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      return true;
    }
  }
  return false;
}

/**
 * Assert that package.json "type" agrees with tsconfig "module" for a TypeScript
 * project. Fail-closed (Discipline A): a disagreement throws a typed
 * ToolchainError(step="coherence") carrying both file paths and a concrete fix,
 * so the incoherent scaffold fails at creation. Skips (no throw) whenever the
 * relationship cannot be assessed without risking a false positive.
 */
async function assertModuleCoherence(targetPath: string, log?: ToolchainLogFn): Promise<void> {
  const ts = await readTsconfigModule(targetPath);
  if (ts === null) return; // no tsconfig / no classifiable `module` → skip.
  if (!(await hasTypeScriptSource(targetPath, 0))) return; // JS-only → skip.
  const pkg = await readPackageType(targetPath);
  if (pkg === null) return;

  const requiredType = PACKAGE_TYPE_FOR[ts.system];
  if (pkg.type === requiredType) {
    log?.({
      event: "toolchain_coherence",
      cwd: targetPath,
      module: ts.rawModule,
      packageType: pkg.type ?? null,
      coherent: true,
    });
    return;
  }

  const declaredSystem = ts.system === "cjs" ? "CommonJS" : "an ES module";
  const actual = pkg.type === undefined ? 'no "type" field' : `"type": "${pkg.type}"`;
  const nodeBehavior =
    ts.system === "cjs"
      ? "Node reparses module-syntax .ts as an ES module at boot"
      : "Node executes .ts as CommonJS at boot";
  const fixHint =
    `add "type": "${requiredType}" to package.json to match tsconfig ` +
    `"module": "${ts.rawModule}" (or change tsconfig "module")`;
  const detail =
    `module-system incoherence: tsconfig "module": "${ts.rawModule}" type-checks as ${declaredSystem}, ` +
    `but package.json has ${actual}, so ${nodeBehavior} — gate-passing code can boot-crash ` +
    `(__dirname undefined / ERR_MODULE_NOT_FOUND for existing files). Fix: ${fixHint}.`;

  log?.({
    event: "toolchain_coherence",
    cwd: targetPath,
    module: ts.rawModule,
    packageType: pkg.type ?? null,
    coherent: false,
  });

  throw new ToolchainError("coherence", {
    cwd: targetPath,
    detail,
    files: [ts.path, pkg.path],
    fixHint,
  });
}

// ---------------------------------------------------------------------------
// Non-Node project preparation
// ---------------------------------------------------------------------------

const NON_NODE_PREPARE_TIMEOUT_MS = 120_000;

interface NonNodeManifest {
  readonly marker: string;
  readonly command: readonly string[];
}

const NON_NODE_MANIFESTS: ReadonlyArray<NonNodeManifest> = [
  { marker: "Cargo.toml", command: ["cargo", "build"] },
  { marker: "go.mod", command: ["go", "mod", "download"] },
];

async function prepareNonNode(
  targetPath: string,
  run: CommandRunner,
  log?: ToolchainLogFn,
): Promise<ToolchainResult> {
  for (const { marker, command } of NON_NODE_MANIFESTS) {
    if (await pathExists(join(targetPath, marker))) {
      log?.({ event: "toolchain_non_node_prepare", cwd: targetPath, marker, command });
      await runStep(run, command, targetPath, NON_NODE_PREPARE_TIMEOUT_MS, "install");
      return {
        manager: null,
        installRan: true,
        installReason: `${marker} present — ran ${command.join(" ")}`,
        codegen: [],
      };
    }
  }

  log?.({ event: "toolchain_no_manifest", cwd: targetPath });
  return {
    manager: null,
    installRan: false,
    installReason: "no recognized project manifest, skipping prepare",
    codegen: [],
  };
}

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
export async function prepare(targetPath: string, deps: ToolchainDeps = {}): Promise<ToolchainResult> {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new ToolchainError("detect", {
      cwd: String(targetPath),
      detail: "targetPath must be a non-empty path",
    });
  }
  if (!isAbsolute(targetPath)) {
    throw new ToolchainError("detect", { cwd: targetPath, detail: "targetPath must be absolute" });
  }

  const run = deps.runCommand ?? defaultRunCommand;
  const log = deps.log;

  if (!(await pathExists(join(targetPath, "package.json")))) {
    return prepareNonNode(targetPath, run, log);
  }

  // Reject a package.json/tsconfig module-system mismatch BEFORE install — the
  // check is static and cheap, and an incoherent scaffold must fail at creation
  // rather than provision a tree whose gate-passing code boot-crashes.
  await assertModuleCoherence(targetPath, log);

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
