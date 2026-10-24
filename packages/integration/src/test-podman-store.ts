import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Every podman test starts short-lived containers, and each one writes a container layer, a copy of
// its image's files owned by the cell's user namespace, and rows of podman's container database,
// fsynced, into the store podman uses. On a host with an HDD at /data, test runs keep all of that in
// memory and off every disk: config/podman-test-storage.conf puts graphroot on a tmpfs and the
// container database in runroot (transient_store), and reads the pinned images read-only from the
// image store on /data that config/podman-test-images.conf describes and `just test-images` fills.
// Production code never calls this; the server's podman uses the operator's own store. The test
// runner's config loads this file outside its module transform, so it imports node built-ins only.

/** Where the HDD is mounted on a host that has one; the test image store lies under it. */
export const HDD_ROOT = "/data";

/** Module-anchored, so the cwd of a run cannot change which file podman reads. */
export const TEST_STORAGE_CONF = fileURLToPath(new URL("../../../config/podman-test-storage.conf", import.meta.url));

/**
 * The store `just test-images` pulls into, and the one test runs read their images from.
 * @testseam test-podman-store.test.ts checks the run store reads its graphroot
 */
export const TEST_IMAGES_CONF = fileURLToPath(new URL("../../../config/podman-test-images.conf", import.meta.url));

/**
 * Points every podman this process and its children start at the test run store, on a host with
 * /data; podman's default store otherwise. The test runner's config calls it, so every test run does,
 * however it is started.
 * @testseam vitest.config.mts calls it, a reference knip does not read
 */
export function useTestPodmanStore(): void {
  if (existsSync(HDD_ROOT)) process.env.CONTAINERS_STORAGE_CONF = TEST_STORAGE_CONF;
}

/** As useTestPodmanStore, for the store the pinned test images are pulled into. */
export function useTestImageStore(): void {
  if (existsSync(HDD_ROOT)) process.env.CONTAINERS_STORAGE_CONF = TEST_IMAGES_CONF;
}
