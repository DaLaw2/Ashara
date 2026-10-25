import { availableParallelism } from "node:os";

// The load a test run puts on the host beside the podman project's (podman-test-load.ts): the
// workers its files run on, and the one test file that builds a TS program over the whole checkout.

/** Test files share one Postgres and the host's podman, so a run's workers are bounded. */
const MAX_TEST_WORKERS = 4;

/**
 * The workers a run gets when it names none: the host's cores, at most MAX_TEST_WORKERS.
 * @testseam vitest.config.mts sets it as the run's maxWorkers, which scripts/test-run.ts reads back from vitest
 */
export function defaultTestWorkers(): number {
  return Math.min(MAX_TEST_WORKERS, availableParallelism());
}

/**
 * The variable under which a TS program over every source of this checkout is refused
 * (scripts/module-program.ts): every vitest project but the whole-tree one sets it to "refused".
 */
export const WHOLE_TREE_ENV = "ASHARA_WHOLE_TREE_PROGRAM";

/**
 * The one test file whose project leaves WHOLE_TREE_ENV unset: every test that reads the whole
 * checkout's program is in it, so a run builds that program once.
 */
export const WHOLE_TREE_TEST = "scripts/boundary-probes.test.ts";

/** The vitest project that runs WHOLE_TREE_TEST alone. */
export const WHOLE_TREE_PROJECT = "whole-tree";
