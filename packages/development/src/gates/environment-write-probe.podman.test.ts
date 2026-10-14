import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { probeEnvironmentWrite } from "./environment-write-probe.js";

// Roadmap M2 exit 6, the third probe (ADR-074 d82 W9): real podman, real git, no skip.

/** pinned like the BaseCell; .github/workflows/ci.yml pulls it by this reference. */
const ALPINE_IMAGE = "docker.io/library/alpine:3.20@sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e";

let mountRoot = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-env-write-probe-")));
  substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot, limits: { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pids: 64 } });
});

afterAll(async () => {
  await substrate.teardownAll();
  await rm(mountRoot, { recursive: true, force: true });
}, 60_000);

describe("environment-file write without the grant", () => {
  it("lands in the cell's tree, and the ownership gate keeps it from main", async () => {
    const verdict = await probeEnvironmentWrite({ substrate, image: ALPINE_IMAGE, instance: `test-${randomUUID()}`, workRoot: mountRoot });

    expect(verdict.evidence).toMatch(/^the in-cell write exited 0; the ownership gate returned environment_change \(/);
    expect(verdict.evidence).toContain("main's environment/Containerfile is unchanged");
    expect(verdict.held).toBe(true);
  });
});
