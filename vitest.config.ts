import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Owner rule: no unbounded resource use. Test files share one Postgres and the host's podman, so
// the worker count is bounded: the host's cores, at most 4.
const MAX_TEST_WORKERS = 4;

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 120_000,
    maxWorkers: Math.min(MAX_TEST_WORKERS, availableParallelism()),
    // Every test cell's instance names this run (testCellInstance); the run fails if any of them
    // outlives it, after they are removed, and removes the cells of runs that died before their end.
    globalSetup: ["packages/integration/src/cell-leak-guard.ts"],
    // The guard's end-of-run check spends at most 0.8 of this on podman: one listing and one removal
    // of 60 s each at worst (cell-leak-guard.ts), so it ends before vitest gives up on the teardown.
    teardownTimeout: 150_000,
    // Every PodmanSubstrate runs its cells and builds under required caps (ASHARA_CELL_*, W9); a
    // test's cells run under these unless it passes its own.
    env: { ASHARA_CELL_MEMORY: "2g", ASHARA_CELL_CPUS: "2", ASHARA_CELL_PIDS_LIMIT: "512" },
  },
});
