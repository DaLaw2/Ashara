import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadBaseCell } from "./base-cell.js";
import { createCellBackend } from "./cell-backend.js";
import { BaseCellConfigInvalid, SubstrateUnavailable } from "./errors.js";
import { PodmanSubstrate } from "./podman.js";

// Real podman, no skip: CI rejects skipped tests, and a substrate test that skips when podman is
// absent reports the same green as one that ran.
const run = promisify(execFile);
const psSchema = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()).nullable().optional() }));

async function ps(filter: string): Promise<z.infer<typeof psSchema>> {
  const { stdout } = await run("podman", ["ps", "-a", "--filter", filter, "--format", "json"]);
  return psSchema.parse(JSON.parse(stdout));
}

const instance = `test-${randomUUID()}`;
const task = `task-${randomUUID()}`;
const strayIds: string[] = [];
let workspace = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  process.env.ASHARA_PROBE_SECRET = "probe-secret-must-not-reach-the-cell";
  workspace = await mkdtemp(join(tmpdir(), "ashara-cell-"));
  substrate = new PodmanSubstrate({ podmanPath: "podman" });
}, 60_000);

afterAll(async () => {
  delete process.env.ASHARA_PROBE_SECRET;
  await substrate.teardownAll();
  if (strayIds.length > 0) await run("podman", ["rm", "-f", "-t", "0", ...strayIds]);
  await rm(workspace, { recursive: true, force: true });
}, 60_000);

describe("cell on real podman", () => {
  it("reports a missing podman binary as SubstrateUnavailable", async () => {
    const missing = new PodmanSubstrate({ podmanPath: join(workspace, "no-such-podman") });
    await expect(missing.probeSubstrate()).rejects.toBeInstanceOf(SubstrateUnavailable);
  });

  it("fails closed on a missing BaseCell file and on a reference without a digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-base-cell-"));
    try {
      await expect(loadBaseCell(join(dir, "absent.toml"))).rejects.toBeInstanceOf(BaseCellConfigInvalid);
      const tagOnly = join(dir, "base-cell.toml");
      await writeFile(tagOnly, 'image = "docker.io/library/debian:12-slim"\n');
      await expect(loadBaseCell(tagOnly)).rejects.toBeInstanceOf(BaseCellConfigInvalid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs every tool inside a labelled, network-less, env-free cell and tears it down", async () => {
    const info = await substrate.probeSubstrate();
    expect(info.version).not.toBe("");

    const base = await loadBaseCell();
    const cell = await substrate.createCell({
      image: base.image,
      project: "proj-cell-test",
      task,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    const backend = createCellBackend(cell, { toolTimeoutSeconds: 30 });

    await backend.writeFile("src/notes.txt", "alpha\nneedle here\n");
    expect(await readFile(join(workspace, "src", "notes.txt"), "utf8")).toBe("alpha\nneedle here\n");
    expect(await backend.readFile("src/notes.txt")).toEqual({ text: "alpha\nneedle here\n", truncated: false });
    expect((await backend.listDirectory(".", 2)).entries).toEqual(["src/", "src/notes.txt"]);
    expect((await backend.search("need+le", ".")).text.trim()).toBe("src/notes.txt:2:needle here");

    const ran = await backend.run("echo hi; echo err >&2; exit 3", 30);
    expect(ran).toMatchObject({ exitCode: 3, stdout: "hi\n", stderr: "err\n", timedOut: false });

    const slow = await backend.run("sleep 30", 1);
    expect(slow.timedOut).toBe(true);

    const [labelled, ...more] = await ps(`label=ashara.task=${task}`);
    expect(more).toHaveLength(0);
    expect(labelled?.Id).toBe(cell.id);
    expect(labelled?.Labels).toMatchObject({
      "ashara.managed": "1",
      "ashara.instance": instance,
      "ashara.project": "proj-cell-test",
      "ashara.task": task,
      "ashara.role": "worker",
    });

    const env = await cell.exec(["env"], { timeoutSeconds: 10 });
    expect(env.exitCode).toBe(0);
    expect(env.stdout).not.toContain("ASHARA_PROBE_SECRET");
    expect(env.stdout).not.toContain("probe-secret-must-not-reach-the-cell");
    expect(env.stdout).not.toMatch(/^(DATABASE_URL|ASHARA_[A-Z_]*|[A-Z_]*API_KEY)=/m);

    const interfaces = await cell.exec(["ls", "/sys/class/net"], { timeoutSeconds: 10 });
    expect(interfaces.stdout.split("\n").filter((l) => l !== "")).toEqual(["lo"]);
    const dns = await cell.exec(["getent", "hosts", "example.com"], { timeoutSeconds: 10 });
    expect(dns.exitCode).not.toBe(0);

    await cell.teardown();
    expect(await ps(`label=ashara.task=${task}`)).toHaveLength(0);
  });

  it("reconciles a leaked cell of this instance and leaves every other container alone", async () => {
    const base = await loadBaseCell();
    // A previous process of this instance that died without tearing down.
    const previous = new PodmanSubstrate({ podmanPath: "podman" });
    const leaked = await previous.createCell({
      image: base.image,
      project: "proj-cell-test",
      task: `${task}-leaked`,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    strayIds.push(leaked.id);

    const unlabelled = (await run("podman", ["run", "-d", "--pull=never", "--network=none", base.image, "sleep", "infinity"])).stdout.trim();
    strayIds.push(unlabelled);
    const otherInstance = (
      await run("podman", [
        "run", "-d", "--pull=never", "--network=none",
        "--label", "ashara.managed=1", "--label", `ashara.instance=${instance}-other`,
        base.image, "sleep", "infinity",
      ])
    ).stdout.trim();
    strayIds.push(otherInstance);

    expect(await substrate.reconcileOrphans(instance)).toEqual([leaked.id]);
    expect(await ps(`id=${leaked.id}`)).toHaveLength(0);
    expect(await ps(`id=${unlabelled}`)).toHaveLength(1);
    expect(await ps(`id=${otherInstance}`)).toHaveLength(1);
    strayIds.splice(strayIds.indexOf(leaked.id), 1);
  });
});
