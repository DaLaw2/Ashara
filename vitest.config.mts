import { defineConfig } from "vitest/config";
import {
  PODMAN_HOOK_TIMEOUT_MS,
  PODMAN_MAX_WORKERS,
  PODMAN_TEST_FILES,
  PODMAN_TEST_TIMEOUT_MS,
} from "./packages/integration/src/podman-test-load.js";
import { useTestPodmanStore } from "./packages/integration/src/test-podman-store.js";
import { defaultTestWorkers, WHOLE_TREE_ENV, WHOLE_TREE_PROJECT, WHOLE_TREE_TEST } from "./packages/integration/src/test-run-load.js";
import { WholeTreeFirstSequencer } from "./packages/integration/src/test-sequencer.js";

// Before any globalSetup or worker starts, so the guards, every test and every podman they start use
// one store: the test store on a host with /data, podman's default store otherwise.
useTestPodmanStore();

// What every project runs under. A project that extended the root config would also run the root's
// globalSetup a second time; vitest runs the root's once and every project inherits what it provides.
const shared = {
  // Every PodmanSubstrate runs its cells and builds under required caps (ASHARA_CELL_*); a
  // test's cells run under these unless it passes its own.
  env: { ASHARA_CELL_MEMORY: "2g", ASHARA_CELL_CPUS: "2", ASHARA_CELL_PIDS_LIMIT: "512" },
};
// A TS program over the whole checkout is built by the whole-tree project's one file, once for the
// run; every other project refuses to build one (module-program.ts).
const refusesWholeTree = { env: { ...shared.env, [WHOLE_TREE_ENV]: "refused" } };

export default defineConfig({
  test: {
    // Owner rule: no unbounded resource use. Test files share one Postgres and the host's podman, so
    // the worker count is bounded (test-run-load.ts), or the run's --maxWorkers. The podman project
    // sets a bound of its own, which neither replaces.
    maxWorkers: defaultTestWorkers(),
    // The image guard runs first: a pinned test image absent from local podman storage stops the run
    // before any test, naming each such image and its pull command; the run never pulls one itself.
    // The scratch-root guard runs next: it points TMPDIR at the scratch root (scripts/scratch-root.ts),
    // or stops the run when that root is absent or full, so no test writes its temporary files to the disk.
    // The store guard is next: on a host with /data, a podman store other than the test store stops
    // the run. The test database is migrated next, or the run stops naming `just test-db-up`, so a
    // direct `npx vitest` after a fresh test Postgres works as `just test` does.
    // Every test cell's instance names this run (testCellInstance); the run fails if any of them
    // outlives it, after they are removed, and removes the cells of runs that died before their end.
    globalSetup: [
      "packages/integration/src/test-images-guard.ts",
      "scripts/scratch-root-guard.ts",
      "packages/integration/src/test-podman-store-guard.ts",
      "packages/integration/src/test-database-setup.ts",
      "packages/integration/src/cell-leak-guard.ts",
    ],
    // The guard's end-of-run check spends at most 0.8 of this on podman: one listing and one removal
    // at worst, each bounded by its podman timeout (cell-leak-guard.ts), so it ends before vitest
    // gives up on the teardown.
    teardownTimeout: 150_000,
    // vitest runs projects of different sequence.groupOrder one after the other, each under its own
    // worker bound, and shards the files of all projects together: the podman files run after the
    // rest, PODMAN_MAX_WORKERS at once. The whole-tree project runs beside the default one, on the
    // same workers, and its file starts first (test-sequencer.ts).
    sequence: { sequencer: WholeTreeFirstSequencer },
    projects: [
      {
        test: {
          ...refusesWholeTree,
          name: "default",
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...PODMAN_TEST_FILES, WHOLE_TREE_TEST],
          testTimeout: 120_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: WHOLE_TREE_PROJECT,
          include: [WHOLE_TREE_TEST],
          testTimeout: 120_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...refusesWholeTree,
          name: "podman",
          include: [...PODMAN_TEST_FILES],
          maxWorkers: PODMAN_MAX_WORKERS,
          testTimeout: PODMAN_TEST_TIMEOUT_MS,
          hookTimeout: PODMAN_HOOK_TIMEOUT_MS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
