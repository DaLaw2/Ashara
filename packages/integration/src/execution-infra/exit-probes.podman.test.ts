import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PodmanSubstrate,
  WORKSPACE_ROOT,
  probeCredentialRead,
  probeOutboundHost,
  probeResourceCaps,
  type Cell,
} from "@ashara/execution-infra";
import { testCellInstance } from "../test-cells.js";
import { TEST_IMAGES } from "../test-images.js";

// The cell's isolation probes, from inside a real cell on real podman, no skip. The
// environment-file write probe needs the ownership gate and lives in packages/quality.

/** A busybox image with wget, pinned like the BaseCell. */
const ALPINE_IMAGE = TEST_IMAGES.alpine;
const LIMITS = { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pids: 64 };
const SECRET_VALUE = `ashara-probe-credential-${randomUUID()}`;

let mountRoot = "";
let keyDir = "";
let substrate: PodmanSubstrate;
let cell: Cell;

beforeAll(async () => {
  mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-probe-root-")));
  keyDir = await mkdtemp(join(tmpdir(), "ashara-probe-key-"));
  await writeFile(join(keyDir, "secret.key"), `${SECRET_VALUE}\n`, { mode: 0o600 });
  process.env.ASHARA_PROBE_DATABASE_URL = `postgresql://ashara:${SECRET_VALUE}@localhost:5432/ashara`;
  const tree = await mkdtemp(join(mountRoot, "tree-"));
  // The negative control: a credential the cell can read, because it is in its own tree.
  await writeFile(join(tree, "planted.txt"), `${SECRET_VALUE}\n`);
  substrate = new PodmanSubstrate({ trace: () => "test-trace", podmanPath: "podman", mountRoot, limits: LIMITS });
  cell = await substrate.createCell({
    image: ALPINE_IMAGE,
    project: "proj-exit-probes",
    task: `task-${randomUUID()}`,
    role: "worker",
    instance: testCellInstance(),
    mount: { hostPath: tree },
  });
}, 120_000);

afterAll(async () => {
  delete process.env.ASHARA_PROBE_DATABASE_URL;
  await substrate.teardownAll();
  await rm(mountRoot, { recursive: true, force: true });
  await rm(keyDir, { recursive: true, force: true });
}, 120_000);

describe("exit 6 probes from inside a real cell", () => {
  it("the cell's cgroup holds the configured memory, swap, CPU and pids caps; other caps do not match", async () => {
    const caps = await probeResourceCaps(cell, LIMITS);
    expect(caps.evidence).toBe("memory.max=268435456, memory.swap.max=0, cpu.max=50000 100000, pids.max=64");
    expect(caps.outcome).toBe("held");
    expect((await probeResourceCaps(cell, { ...LIMITS, pids: 65 })).outcome).toBe("breached");
  });

  it("the pids cap stops a fork past it", async () => {
    const result = await cell.exec(["sh", "-c", "i=0; while [ $i -lt 80 ]; do sleep 5 & i=$((i + 1)); done; wait"], { timeoutSeconds: 30 });
    expect(result.stderr).toMatch(/can't fork|Resource temporarily unavailable/);
  });

  it("a credential read is denied: the key file is absent at its host path, and no Z0 value is in any environment", async () => {
    const canaries = {
      paths: [join(keyDir, "secret.key")],
      values: [
        { name: "the secret key file", value: SECRET_VALUE },
        { name: "DATABASE_URL", value: process.env.ASHARA_PROBE_DATABASE_URL ?? "" },
      ],
    };
    const denied = await probeCredentialRead(cell, canaries);
    expect(denied.evidence).toContain(`path ${join(keyDir, "secret.key")} absent`);
    expect(denied.evidence).toContain("none found");
    expect(denied.outcome).toBe("held");

    // A value inside a probed path (npx's INIT_CWD inside `<cwd>/.env`) is not the probe's own leak.
    const pathPrefix = await probeCredentialRead(cell, { ...canaries, values: [...canaries.values, { name: "INIT_CWD", value: keyDir }] });
    expect(pathPrefix.evidence).toContain("none found");
    expect(pathPrefix.outcome).toBe("held");

    const control = await probeCredentialRead(cell, { ...canaries, paths: [`${WORKSPACE_ROOT}/planted.txt`] });
    expect(control.outcome).toBe("breached");
    expect(control.evidence).toContain("found: the secret key file");
  });

  it("an outbound host is unreachable: loopback only, no route, and busybox's nc and wget both fail to connect", async () => {
    const outbound = await probeOutboundHost(cell, "1.1.1.1");
    expect(outbound.evidence).toMatch(/^interfaces \[lo\]; routes: 0; connect: nc exit [1-9][0-9]*.*, wget exit [1-9][0-9]*/);
    expect(outbound.outcome).toBe("held");
  });
});
