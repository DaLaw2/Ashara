import { describeErrorChain } from "@ashara/shared";
import type { RunMode, RunResult } from "./run.js";

/** A determinism scenario's seed, in its run mode. */
export interface DeterminismRecheck {
  readonly seed: number;
  readonly mode: RunMode;
}

/**
 * The second seed of each determinism scenario, by the project count of the soak that runs it:
 * simulator-determinism.test.ts and simulator-determinism-two-projects.test.ts run each scenario's
 * first seed (21 at one project, 18 at two), the soak tier these. A seed's trace is a function of
 * the seed alone, so run twice in one process, the second after the first moved every counter a
 * run can leave behind, it is byte-identical.
 */
export const DETERMINISM_RECHECKS: Readonly<Record<1 | 2, DeterminismRecheck>> = {
  1: { seed: 6, mode: {} },
  2: { seed: 59, mode: { projects: 2, capUsd: 10 } },
};

/** A recheck's line for the soak's output, and whether it failed: the traces differ, or a run threw. */
export interface DeterminismVerdict {
  readonly line: string;
  readonly failed: boolean;
}

function describeRecheck(recheck: DeterminismRecheck): string {
  const projects = recheck.mode.projects ?? 1;
  const cap = recheck.mode.capUsd === undefined ? "the tape's cap" : `cap $${recheck.mode.capUsd}`;
  return `seed ${recheck.seed} (${projects === 2 ? "two projects" : "one project"}, ${cap})`;
}

/** The first line at which two traces part, or null when they are the same. */
function firstDifference(first: readonly string[], second: readonly string[]): string | null {
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    if (first[index] !== second[index]) {
      const line = (trace: readonly string[]): string => (index < trace.length ? JSON.stringify(trace[index]) : "(the trace ended)");
      return `line ${index + 1}: ${line(first)} the first time, ${line(second)} the second`;
    }
  }
  return null;
}

/**
 * Runs the recheck's seed twice, one run after the other in this process, and compares the traces.
 * A run that throws fails the recheck: a soak never passes over a determinism check it could not make.
 */
export async function recheckDeterminism(
  recheck: DeterminismRecheck,
  run: (seed: number, mode: RunMode) => Promise<Pick<RunResult, "trace">>,
): Promise<DeterminismVerdict> {
  const named = `determinism: ${describeRecheck(recheck)} run twice in one process`;
  try {
    const first = await run(recheck.seed, recheck.mode);
    const second = await run(recheck.seed, recheck.mode);
    const difference = firstDifference(first.trace, second.trace);
    return difference === null ? { line: `${named}: the same trace`, failed: false } : { line: `${named}: the traces differ at ${difference}`, failed: true };
  } catch (err) {
    return { line: `${named}: no verdict: the run threw: ${describeErrorChain(err)}`, failed: true };
  }
}
