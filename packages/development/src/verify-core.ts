import { isAbsolute } from "node:path";
import { prepare, ToolchainError } from "./project-toolchain.js";
import type { ToolchainDeps, ToolchainResult } from "./project-toolchain.js";
import {
  runDeterministicChecks,
} from "./check-runner.js";
import type { CoreTierResult } from "./check-runner.js";
import { readVerifyConfig, isVacuousCommand } from "./verify-config.js";

// ---------------------------------------------------------------------------
// Shared verify check library (Phase 2, mig-phase-2).
//
// Single implementation behind the host-side verify callers (execution-service
// and the post-merge gate): pure functions plus an injected command runner — no
// shared runtime state.
//
// Containment is structural: each caller injects a CommandRunner (required,
// no fallback), built from the Provisioner abstraction (provisionerAsRunner)
// or, with no provisioner wired, defaultRunCommand.
// The absence of a fallback is the mechanism: a caller that forgets to
// inject a runner gets a compile error, not silent host execution.
//
// Verification is deterministic checks only: tsc/cargo check/npm test/custom
// commands (check-runner.ts). Evidence across 11 E2E runs: every real quality
// catch came from this deterministic tier; an LLM judge tier previously sat
// here and its only measured contribution was false abandonment (a refuted
// claim carried forward until task exhaustion). It has been removed —
// deterministic pass is the sole pass/fail signal.
//
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// here, at the single choke point both adapters route through. Neither adapter
// (nor any future one) may fall back to `process.cwd()` when a caller omits
// them — that silently ran git commands against whatever the host process's
// ambient working directory happened to be (Discipline A violation).
// ---------------------------------------------------------------------------

/**
 * Three-state verification outcome. `"unverified"` is the honest result when
 * zero executable checks existed — neither pass nor fail, because nothing was
 * tested.
 */
export type VerifyVerdict = "passed" | "failed" | "unverified";

