import { coverageReport } from "./coverage.js";
import type { Coverage } from "./coverage.js";
import type { RunResult } from "./run.js";
import type { Decision } from "./tape.js";

/** One run's verdict, for the terminal: the line a reader acts on first, then the evidence. */
export function describeRun(result: RunResult, minimized: readonly Decision[] | null): string[] {
  const head = `seed ${result.seed} (${result.profile}): ${result.outcome.kind}${result.outcome.kind === "halted" ? ` [${result.outcome.cause}] ${result.outcome.detail}` : ""}; ${result.cycles} cycles, ${result.dispatches} dispatches, ${result.restarts} restarts, ${result.faults.length} faults, longest quiet ${result.longestQuiet}, ${result.durationMs} ms`;
  if (result.violations.length === 0) return [head];
  const lines = [head];
  for (const violation of result.violations) lines.push(`  ${violation.invariant} at cycle ${violation.step} [${violation.key}]: ${violation.statement}`);
  if (minimized !== null) {
    lines.push(`  minimal decisions (${minimized.length} of ${result.decisions.length}): ${JSON.stringify(minimized)}`);
  }
  return lines;
}

/** The coverage block of design §4.12: what was reached and what never was, per lifecycle list. */
export function describeCoverage(coverage: Coverage): string[] {
  const lines: string[] = [];
  for (const machine of coverageReport(coverage)) {
    lines.push(`${machine.machine}: ${machine.reached.length}/${machine.reached.length + machine.unreached.length} reached`);
    if (machine.unreached.length > 0) lines.push(`  never reached: ${machine.unreached.join(", ")}`);
  }
  return lines;
}
