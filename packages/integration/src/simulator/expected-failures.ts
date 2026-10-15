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
/*
 * Re-rolled 2026-10-15 (t-ddd-fix-own-faults): a fault of Ashara's own machinery is no longer
 * charged as a failed attempt and replanned but requeued uncharged, and a worktree slot is cleared
 * before each `worktree add`; both move every later seam call. Observed with `simulate.ts --seeds 80
 * --projects 2 --jobs 4`, `--seeds 85 --projects 2 --cap 10 --jobs 4` and `--seeds 10 --start 81
 * --projects 2`: 28, 39, 46 and 75 were reported listed but not failed in both modes, 82 no longer
 * fails its project-1 key, 59 fails its orphan in project 2; 5, 6, 9, 19 and 49 fail newly. Each
 * I7:unrecorded statement is B5's, and the replay traces of 5, 19 and 49 show "merge record ...
 * giving up" and of 9 "requeued ...; its dispatch never finished" for the task of the unrecorded
 * merge commit; the replay traces of 6 and 59 show "failed to requeue crash-orphaned InProgress
 * item" (B3). Seed 89 (`--projects 2`) fails I7:p2:orphan outside the soak's range: unlisted, its
 * cause unverified. B3, B5 and B8 are not fixed.
 */
/*
 * Re-rolled 2026-10-15 (t-adversarial-models): hostile and chaos now draw their review and dispute
 * rates per seed and mix response-level model misbehaviour in (profile.ts), which moves the seams
 * every hostile and chaos seed passes through, so the crash windows of B3, B5 and B8 moved between
 * seeds. Observed on its branch (before the merge onto t-ddd-fix-own-faults) with `simulate.ts
 * --seeds 90` at `--projects 2` and at `--projects 2 --cap 10`: every new key was a fault seam's (a
 * crash, a failed query), none a model response's.
 */
/*
 * Re-derived 2026-10-15 at the merge of t-adversarial-models onto t-ddd-fix-own-faults,
 * t-text-vs-fact-oracle and t-change-message-honest (master 640d8205): the two changes' re-rolls
 * compose into a different run per hostile and chaos seed, so the union of both sides' entries was
 * soaked and cut to what fails. Observed with `simulate.ts --seeds 90 --jobs 6` at `--projects 1`,
 * `--projects 2` and `--projects 2 --cap 10`: listed but not failed were 7 and 43 (one project), 5,
 * 7, 19, 28, 46 and 59 and 49's and 82's project-1 keys (two projects, both caps), 9 (both caps),
 * 65's I3 key and 75 (B8) at $10. Unlisted and now listed: 86 in both modes, replay trace "merge
 * committed to main as f72835da" for task 779a80b5, then a crash on the work_items update and
 * "[startup-reconciler] requeued 779a80b5" (B5); 89 in both modes, replay trace "failed to requeue
 * crash-orphaned InProgress item a57e631b ... select "phase" from "dev_sessions"" (B3); 65 at $10,
 * replay trace "merge committed to main as 5cbf0acf" for task 83f9aaa3, then a crash on its
 * Completed update and "[startup-reconciler] requeued 83f9aaa3" (B5). Every key is a fault seam's;
 * none a model response's. B3, B5 and B8 are not fixed.
 */
/*
 * Re-rolled 2026-10-15 (t-ddd-r1-contract-out): the planner's knowledge-graph call is deleted, one
 * model call and its llm_calls admission and record queries fewer per plan, so every later db seam
 * draws at a different occurrence and the crash windows of B3 and B5 moved. On master 42353f94,
 * `simulate.ts --seeds 80` at `--projects 1` and at `--projects 2` reported 0 unexpected. On the
 * change, `--seeds 80 --projects 1`, `--seeds 10 --start 81 --projects 1`, `--seeds 80 --projects 2`,
 * `--seeds 10 --start 81 --projects 2` and `--seeds 90 --projects 2 --cap 10` reported: listed but
 * not failed 49, 86 and 89 (two projects, both caps) and 65 (at $10); a key moved for 6 (one
 * project: orphan occurrence 3 -> 2; two projects: the p2 orphan became a p2 unrecorded), 56 (two
 * projects: project 1 -> project 2) and 89 (one project: the environment task -> the layout task);
 * newly failing 29 (one project) and 59 (two projects, both caps). Replay traces: 6 (one project)
 * and 59 show "failed to requeue crash-orphaned InProgress item" on a failed dev_sessions read (B3);
 * 29, 89, 6 (two projects) and 56 show the task's "merge committed to main" with the startup
 * reconciler then requeuing it, 56 after "merge record ... giving up" (B5). B3 and B5 are not fixed.
 */
const TWO_PROJECT_FAILURES: ReadonlyArray<Omit<ExpectedFailure, "projects" | "capUsd">> = [
  { seed: 6, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 56, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 78, keys: ["I7:p2:unrecorded:Set up the product's layout"], baseline: B5 },
  { seed: 82, keys: ["I7:p2:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 59, keys: ["I7:orphan:Define and commit the project environment:6"], baseline: B3 },
];
/** Two projects at $10 only (`--projects 2 --cap 10`). */
const TWO_PROJECT_CAP_FAILURES: ReadonlyArray<Omit<ExpectedFailure, "projects" | "capUsd">> = [
];
const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  // Seed 6 (hostile) re-rolled on t-adversarial-models and again on t-ddd-r1-contract-out: B3, the
  // log names "failed to requeue crash-orphaned InProgress item" on a failed dev_sessions read.
  { seed: 6, keys: ["I7:orphan:Set up the product's layout:2"], baseline: B3 },
  { seed: 29, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  { seed: 56, keys: ["I7:unrecorded:Define and commit the project environment"], baseline: B5 },
  // Seed 45 (B5, the crash on a host git call inside the merge, baseline §7.10) is removed on
  // t-merge-conflict-rebase: `simulate.ts --seeds 30 --start 31` reported it listed but not failed;
  // B5 is not fixed. Seed 89 fails B5's key since master 02d1e6e5 (`simulate.ts --seeds 120 --start 1`).
  // Seeds 7 and 43 are removed at the merge above (listed but not failed); B5 is not fixed.
  { seed: 89, keys: ["I7:unrecorded:Set up the product's layout"], baseline: B5 },
  ...[...TWO_PROJECT_FAILURES, ...TWO_PROJECT_CAP_FAILURES].map((entry) => ({ ...entry, projects: 2, capUsd: 10 }) as const),
  ...TWO_PROJECT_FAILURES.map((entry) => ({ ...entry, projects: 2 }) as const),
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