export interface CoreVerifyResult {
  readonly verdict: VerifyVerdict;
  readonly tiers: {
    readonly deterministic: CoreTierResult;
  };
  // Structured drop list lives in the JSONL log (checksSkipped); drop visibility is in details.
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

// open-by-design: log payloads carry caller-defined diagnostic fields
export type VerifyLogFn = (event: Record<string, unknown>) => void;

export interface CoreVerifyInput {
  readonly workDir: string;
  readonly gitRoot: string;
  readonly checks: string[];
  /**
   * Executable checks extracted from the contract's knowledge-graph `check`
   * nodes. These are LLM-derived at decomposition time and carry the command
   * the LLM judged appropriate for this project's tech stack — no hardcoded
   * language list, so a PHP or Zig target works with zero code changes.
   *
   * Merge order: verify.toml (agent-observed reality) > contractChecks
   * (LLM-derived intent) > taskSpec checks (decomposition NL). A check
   * already present in a higher-priority source is not re-added.
   */
  readonly contractChecks: readonly string[];
}

export interface CoreVerifyDeps {
  /**
   * How to execute deterministic check commands (npm test, cargo check, etc.).
   * Required — no fallback. Host-side callers inject a runner built from the
   * Provisioner abstraction, or defaultRunCommand explicitly when no
   * provisioner is wired. The absence of a default is the mechanism:
   * a forgotten injection is a compile error, not silent host execution
   * (Discipline A: the identity element is unavailable).
   */
  readonly runCommand: CommandRunner;
  /**
   * How to execute toolchain preparation commands (npm install, cargo build,
   * go mod download). Required — no fallback. Separate from runCommand
   * because preparation needs network access (to fetch dependencies) while
   * checks do not. Host-side callers inject a Provisioner-backed runner
   * with network enabled, or defaultRunCommand explicitly when no
   * provisioner is wired.
   *
   * The split is here because the decision "preparation needs network"
   * belongs to the caller, not to the runner.
   */
  readonly prepareRunCommand: CommandRunner;
  readonly log?: VerifyLogFn;
  /**
   * Toolchain preparer, run before the deterministic checks. Dispatches for
   * any project type (Node, Cargo, Go). Default: the real prepare(). Tests
   * inject a deterministic stub.
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
 * Run the toolchain preparer for the workDir. Returns null on success; returns
 * a fully-formed failed CoreVerifyResult when preparation throws, so the caller
 * fails closed without running any check on an unprepared tree.
 *
 * `prepare()` dispatches internally: Node projects (package.json present) get
 * dependency installation and codegen; non-Node projects (Cargo.toml, go.mod)
 * get their own build/download step; projects with no recognized manifest get
 * a no-op return. This function does not gate on project type — `prepare()`
 * owns that routing.
 */
async function prepareToolchainForVerify(
  workDir: string,
  prepareRun: CommandRunner,
  deps: CoreVerifyDeps,
  log: VerifyLogFn | undefined,
): Promise<CoreVerifyResult | null> {
  const prepareFn = deps.prepareToolchain ?? prepare;
  try {
    await prepareFn(workDir, { runCommand: prepareRun, log });
    return null;
  } catch (err) {
    const details = toolchainFailureDetails(err);
    log?.({ event: "verify_toolchain_failed", details });
    return {
      verdict: "failed",
      tiers: {
        deterministic: { status: "fail", details },
      },
    };
  }
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
 * `verdict="failed"`. A throwing log sink propagates (fail-closed at the caller).
 */
export async function runVerifyCore(
  input: CoreVerifyInput,
  deps: CoreVerifyDeps,
): Promise<CoreVerifyResult> {
  assertValidVerifyPath(input.workDir, "workDir");
  assertValidVerifyPath(input.gitRoot, "gitRoot");

  const checkRun = deps.runCommand;
  const prepareRun = deps.prepareRunCommand;
  const log = deps.log;

  // Reproduce the project's build semantics BEFORE any deterministic check, so
  // the agent-worktree tsc runs against the same prepared tree the gate does
  // (ADR-032 §1: one implementation, one environment). Preparation dispatches
  // per project type: Node (npm/bun install + codegen), Cargo (cargo build),
  // Go (go mod download), or no-op when no recognized manifest is present.
  // Fail-closed (Run 9 / R8-F6a class): a toolchain failure yields a failed
  // deterministic tier carrying the typed, self-diagnosing context; never fall
  // through to running checks on an unprepared tree.
  //
  // prepareRun has network access; checkRun does not. Preparation fetches
  // dependencies; checks observe the already-built tree.
  const toolchainFailure = await prepareToolchainForVerify(input.workDir, prepareRun, deps, log);
  if (toolchainFailure) {
    return toolchainFailure;
  }

  const verifyConfig = await readVerifyConfig(input.workDir);
  const configChecks = verifyConfig.checks
    .map((c) => c.command)
    .filter((cmd) => !isVacuousCommand(cmd));
  const vacuousCount = verifyConfig.checks.length - configChecks.length;
  if (vacuousCount > 0) {
    log?.({
      event: "verify_vacuous_checks_filtered",
      count: vacuousCount,
      workDir: input.workDir,
    });
  }
  const hasVerifyToml = configChecks.length > 0;

  if (hasVerifyToml) {
    log?.({
      event: "verify_toml_loaded",
      checks: verifyConfig.checks.map((c) => ({ name: c.name, command: c.command })),
    });
  }

  const contractChecks = input.contractChecks;

  if (contractChecks.length > 0) {
    log?.({
      event: "verify_contract_checks",
      checks: contractChecks,
    });
  }

  // Merge order (documented, not implicit):
  //   1. verify.toml — agent-observed reality, authoritative
  //   2. contractChecks — LLM-derived from knowledge-graph check nodes
  //   3. taskSpec checks (input.checks) — decomposition NL, fill gaps
  //
  // Per-task verification passes empty arrays for contractChecks and
  // input.checks — those reference project-wide files that may not exist in
  // a task's worktree. Only verify.toml (written by the agent in the
  // worktree) is authoritative at per-task scope. Contract and taskSpec
  // checks are deferred to integration verify, which runs against the full
  // merged tree.
  const seen = new Set<string>();
  const allChecks: string[] = [];

  const addUnique = (checks: readonly string[]): void => {
    for (const c of checks) {
      if (!seen.has(c)) {
        seen.add(c);
        allChecks.push(c);
      }
    }
  };

  if (hasVerifyToml) {
    addUnique(configChecks);
  }
  addUnique(contractChecks);
  addUnique(input.checks);

  if (allChecks.length === 0) {
    const details = "no executable checks — unverified";
    log?.({
      event: "verify_no_checks_warning",
      workDir: input.workDir,
      reason: "no tech stack detected and no custom checks specified",
    });
    log?.({ event: "verify_final", verdict: "unverified" });
    return {
      verdict: "unverified",
      tiers: { deterministic: { status: "skipped", details } },
    };
  }

  const deterministicOutcome = await runDeterministicChecks(checkRun, input.workDir, allChecks);
  const deterministic = deterministicOutcome.tier;

  log?.({
    event: "verify_deterministic",
    status: deterministic.status,
    details: deterministic.details,
    checks: deterministic.checks ?? [],
  });

  const verdict: VerifyVerdict = deterministic.status === "pass"
    ? "passed"
    : "failed";

  log?.({ event: "verify_final", verdict });

  return {
    verdict,
    tiers: { deterministic },
  };
}
