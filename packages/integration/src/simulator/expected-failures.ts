import { profileOfSeed } from "./profile.js";
import type { RunMode, RunResult } from "./run.js";

/**
 * The fast tier's seeds that fail on today's code, each with the violation keys it fails (the
 * invariant and its subject, invariants.ts Violation.key) and the baseline entry naming the
 * defect (docs/investigations/simulator-baseline-2026-10-14.md). A seed here must fail exactly
 * these keys: a new violation in a known-failing seed, even of an invariant it already fails, is
 * unexpected, and a fix makes the seed fail its test until its entry is removed, so a known
 * failure can neither hide a new one nor outlive its fix. Every entry was observed under its seed's
 * own profile (profile.ts profileOfSeed), so it applies only to a run under that profile: the
 * profile chooses the faults, and under another one the seed is a different run with no entry.
 */
interface ExpectedFailure {
  readonly seed: number;
  /** The run mode the seed fails in (RunOptions.projects, RunOptions.capUsd); one project and the tape's cap when absent. */
  readonly projects?: 1 | 2;
  readonly capUsd?: number;
  readonly keys: readonly string[];
  readonly baseline: string;
}

/*
 * Re-chosen after the hardening of 31aefa1d (docs/investigations/simulator-baseline-2026-10-14.md
 * §7.5). No listed defect was fixed by it: replayed from their pre-hardening decisions on the new
 * code, seeds 1 (B1), 41 (B4) and 89 (B8) fail their old keys again, and seed 18 (B3) does once
 * its database fault is moved two occurrences later, past the boot query each of its two boots
 * now sends first. They stopped failing because the draws were one stream, so that one query
 * re-rolled every seed; the tape now draws per key (tape.ts) and the fast tier was re-chosen on
 * it: B1 seed 1 -> 4, B4 seed 41 -> 14. B8 has no seed in 1-300 on the keyed tape and is pinned
 * by a two-decision tape in simulator.test.ts instead of seed 89. B3 was seed 119 until the rebase
 * onto 4d40d185: model fault keys carry the model id, migration 047 replaced the catalog's models
 * (gpt-4-1, which the stand-ins were routed to, is deleted), and seed 119 lost its orphan. A seed whose failure needs a crash and then a fault on one reconciler query is re-rolled
 * by any such change, so B3 is pinned by its minimized three-decision tape there too. B1 (seed 4)
 * is removed: a check set keeps only the files under checks/<checked task id>/ (MVP W4), and seed 4
 * then fails none of its I3 product-file keys (observed: its listed keys were reported missing).
 * B4 (seed 14) is removed: no work item waits on a person (MVP W6), and an infrastructure fault is
 * requeued uncharged instead of parked at Blocked(environment_unavailable). Observed: seed 14's
 * decisions recorded on a9f781ce (simulate.ts --seeds 1 --start 14 --minimize: four git fault
 * decisions) fail I1:open, I2 environment_unavailable, I8:Blocked(environment_unavailable) and
 * I8:Pending there, and replayed on W6 end accepted with no violation, cycle 1 "interrupted". That
 * tape pins it in simulator.test.ts.
 *
 * The soak's known production failures (baseline §7.8, the triage of §7.7's two-project scans):
 * none is in the fast tier, which pins B5 and B8 by their tapes in simulator.test.ts instead; these
 * keep `just simulate` from counting them as unexpected until they are fixed, and a fix shows each
 * as listed-but-not-failed.
 */
const B5 = "B5 (baseline §3, §7.8; task t-merge-record-crash-window): a crash between the merge commit on main and its record; the startup reconciler requeues the task without looking on main";
const B3 = "B3 (baseline §3, §7.8, §7.9; task t-orphan-requeue-failure): a fault on the startup reconciler's dev_sessions read leaves a crash orphan InProgress until the next boot";
const B8 = "B8 (baseline §3, §7.8; task t-begin-failure-leaks-connection): a failed BEGIN leaves its pool connection checked out (drizzle-orm node-postgres session.transaction)";
/**
 * Two projects fail the same keys at a cap of $10 (§7.8's soak) and at the tape's own cap
 * (`--projects 2` alone, baseline §7.10), so each is listed in both modes.
 */
const TWO_PROJECT_FAILURES: ReadonlyArray<Omit<ExpectedFailure, "projects" | "capUsd">> = [
  { seed: 31, keys: ["I7:unrecorded:Set up the product's layout"], baseline: B5 },
  { seed: 46, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: `${B5}; the crash is at commitMerge's rev-parse HEAD, right after the commit` },
  { seed: 56, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 57, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 78, keys: ["I7:p2:unrecorded:Set up the product's layout"], baseline: B5 },
  { seed: 75, keys: ["I1:leaked-connection:begin"], baseline: B8 },
  // Named at the sixth restart since baseline §7.10 (the fifth in §7.9).
  { seed: 59, keys: ["I7:orphan:Define and commit the project environment:6"], baseline: B3 },
];
const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  { seed: 7, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 56, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 57, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  {
    seed: 45,
    keys: ["I7:unrecorded:Define and commit the project environment"],
    baseline: `${B5}; the crash is on a host git call inside the merge, after its commit and before "merge committed" is logged (baseline §7.10)`,
  },
  ...TWO_PROJECT_FAILURES.map((entry) => ({ ...entry, projects: 2, capUsd: 10 }) as const),
  ...TWO_PROJECT_FAILURES.map((entry) => ({ ...entry, projects: 2 }) as const),
  // Seed 18 at the tape's own cap (B5, baseline §7.10) is removed on the rebase onto bbd7a976: it
  // ends halted spend_cap with no violation there, the same on two runs; B5 is not fixed, the
  // seed no longer reaches its window (which of master's three commits re-rolled it: unverified).
];

/** The entry of one run, if it has one: its seed under the seed's own profile, in its run mode. */
function entryOf(run: Pick<RunResult, "seed" | "profile">, mode: RunMode): ExpectedFailure | undefined {
  if (run.profile !== profileOfSeed(run.seed)) return undefined;
  return EXPECTED_FAILURES.find((entry) => entry.seed === run.seed && (entry.projects ?? 1) === (mode.projects ?? 1) && entry.capUsd === mode.capUsd);
}

/** How a seed's violations differ from its entry: keys it failed and is not listed for, and listed keys it no longer fails. */
export interface ExpectedFailureDiff {
  readonly unexpected: readonly string[];
  readonly missing: readonly string[];
}

export function diffExpected(run: Pick<RunResult, "seed" | "profile" | "violations">, mode: RunMode): ExpectedFailureDiff {
  const listed = new Set(entryOf(run, mode)?.keys ?? []);
  const failed = new Set(run.violations.map((violation) => violation.key));
  return {
    unexpected: [...failed].filter((key) => !listed.has(key)).sort(),
    missing: [...listed].filter((key) => !failed.has(key)).sort(),
  };
}
