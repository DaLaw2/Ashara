import { profileOfSeed } from "./profile.js";
import type { Profile } from "./profile.js";
import type { RunMode, RunResult } from "./run.js";

/**
 * The seeds that fail on today's code, each with the violation keys it fails (the
 * invariant and its subject, invariants.ts Violation.key) and the baseline entry naming the
 * defect. A seed here must fail exactly
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
  /**
   * The run mode the seed fails in (RunOptions.projects, RunOptions.capUsd); one project and the tape's cap when
   * absent.
   */
  readonly projects?: 1 | 2;
  readonly capUsd?: number;
  readonly keys: readonly string[];
  readonly baseline: string;
}

/*
 * The soak's known production failures. An entry keeps `just simulate` from counting its seed as
 * unexpected until the defect is fixed; a fix shows the entry as listed-but-not-failed, and the
 * entry is then removed. A change that adds a seam call on a seed's path re-rolls that seed, so the
 * list is re-derived from a soak whenever such a change lands; the directed tier forces each
 * defect on a directed tape instead of pinning a seed.
 */
const EXPECTED_FAILURES: readonly ExpectedFailure[] = [];

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

/**
 * How a seed's violations differ from its entry: keys it failed and is not listed for, and listed keys it no longer
 * fails.
 */
interface ExpectedFailureDiff {
  readonly unexpected: readonly string[];
  readonly missing: readonly string[];
}

export function diffExpected(
  run: Pick<RunResult, "seed" | "profile" | "violations">,
  mode: RunMode,
): ExpectedFailureDiff {
  /* eslint-disable-next-line no-restricted-syntax -- policy default: a seed with no entry expects no failure, so
     every violation it has is unexpected */
  const listed = new Set(entryOf(run, mode)?.keys ?? []);
  const failed = new Set(run.violations.map((violation) => violation.key));
  return {
    unexpected: [...failed].filter((key) => !listed.has(key)).sort(),
    missing: [...listed].filter((key) => !failed.has(key)).sort(),
  };
}
