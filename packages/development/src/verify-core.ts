import { isAbsolute } from "node:path";
import { runDeterministicChecks } from "./check-runner.js";
import type { CoreTierResult } from "./check-runner.js";
import { readVerifyConfig, isVacuousCommand } from "./verify-config.js";

// ---------------------------------------------------------------------------
// Shared verify check library (Phase 2, mig-phase-2).
//
// Single implementation behind both verify callers (execution-service
// and the post-merge gate): pure functions plus an injected command runner — no
// shared runtime state.
//
// Containment is structural: each caller injects a CommandRunner (required,
// no fallback); execution-service builds it from a cell (cellAsRunner), and
// there is no host runner to fall back to.
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
type VerifyVerdict = "passed" | "failed" | "unverified";

export interface CoreVerifyResult {
  readonly verdict: VerifyVerdict;
  readonly tiers: {
    readonly deterministic: CoreTierResult;
  };
  // Structured drop list lives in the JSONL log (checksSkipped); drop visibility is in details.
}

/**
 * Injected command runner: `command` is an argv array, `cwd` a host path the
 * runner maps into its cell, `timeout` milliseconds. Tests substitute a
 * deterministic runner.
 */
export type CommandRunner = (
  command: string[],
  cwd: string,
  timeout: number,
) => Promise<{ exitCode: number; output: string }>;

// open-by-design: log payloads carry caller-defined diagnostic fields
type VerifyLogFn = (event: Record<string, unknown>) => void;

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
   * How to execute deterministic check commands. Required, no fallback: a
   * forgotten injection is a compile error, not silent host execution
   * (Discipline A: the identity element is unavailable).
   */
  readonly runCommand: CommandRunner;
  readonly log?: VerifyLogFn;
}

// ---------------------------------------------------------------------------
// GIT-SAFETY (a): workDir/gitRoot validation
// ---------------------------------------------------------------------------

/** @testseam verify-core.test.ts asserts the typed rejection */
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

// ---------------------------------------------------------------------------
// Core verify
// ---------------------------------------------------------------------------

/**
 * Run the deterministic checks (verify.toml first, then contract and task-spec
 * checks). `passed` is exactly the deterministic tier's outcome; nothing else
 * feeds it. Ashara prepares no toolchain: whatever a check needs must already be
 * in the cell (s-platform-role-m1 builds images from the committed environment).
 *
 * Never fails open: a failing check yields `verdict="failed"`, and zero checks
 * `"unverified"`. A throwing log sink propagates (fail-closed at the caller).
 */
export async function runVerifyCore(
  input: CoreVerifyInput,
  deps: CoreVerifyDeps,
): Promise<CoreVerifyResult> {
  assertValidVerifyPath(input.workDir, "workDir");
  assertValidVerifyPath(input.gitRoot, "gitRoot");

  const checkRun = deps.runCommand;
  const log = deps.log;

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
