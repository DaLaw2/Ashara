import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import { describeErrorChain, parseJson } from "@ashara/shared";
import { GUARD_PODMAN_TIMEOUT_MS, killedAtTimeout, podmanTimeoutDetail } from "./podman-test-load.js";
import { HDD_ROOT, TEST_STORAGE_CONF } from "./test-podman-store.js";

// vitest's globalSetup, after the image guard: on a host with /data, a run whose podman store is not
// the test store stops before any test, since every container it started would write to a disk.

const podmanStoreSchema = z.object({
  store: z.object({
    graphRoot: z.string().min(1),
    graphStatus: z.object({ "Backing Filesystem": z.string().min(1) }),
    transientStore: z.boolean(),
  }),
});

type PodmanStore = z.output<typeof podmanStoreSchema>["store"];

/** The filesystem the test store's graphroot is on: memory, so container churn writes no disk. */
const MEMORY_FILESYSTEM = "tmpfs";

/**
 * Why `store` is not the test store on a host where `hddPresent`, or null when it is.
 * @testseam test-podman-store.test.ts checks each verdict; checkTestPodmanStore reads it
 */
export function misplacedStore(store: PodmanStore, hddPresent: boolean): string | null {
  if (!hddPresent) return null;
  const problems: string[] = [];
  const backing = store.graphStatus["Backing Filesystem"];
  if (backing !== MEMORY_FILESYSTEM) problems.push(`its graphroot ${store.graphRoot} is on ${backing}, not ${MEMORY_FILESYSTEM}`);
  if (!store.transientStore) problems.push("its container database is not transient (transient_store is false)");
  return problems.length === 0 ? null : problems.join("; ");
}

/** The run's podman store is not the test store, so its containers would write to the system disk. */
class TestPodmanStoreMisplaced extends Error {
  constructor(
    readonly graphRoot: string,
    readonly detail: string,
  ) {
    super(
      `the podman store this test run uses is not the test store although ${HDD_ROOT} exists: ${detail}. ` +
        `A run sets CONTAINERS_STORAGE_CONF=${TEST_STORAGE_CONF} through useTestPodmanStore, which the test runner's config calls; ` +
        `CONTAINERS_STORAGE_CONF is now ${process.env.CONTAINERS_STORAGE_CONF ?? "unset"}`,
    );
    this.name = "TestPodmanStoreMisplaced";
  }
}

/** podman could not say which store it uses; that is no evidence it is the test store. */
class TestPodmanStoreUnknown extends Error {
  constructor(
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`test podman store: \`podman info --format json\` failed, so the store this run uses is unknown: ${detail}`, options);
    this.name = "TestPodmanStoreUnknown";
  }
}

const run = promisify(execFile);

/** Throws TestPodmanStoreMisplaced when this run's podman store is not the test store on a host with /data. */
async function checkTestPodmanStore(): Promise<void> {
  if (!existsSync(HDD_ROOT)) return;
  let stdout: string;
  try {
    ({ stdout } = await run("podman", ["info", "--format", "json"], { timeout: GUARD_PODMAN_TIMEOUT_MS }));
  } catch (err) {
    const detail = killedAtTimeout(err) ? podmanTimeoutDetail("podman info --format json", GUARD_PODMAN_TIMEOUT_MS) : describeErrorChain(err);
    throw new TestPodmanStoreUnknown(detail, { cause: err });
  }
  let store: PodmanStore;
  try {
    store = parseJson(podmanStoreSchema, stdout, "podman info --format json").store;
  } catch (err) {
    throw new TestPodmanStoreUnknown(describeErrorChain(err), { cause: err });
  }
  const detail = misplacedStore(store, true);
  if (detail !== null) throw new TestPodmanStoreMisplaced(store.graphRoot, detail);
}

/** @testseam vitest.config.mts names this file as globalSetup, a reference knip does not read */
export default async function setup(): Promise<void> {
  await checkTestPodmanStore();
}
