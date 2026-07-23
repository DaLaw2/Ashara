import { spawn } from "node:child_process";

import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// Command allowlist + deterministic check execution (Phase 2, mig-phase-2).
//
// Single implementation behind both the in-process development verify() and the
// out-of-process agent-runner runInlineVerify() adapters — pure functions plus
// an injected CommandRunner (defaulting to a local `spawn`), no shared runtime
// state.
//
// Anchored allowlist: the command must be the WHOLE string (^...$). An
// unanchored variant treats natural-language acceptance criteria such as
// "npx tsc --noEmit passes" as an executable command (matched by a leading
// "npx tsc") and runs it — the vulnerability this anchoring closes.
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LENGTH = 2000;
export const CHECK_TIMEOUT_MS = 30_000;

export const ALLOWED_CHECK_COMMANDS = [
  /^cargo\s+(test|check|clippy|fmt|build)(\s+-[\w-]+)*$/,
  /^bun\s+(test|run\s+\w+)(\s+-[\w-]+)*$/,
  /^bunx\s+tsc(\s+--[\w-]+)*$/,
  /^npm\s+(test|run\s+\w+)(\s+--[\w-]+)*$/,
  /^npx\s+\w+(\s+--[\w-]+)*$/,
  /^go\s+(test|build|vet)(\s+-[\w-]+)*(\s+\.\/\.\.\.)?$/,
  /^python\s+-m\s+(pytest|unittest)(\s+-[\w-]+)*$/,
  /^make\s+\w+$/,
  /^just\s+\w+$/,
];

const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>!\\]/;

export function isAllowedCheck(cmd: string): boolean {
  if (SHELL_METACHARACTERS.test(cmd)) return false;
  return ALLOWED_CHECK_COMMANDS.some((re) => re.test(cmd));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoreCheckResult {
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

export interface DeterministicOutcome {
  readonly tier: CoreTierResult;
  readonly checksSkipped: Array<{ name: string; reason: string }>;
}

export async function runDeterministicChecks(
  run: CommandRunner,
  workDir: string,
  customChecks: string[],
  skippedChecks: Array<{ name: string; reason: string }> = [],
): Promise<DeterministicOutcome> {
  const results: CoreCheckResult[] = [];
  let allPassed = true;

  for (const cmd of customChecks) {
    const { exitCode, output } = await run(["sh", "-c", cmd], workDir, CHECK_TIMEOUT_MS);
    const passed = exitCode === 0;
    if (!passed) allPassed = false;
    results.push({ name: cmd, passed, output });
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
    checksSkipped: skippedChecks,
  };
}
