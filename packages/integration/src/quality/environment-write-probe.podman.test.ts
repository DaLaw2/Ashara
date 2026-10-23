import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeEnvironmentWrite } from "@ashara/quality";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { recordingLogger } from "@ashara/shared/testing";
import { testCellInstance } from "../test-cells.js";
import { TEST_IMAGES } from "../test-images.js";

// The environment-file write probe: real podman, real git, no skip.

/** A busybox image, pinned like the BaseCell. */
const ALPINE_IMAGE = TEST_IMAGES.alpine;

let mountRoot = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-env-write-probe-")));
  substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot, limits: { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pids: 64 } });
});

afterAll(async () => {
  await substrate.teardownAll();
  await rm(mountRoot, { recursive: true, force: true });
});

describe("environment-file write without the grant", () => {
  it("lands in the cell's tree, and the ownership gate keeps it from main", async () => {
    const verdict = await probeEnvironmentWrite({ substrate, image: ALPINE_IMAGE, instance: testCellInstance(), workRoot: mountRoot, signal: new AbortController().signal });

    expect(verdict.evidence).toMatch(/^the in-cell write exited 0; the ownership gate returned environment_change \(/);
    expect(verdict.evidence).toContain("the probe runs no merge, so this verdict is all it observed");
    expect(verdict.outcome).toBe("held");
  });
});
