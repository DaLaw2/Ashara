import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { misplacedStore } from "./test-podman-store-guard.js";
import { TEST_IMAGES_CONF, TEST_STORAGE_CONF } from "./test-podman-store.js";

/** The value of `key` in a storage.conf, as written: a quoted string, a boolean or an array. */
function confValue(file: string, key: string): string | undefined {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(`${key} =`));
  return line?.split("=").slice(1).join("=").trim();
}

const HOME_STORE = "/home/dev/.local/share/containers/storage";

describe("the test podman stores", () => {
  it("run containers in memory with a transient container database, reading images from the image store on /data", () => {
    expect(confValue(TEST_STORAGE_CONF, "graphroot")).toMatch(/^"\/dev\/shm\/[^"]+"$/);
    expect(confValue(TEST_STORAGE_CONF, "runroot")).toMatch(/^"\/run\/user\/\$UID\/[^"]+"$/);
    expect(confValue(TEST_STORAGE_CONF, "transient_store")).toBe("true");
    const imageStore = confValue(TEST_IMAGES_CONF, "graphroot");
    expect(imageStore).toMatch(/^"\/data\/[^"]+"$/);
    expect(confValue(TEST_STORAGE_CONF, "additionalimagestores")).toBe(`[${imageStore ?? ""}]`);
    // Two stores never share a runroot.
    expect(confValue(TEST_IMAGES_CONF, "runroot")).not.toBe(confValue(TEST_STORAGE_CONF, "runroot"));
  });

  it("is required on a host with /data: podman's default store on a disk is refused", () => {
    expect(misplacedStore({ graphRoot: HOME_STORE, graphStatus: { "Backing Filesystem": "xfs" }, transientStore: false }, true)).toMatch(
      /graphroot \/home\/dev\/\.local\/share\/containers\/storage is on xfs, not tmpfs.*not transient/,
    );
  });

  it("refuses a store in memory whose container database is persistent", () => {
    expect(misplacedStore({ graphRoot: "/dev/shm/t/storage", graphStatus: { "Backing Filesystem": "tmpfs" }, transientStore: false }, true)).toMatch(
      /not transient/,
    );
  });

  it("accepts the test store on a host with /data", () => {
    expect(misplacedStore({ graphRoot: "/dev/shm/t/storage", graphStatus: { "Backing Filesystem": "tmpfs" }, transientStore: true }, true)).toBeNull();
  });

  it("asks nothing of a host without /data, which runs on podman's default store", () => {
    expect(misplacedStore({ graphRoot: HOME_STORE, graphStatus: { "Backing Filesystem": "xfs" }, transientStore: false }, false)).toBeNull();
  });
});

describe("the test stores' wiring", () => {
  // Every runner reaches the store through vitest.config.mts: `just test`, `just test-affected`
  // (scripts/affected-tests.ts spawns vitest on it) and a direct `npx vitest`.
  it("vitest.config.mts selects the test store before any globalSetup and names the store guard among them", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../vitest.config.mts", import.meta.url)), "utf8");
    expect(config).toMatch(/^useTestPodmanStore\(\);$/m);
    const list = /^\s*globalSetup:\s*\[([^\]]*)\]/m.exec(config)?.[1];
    expect(list).toContain('"packages/integration/src/test-podman-store-guard.ts"');
  });

  it("`just test-images` pulls into the test image store", () => {
    const pull = readFileSync(fileURLToPath(new URL("./test-images-pull.ts", import.meta.url)), "utf8");
    expect(pull).toMatch(/^ {2}useTestImageStore\(\);$/m);
  });
});
