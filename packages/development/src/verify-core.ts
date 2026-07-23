import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { prepare, ToolchainError } from "./project-toolchain.js";
import type { ToolchainDeps, ToolchainResult } from "./project-toolchain.js";
import {
  isAllowedCheck,
  defaultRunCommand,
  runDeterministicChecks,
} from "./check-runner.js";
import type { CoreTierResult } from "./check-runner.js";

// ---------------------------------------------------------------------------
// Shared verify check library (Phase 2, mig-phase-2).
//
// Single implementation behind both the in-process development verify() and the
// out-of-process agent-runner runInlineVerify() adapters. The agent runs in a
// subprocess, so this library is pure functions plus an injected command
// runner — no shared runtime state. Each process supplies its own command
// runner (defaulting to a local `spawn`).
//
// Verification is deterministic checks only: tsc/cargo check/npm test/custom
// commands (check-runner.ts). Evidence across 11 E2E runs: every real quality
// catch came from this deterministic tier; an LLM judge tier previously sat
// here and its only measured contribution was false abandonment (a refuted
// claim carried forward until task exhaustion). It has been removed —
// deterministic pass is the sole pass/fail signal.
//
// Divergence resolutions (docs/migration-plan.md Phase 2):
//   - isAllowedCheck uses the ANCHORED allowlist (closes the agent-side
//     "npx tsc --noEmit passes" NL-as-command hole).
//
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// here, at the single choke point both adapters route through. Neither adapter
// (nor any future one) may fall back to `process.cwd()` when a caller omits
// them — that silently ran git commands against whatever the host process's
// ambient working directory happened to be (Discipline A violation).
// ---------------------------------------------------------------------------

export interface CoreVerifyResult {
  readonly passed: boolean;
  readonly tiers: {
    readonly deterministic: CoreTierResult;
  };
}

/**
 * Injected command runner. The default runs a local subprocess; both the
 * in-process and out-of-process callers spawn their own children (no shared
 * state), and tests may substitute a deterministic runner.
 */
export type CommandRunner = (
  command: string[],
  cwd: string,
  timeout: number,
) => Promise<{ exitCode: number; output: string }>;

export type VerifyLogFn = (event: Record<string, unknown>) => void;

export interface CoreVerifyInput {
  readonly workDir: string;
  readonly gitRoot: string;
  readonly checks: string[];
}

export interface CoreVerifyDeps {
  readonly runCommand?: CommandRunner;
  readonly log?: VerifyLogFn;
  /**
   * Toolchain preparer, run before the deterministic checks when the workDir is
   * a Node project (package.json present), using the SAME injected runCommand.
   * Default: the real prepare(). Tests inject a deterministic stub.
   */
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<ToolchainResult>;
}

// ---------------------------------------------------------------------------
// GIT-SAFETY (a): workDir/gitRoot validation
// ---------------------------------------------------------------------------

export class InvalidVerifyPathError extends Error {
  constructor(
    public readonly field: "workDir" | "gitRoot",
    public readonly received: string,
    public readonly reason: string,
  ) {
    super(`verify-core: invalid ${field} ${JSON.stringify(received)} — ${reason}`);
    this.name = "InvalidVerifyPathError";
  }
}

function assertValidVerifyPath(value: string, field: "workDir" | "gitRoot"): void {
  // Runtime guard, not just a compile-time one: a caller that bypasses the
  // (required) TS type — e.g. an `as` cast from a looser upstream shape —
  // can still hand this an undefined/non-string value at runtime.
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidVerifyPathError(field, String(value), "must be a non-empty path");
  }
  if (!isAbsolute(value)) {
    throw new InvalidVerifyPathError(field, value, "must be an absolute path");
  }
}

