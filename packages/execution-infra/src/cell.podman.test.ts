import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadBaseCell } from "./base-cell.js";
import { createCellBackend } from "./cell-backend.js";
import { BaseCellConfigInvalid, CellExecFailed, SubstrateUnavailable } from "./errors.js";
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
let mountRoot = "";
let workspace = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  process.env.ASHARA_PROBE_SECRET = "probe-secret-must-not-reach-the-cell";
  mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-cell-root-")));
  workspace = await mkdtemp(join(mountRoot, "ws-"));
  substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot });
}, 60_000);

afterAll(async () => {
  delete process.env.ASHARA_PROBE_SECRET;
  await substrate.teardownAll();
  if (strayIds.length > 0) await run("podman", ["rm", "-f", "-t", "0", ...strayIds]);
  await rm(mountRoot, { recursive: true, force: true });
}, 60_000);

describe("cell on real podman", () => {
  it("reports a missing podman binary as SubstrateUnavailable", async () => {
    const missing = new PodmanSubstrate({ podmanPath: join(workspace, "no-such-podman"), mountRoot });
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

  // sprint0-run-2026-10-14 D13: a worktree's gitlink names its git dir's host path.
  it("a masked gitlink is empty and unwritable in the cell; the host path it names is not readable there", async () => {
    const tree = await mkdtemp(join(mountRoot, "masked-"));
    const hostGitDir = join(mountRoot, "projects", "p", ".git", "worktrees", "task-x");
    await writeFile(join(tree, ".git"), `gitdir: ${hostGitDir}\n`);
    const base = await loadBaseCell();
    const cell = await substrate.createCell({
      image: base.image,
      project: "proj-cell-test",
      task: `${task}-mask`,
      role: "verifier",
      instance,
      mount: { hostPath: tree, shared: true, maskedEntries: [".git"] },
    });
    try {
      const read = await cell.exec(["cat", ".git"], { timeoutSeconds: 10 });
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toBe("");
      const search = await cell.exec(["sh", "-c", `grep -rs -- '${mountRoot}' /workspace; echo "exit $?"`], { timeoutSeconds: 10 });
      expect(search.stdout).toBe("exit 1\n");
      const rewrite = await cell.exec(["sh", "-c", "echo 'gitdir: planted' > .git"], { timeoutSeconds: 10 });
      expect(rewrite.exitCode).not.toBe(0);
      const replace = await cell.exec(["sh", "-c", "rm -f .git"], { timeoutSeconds: 10 });
      expect(replace.exitCode).not.toBe(0);
      const work = await cell.exec(["sh", "-c", "echo ok > work.txt"], { timeoutSeconds: 10 });
      expect(work.exitCode).toBe(0);
    } finally {
      await cell.teardown();
    }
    // The host's gitlink is untouched: Z0's git still finds its git dir through it.
    expect(await readFile(join(tree, ".git"), "utf8")).toBe(`gitdir: ${hostGitDir}\n`);
    expect(await readFile(join(tree, "work.txt"), "utf8")).toBe("ok\n");
  });

  it("a command's own exit 125 is its result; a cell removed under a running exec is CellExecFailed", async () => {
    const base = await loadBaseCell();
    const cell = await substrate.createCell({
      image: base.image,
      project: "proj-cell-test",
      task: `${task}-exit`,
      role: "ci",
      instance,
      mount: { hostPath: workspace },
    });
    try {
      const check = await cell.exec(["sh", "-c", "echo checked; echo why >&2; exit 125"], { timeoutSeconds: 10 });
      expect(check).toMatchObject({ exitCode: 125, stdout: "checked\n", stderr: "why\n", timedOut: false });
      // The status channel is closed to the command: it cannot write a report of its own.
      const forged = await cell.exec(["sh", "-c", "echo 0 >&3; exit 7"], { timeoutSeconds: 10 });
      expect(forged.exitCode).toBe(7);
      expect((await cell.exec(["cat"], { timeoutSeconds: 10, stdin: "piped" })).stdout).toBe("piped");
      expect((await cell.exec(["exit", "3"], { timeoutSeconds: 10 })).exitCode).toBe(127);

      // A timed-out command, even one that ignores SIGTERM, is gone from the cell when the exec returns.
      const stubborn = await cell.exec(["sh", "-c", "trap '' TERM; sleep 30"], { timeoutSeconds: 1 });
      expect(stubborn).toMatchObject({ exitCode: 137, timedOut: true });
      const left = await run("podman", ["exec", cell.id, "sh", "-c", "cat /proc/[0-9]*/cmdline | tr '\\0' ' '"]);
      expect(left.stdout).not.toContain("sleep 30");

      const running = cell.exec(["sleep", "20"], { timeoutSeconds: 30 }).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await run("podman", ["rm", "-f", "-t", "0", cell.id]);
      const removed = await running;
      expect(removed).toBeInstanceOf(CellExecFailed);
      if (!(removed instanceof CellExecFailed)) return;
      expect(removed.cellId).toBe(cell.id);
      expect(removed.argv).toEqual(["sleep", "20"]);
    } finally {
      await cell.teardown();
    }
  }, 60_000);

  it("reconciles a leaked cell of this instance and leaves every other container alone", async () => {
    const base = await loadBaseCell();
    // A previous process of this instance that died without tearing down.
    const previous = new PodmanSubstrate({ podmanPath: "podman", mountRoot });
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
