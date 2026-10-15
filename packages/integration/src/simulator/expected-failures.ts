import { profileOfSeed } from "./profile.js";
import type { Profile } from "./profile.js";
import type { RunMode, RunResult } from "./run.js";

/**
 * The fast tier's seeds that fail on today's code, each with the violation keys it fails (the
 * invariant and its subject, invariants.ts Violation.key) and the baseline entry naming the
 * defect (docs/investigations/simulator-baseline-2026-10-14.md). A seed here must fail exactly
 * these keys: a new violation in a known-failing seed, even of an invariant it already fails, is
 * unexpected, and a fix makes the seed fail its test until its entry is removed, so a known
 * failure can neither hide a new one nor outlive its fix. An entry applies only to a run under the
 * profile it was observed under, its seed's own (profile.ts profileOfSeed) unless it names one: the
 * profile chooses the faults, and under another one the seed is a different run with no entry.
 */
interface ExpectedFailure {
  readonly seed: number;
  /** The profile the failure was observed under (`--profile`); the seed's own when absent. */
  readonly profile?: Profile;
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
/*
 * Re-rolled 2026-10-15 (t-merge-conflict-rebase, w12b D2): a retry now asks git whether its branch
 * conflicts with main, and every host git call is a seam the interleaver turns at and a crash can
 * land on, so B5's crash window moved between seeds and projects. Observed on that change with
 * `simulate.ts --projects 2 --cap 10` over seeds 1-85 and `--projects 2` over seeds 1-85: seeds 28,
 * 39 and 82 now fail B5's key, 46 and 56 fail it in project 1 instead of project 2, 57 no longer
 * fails, and 77 fails it at the tape's cap only; each statement is B5's ("main commit ... has no item
 * Completed recording it (the item is Pending)"). Where in the merge each new crash lands: unverified.
 */
const TWO_PROJECT_FAILURES: ReadonlyArray<Omit<ExpectedFailure, "projects" | "capUsd">> = [
  { seed: 28, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: B5 },
  // Removed on the batch-1 merge (2026-10-15, after t-simulator-parallel, t-oracle-independence, t-ddd-fix-*): the
  // 80-seed soaks (`simulate.ts --seeds 80 --projects 1|2`) reported each listed but not failed; B3 and B5 are not fixed.
  { seed: 39, keys: ["I7:p2:unrecorded:Set up the product's layout"], baseline: B5 },
  { seed: 46, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 56, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 78, keys: ["I7:p2:unrecorded:Set up the product's layout"], baseline: B5 },
  { seed: 82, keys: ["I7:p2:unrecorded:Define and commit the project environment", "I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 75, keys: ["I1:leaked-connection:begin"], baseline: B8 },
  // Named at the sixth restart since baseline §7.10 (the fifth in §7.9).
  { seed: 59, keys: ["I7:orphan:Define and commit the project environment:6"], baseline: B3 },
];
/** Two projects at the tape's own cap only (`--projects 2`): at $10 these seeds end with no violation. */
const TWO_PROJECT_TAPE_CAP_FAILURES: ReadonlyArray<Omit<ExpectedFailure, "projects" | "capUsd">> = [
];
const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  { seed: 7, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 56, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  // Seed 45 (B5, the crash on a host git call inside the merge, baseline §7.10) is removed on
  // t-merge-conflict-rebase: `simulate.ts --seeds 30 --start 31` reported it listed but not failed,
  // with the re-roll above; B5 is not fixed. Seeds 81 and 89 fail B5's key with this change and on
  // master 273cc7b0's development and planning sources alike (observed, `simulate.ts --seeds 1
  // --start 81` and `--start 89` on each, 2026-10-15): unlisted before, not introduced by it. Seed 81
  // is removed and seed 89 re-keyed since, below.
  // Re-rolled at master 02d1e6e5 (t-text-vs-fact-oracle, 2026-10-15): `simulate.ts --seeds 120 --start 1` reported
  // seed 81 listed but not failed, seed 89 failing B5's key on "Define and commit the project environment" instead
  // of "Set up the product's layout", and seed 43 failing B5's key unlisted ("main commit ... has no item Completed
  // recording it (the item is Pending)"). Each the same with I9's reads removed from the snapshot (`--seeds 9
  // --start 81`, `--seeds 1 --start 43`), so not introduced by I9; which master commit re-rolled them: unverified.
  // B5 is not fixed.
  { seed: 89, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 43, keys: ["I7:unrecorded:Deliver b1, b2, b3 [sim t1]"], baseline: B5 },
  // Unlisted at master 02d1e6e5, observed at $10 only (`simulate.ts --seeds 85 --projects 2 --cap 10`, 2026-10-15):
  // project 2's environment task is left InProgress after a restart; the same with I9's reads removed from the
  // snapshot (`--seeds 1 --start 6 --projects 2 --cap 10`). At the tape's own cap: unverified.
  { seed: 6, projects: 2, capUsd: 10, keys: ["I7:p2:orphan:Define and commit the project environment:1"], baseline: B3 },
  // Re-rolled on t-ddd-fix-durable-reservation (2026-10-15): an admission now writes its call's
  // llm_calls row and a record updates it, two more db seams per call, and seed 10 under the
  // typical profile (`just simulate --seeds 10 --profile typical`) now crashes and then draws a
  // db-query-failed on the startup reconciler's work_items requeue UPDATE. Observed with
  // `simulate.ts --seeds 1 --start 10 --profile typical`: exit 1 with these keys, and the trace's
  // "failed to requeue crash-orphaned InProgress item"; on master f6655789 the same run ends
  // accepted with 0 restarts. B3 names the dev_sessions read; the UPDATE is the same window, a
  // fault anywhere in requeueOrphan (startup-reconciler.ts) leaves the orphan InProgress.
  {
    seed: 10,
    profile: "typical",
    keys: ["I1:open", 'I7:orphan:Write the checks for "Deliver b1, b2, b3, b4 [sim t1]":1', "I8:InProgress", "I8:Pending"],
    baseline: B3,
  },
  ...TWO_PROJECT_FAILURES.map((entry) => ({ ...entry, projects: 2, capUsd: 10 }) as const),
  ...[...TWO_PROJECT_FAILURES, ...TWO_PROJECT_TAPE_CAP_FAILURES].map((entry) => ({ ...entry, projects: 2 }) as const),
  // Seed 18 at the tape's own cap (B5, baseline §7.10) is removed on the rebase onto bbd7a976: it
  // ends halted spend_cap with no violation there, the same on two runs; B5 is not fixed, the
  // seed no longer reaches its window (which of master's three commits re-rolled it: unverified).
];

/** The entry of one run, if it has one: its seed under the entry's profile, in its run mode. */
function entryOf(run: Pick<RunResult, "seed" | "profile">, mode: RunMode): ExpectedFailure | undefined {
  return EXPECTED_FAILURES.find(
    (entry) =>
      entry.seed === run.seed &&
      (entry.profile ?? profileOfSeed(entry.seed)) === run.profile &&
      (entry.projects ?? 1) === (mode.projects ?? 1) &&
      entry.capUsd === mode.capUsd,
  );
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
