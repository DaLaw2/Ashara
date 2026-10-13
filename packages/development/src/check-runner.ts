import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// Deterministic check execution (Phase 2, mig-phase-2): pure functions plus an
// injected CommandRunner. Every runner execution-service builds runs the command
// inside a cell (cellAsRunner); there is no host runner.
// ---------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoreCheckResult {
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
  const results: CoreCheckResult[] = [];
  let allPassed = true;

  for (const cmd of customChecks) {
    const { exitCode, output } = await run(["sh", "-c", cmd], workDir, CHECK_TIMEOUT_MS);
    const passed = exitCode === 0;
    if (!passed) allPassed = false;
    results.push({ name: cmd, passed, output });
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
