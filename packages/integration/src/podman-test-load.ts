// The load the podman tests put on the host, and how long they may take under it. A podman call
// slows down host-wide as more podman work runs beside it, so the files that drive the real
// substrate run in a project of their own, a bounded number at once and after the rest of the suite
// rather than beside it. Every timeout here is TIMEOUT_MULTIPLE times a p95 measured under the full
// suite's own command and caps: a loaded host stretches a call toward its timeout, a hang still fails.
// A bound anchored on the slowest member of its class covers every faster member, whose own p95
// varies more between runs than the slowest one's.

/**
 * The test files that start real podman work: every *.podman.test.ts and every test that constructs
 * a PodmanSubstrate on the podman binary.
 * @testseam vitest.config.ts includes them in the podman project; podman-test-load.test.ts checks the tree against it
 */
export const PODMAN_TEST_FILES = [
  "packages/*/src/**/*.podman.test.ts",
  "packages/integration/src/delivery/dispatch-service.test.ts",
  "packages/integration/src/server/dispatch-loops-ledger.test.ts",
  "packages/integration/src/server/environment-build.test.ts",
  "packages/integration/src/server/environment-change-loop.test.ts",
  "packages/integration/src/server/isolated-execution.test.ts",
  "packages/integration/src/server/merge-conflict-retry.test.ts",
  "packages/integration/src/server/spend-cap-loop.test.ts",
  "packages/integration/src/server/sprint0-execution.test.ts",
  "packages/integration/src/server/task-checks-execution.test.ts",
  "packages/integration/src/server/work-budget-loop.test.ts",
  "packages/integration/src/server/workspace-path-block.test.ts",
] as const;

/**
 * Podman test files that run at once, whatever --maxWorkers the run is given; the p95s below were
 * measured with this bound.
 * @testseam vitest.config.ts sets it on the podman project
 */
export const PODMAN_MAX_WORKERS = 4;

/**
 * Every timeout below is this many times its measured p95.
 * @testseam podman-test-load.test.ts checks every timeout against it
 */
export const TIMEOUT_MULTIPLE = 4;

/**
 * Nearest-rank p95 durations, in ms, measured under the full suite with the podman project bounded as above.
 * @testseam podman-test-load.test.ts checks every timeout against it
 */
export const MEASURED_P95_MS = {
  /** The slowest podman project test's p95. */
  slowestTest: 151_951,
  /** The slowest podman project hook's p95 (beforeAll, afterAll, beforeEach, afterEach). */
  slowestHook: 8_701,
  /**
   * The slower of the guards' two podman calls: `podman ps -a --filter label=ashara.instance
   * --format json` (the cell-leak guard's listing), slower than `podman image exists <image>` (the
   * test-images guard's check).
   */
  slowestGuardCall: 7_085,
} as const;

/**
 * A podman project test's timeout.
 * @testseam vitest.config.ts sets it on the podman project
 */
export const PODMAN_TEST_TIMEOUT_MS = TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestTest;
/**
 * A podman project hook's timeout.
 * @testseam vitest.config.ts sets it on the podman project
 */
export const PODMAN_HOOK_TIMEOUT_MS = TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestHook;
/** Each podman call of the cell-leak guard and of the test-images guard. */
export const GUARD_PODMAN_TIMEOUT_MS = TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestGuardCall;

/** Whether a child process failed because node killed it at its timeout (execFile) or gave up on it (execFileSync). */
export function killedAtTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return ("killed" in err && err.killed === true) || ("code" in err && err.code === "ETIMEDOUT");
}

/** What a guard's podman call that ran past its bound says: the call, the time it was given and where its bound comes from. */
export function podmanTimeoutDetail(call: string, timeoutMs: number): string {
  return (
    `\`${call}\` was killed after ${timeoutMs} ms without finishing; a guard's podman call is bounded at ` +
    `${GUARD_PODMAN_TIMEOUT_MS} ms, ${TIMEOUT_MULTIPLE} times the p95 of the slowest one measured under the full suite ` +
    `(${MEASURED_P95_MS.slowestGuardCall} ms), so podman on this host is slower now than it was measured`
  );
}
