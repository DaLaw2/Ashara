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
  },
});
