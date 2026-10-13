import { spawn } from "node:child_process";
import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// Deterministic check execution (Phase 2, mig-phase-2).
//
// Single implementation behind the host-side verify callers — pure functions
// plus an injected CommandRunner, no shared runtime state.
//
// Containment is structural, not enumerative: callers inject a CommandRunner
// built from the Provisioner abstraction (provisionerAsRunner in
// execution-service.ts).
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LENGTH = 2000;
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