function toolchainFailureDetails(err: unknown): string {
  if (err instanceof ToolchainError) {
    const ctx = err.context;
    const excerpt = ctx.outputExcerpt ? `; output: ${ctx.outputExcerpt.slice(0, 300)}` : "";
    return (
      `toolchain preparation failed at step "${err.step}": ${ctx.detail}` +
      (ctx.command ? ` [${ctx.command.join(" ")}]` : "") +
      (ctx.exitCode !== undefined ? ` (exit ${ctx.exitCode})` : "") +
      excerpt
    );
  }
  return `toolchain preparation error: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Run the toolchain preparer for a Node workDir (package.json present). Returns
 * null on success or when the project is not Node (nothing to prepare); returns
 * a fully-formed failed CoreVerifyResult when preparation throws, so the caller
 * fails closed without running any check on an unprepared tree.
 */
async function prepareToolchainForVerify(
  workDir: string,
  run: CommandRunner,
  deps: CoreVerifyDeps,
  log: VerifyLogFn | undefined,
): Promise<CoreVerifyResult | null> {
  const hasPkgJson = await access(join(workDir, "package.json")).then(() => true, () => false);
  if (!hasPkgJson) {
    return null;
  }
  const prepareFn = deps.prepareToolchain ?? prepare;
  try {
    await prepareFn(workDir, { runCommand: run, log });
    return null;
  } catch (err) {
    const details = toolchainFailureDetails(err);
    log?.({ event: "verify_toolchain_failed", details });
    return {
      passed: false,
      tiers: {
        deterministic: { status: "fail", details },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Baseline check injection (tech-stack auto-detection)
// ---------------------------------------------------------------------------

interface BaselineCheck {
  readonly command: string;
  readonly label: string;
}

const BASELINE_TSC_RE = /\btsc\b/;
const BASELINE_CARGO_RE = /^cargo\s+check\b/;
const BASELINE_GO_RE = /^go\s+build\b/;

function hasExistingCheck(checks: readonly string[], label: string): boolean {
  switch (label) {
    case "typescript": return checks.some((c) => BASELINE_TSC_RE.test(c));
    case "rust": return checks.some((c) => BASELINE_CARGO_RE.test(c));
    case "go": return checks.some((c) => BASELINE_GO_RE.test(c));
    default: return false;
  }
}

async function detectBaselineChecks(workDir: string): Promise<BaselineCheck[]> {
  const fileExists = (name: string): Promise<boolean> =>
    access(join(workDir, name)).then(() => true, () => false);

  const [hasPkgJson, hasTsConfig, hasCargo, hasGoMod] = await Promise.all([
    fileExists("package.json"),
    fileExists("tsconfig.json"),
    fileExists("Cargo.toml"),
    fileExists("go.mod"),
  ]);

  const baselines: BaselineCheck[] = [];
  if (hasPkgJson && hasTsConfig) {
    baselines.push({ command: "npx --no-install tsc --noEmit", label: "typescript" });
  }
  if (hasCargo) {
    baselines.push({ command: "cargo check", label: "rust" });
  }
  if (hasGoMod) {
    baselines.push({ command: "go build ./...", label: "go" });
  }
  return baselines;
}

// ---------------------------------------------------------------------------
// Core verify
// ---------------------------------------------------------------------------

/**
 * Run the deterministic verify pipeline: toolchain preparation, then the
 * deterministic checks (tsc/cargo check/npm test/custom commands). `passed`
 * is exactly the deterministic tier's outcome — nothing else feeds it.
 *
 * Never fails open: a toolchain-preparation failure or a failing check yields
 * `passed=false`. A throwing log sink propagates (fail-closed at the caller).
 */
export async function runVerifyCore(
  input: CoreVerifyInput,
  deps: CoreVerifyDeps = {},
): Promise<CoreVerifyResult> {
  assertValidVerifyPath(input.workDir, "workDir");
  assertValidVerifyPath(input.gitRoot, "gitRoot");

  const run = deps.runCommand ?? defaultRunCommand;
  const log = deps.log;

  // Reproduce the project's build semantics BEFORE any deterministic check, so
  // the agent-worktree tsc runs against the same prepared tree the gate does
  // (ADR-032 §1: one implementation, one environment). Only Node projects are
  // preparable — a workDir with no package.json (e.g. a Rust crate) is left
  // untouched. Fail-closed (Run 9 / R8-F6a class): a toolchain failure yields a
  // failed deterministic tier carrying the typed, self-diagnosing context;
  // never fall through to running tsc on an unprepared tree.
  const toolchainFailure = await prepareToolchainForVerify(input.workDir, run, deps, log);
  if (toolchainFailure) {
    return toolchainFailure;
  }

  const baselines = await detectBaselineChecks(input.workDir);
  const uniqueBaselines = baselines.filter((b) => !hasExistingCheck(input.checks, b.label));

  if (uniqueBaselines.length > 0) {
    log?.({
      event: "verify_baseline_inject",
      baselines: uniqueBaselines.map((b) => ({ command: b.command, label: b.label })),
    });
  }

  const allChecks = [
    ...uniqueBaselines.map((b) => b.command),
    ...input.checks,
  ];

  const executableChecks = allChecks.filter(isAllowedCheck);
  const skippedChecks = allChecks
    .filter((c) => !isAllowedCheck(c))
    .map((c) => ({ name: c, reason: "not in allowlist" }));

  if (executableChecks.length === 0 && input.checks.length > 0) {
    const details = "no executable checks — cannot verify task output";
    log?.({
      event: "verify_deterministic",
      status: "fail",
      details,
      checks: [],
      checksSkipped: skippedChecks,
    });
    log?.({ event: "verify_final", passed: false });
    return {
      passed: false,
      tiers: { deterministic: { status: "fail", details } },
    };
  }

  if (executableChecks.length === 0) {
    log?.({
      event: "verify_no_checks_warning",
      workDir: input.workDir,
      reason: "no tech stack detected and no custom checks specified",
    });
  }

  const deterministicOutcome = await runDeterministicChecks(run, input.workDir, executableChecks, skippedChecks);
  const deterministic = deterministicOutcome.tier;

  log?.({
    event: "verify_deterministic",
    status: deterministic.status,
    details: deterministic.details,
    checks: deterministic.checks ?? [],
    checksSkipped: deterministicOutcome.checksSkipped,
  });

  const passed = deterministic.status === "pass";

  log?.({ event: "verify_final", passed });

  return {
    passed,
    tiers: {
      deterministic,
    },
  };
}
