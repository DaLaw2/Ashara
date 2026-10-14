import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadBaseCell } from "./base-cell.js";
import { createCellBackend } from "./cell-backend.js";
import { BaseCellConfigInvalid, CellExecFailed, SubstrateUnavailable } from "./errors.js";
import { runHostGit } from "./host-git.js";
import { PodmanSubstrate } from "./podman.js";

// Real podman, no skip: CI rejects skipped tests, and a substrate test that skips when podman is
// absent reports the same green as one that ran.
const run = promisify(execFile);
const psSchema = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()).nullable().optional() }));

async function ps(filter: string): Promise<z.infer<typeof psSchema>> {
  const { stdout } = await run("podman", ["ps", "-a", "--filter", filter, "--format", "json"]);
  return psSchema.parse(JSON.parse(stdout));
}

/** A busybox image, pinned like the BaseCell; .github/workflows/ci.yml pulls it by this reference. */
const ALPINE_IMAGE = "docker.io/library/alpine:3.20@sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e";
/** An image with a git client and no entrypoint, pinned; .github/workflows/ci.yml pulls it by this reference. */
const GIT_IMAGE = "docker.io/library/buildpack-deps:bookworm-scm@sha256:17923645546d74acef88727bce62c23bbaed953fc7097c41a8b777bba3ca98de";
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

  // sprint0-run-2026-10-14 D13: a worktree's gitlink names its git dir's host path. go-run-2026-10-14 G4: a
  // toolchain that reads the repository failed on an unusable stand-in (ADR-074 addendum 2 d73).
  it("a cell sees a throwaway repository of its own: one commit, no remote, nothing of the host's; what it does there never reaches Z0's diff", async () => {
    const git = async (cwd: string, ...args: string[]): Promise<string> =>
      (await run("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args])).stdout.trim();
    const host = join(mountRoot, "projects", `host-${randomUUID()}`);
    await mkdir(host, { recursive: true });
    await git(host, "init", "-q", "-b", "main");
    for (const file of ["a.txt", "b.txt"]) {
      await writeFile(join(host, file), `${file}\n`);
      await git(host, "add", file);
      await git(host, "commit", "-q", "-m", file);
    }
    const tree = join(mountRoot, `worktree-${randomUUID()}`);
    await git(host, "worktree", "add", "-q", "-b", "task", tree);
    // Created on the host before the cell starts: the cell must not see it.
    await git(host, "branch", "host-only-ref");
    const hostHead = await git(host, "rev-parse", "HEAD");
    const gitlink = await readFile(join(tree, ".git"), "utf8");

    const cell = await substrate.createCell({
      image: GIT_IMAGE,
      project: "proj-cell-test",
      task: `${task}-repo`,
      role: "worker",
      instance,
      mount: { hostPath: tree },
    });
    const sh = (script: string) => cell.exec(["sh", "-c", script], { timeoutSeconds: 30 });
    try {
      const head = await sh("git rev-parse HEAD");
      expect(head.exitCode, head.stderr).toBe(0);
      expect(head.stdout).toMatch(/^[0-9a-f]{40}\n$/);
      expect(head.stdout.trim()).not.toBe(hostHead);
      expect(await sh("git status --porcelain")).toMatchObject({ exitCode: 0, stdout: "" });
      expect((await sh("git rev-list --all --count")).stdout).toBe("1\n");
      expect(await sh("git remote")).toMatchObject({ exitCode: 0, stdout: "" });
      expect((await sh("git for-each-ref --format='%(refname)'")).stdout).toBe("refs/heads/main\n");
      expect((await sh(`git cat-file -e ${hostHead}`)).exitCode).not.toBe(0);
      expect((await sh("git ls-files")).stdout).toBe("a.txt\nb.txt\n");
      expect((await sh("git log --format='%an %ae %ad' --date=unix")).stdout).toBe("workspace workspace@cell.invalid 946684800\n");
      const hostPaths = await sh(`grep -rsF -- '${mountRoot}' /workspace /ashara-cell; echo "exit $?"`);
      expect(hostPaths.stdout).toBe("exit 1\n");
      // Writing to its repository is the cell's own business: commits, branches, a tag, and config
      // that would run a program wherever git read it.
      const wrote = await sh(
        "echo c > c.txt && git add -A && git -c user.name=x -c user.email=x@x commit -qm x && " +
          `git checkout -qb other && git tag t && git config core.fsmonitor 'touch ${tree}/fsmonitor-ran'`,
      );
      expect(wrote.exitCode, wrote.stderr).toBe(0);
      // The gitlink stand-in itself cannot be rewritten or removed.
      expect((await sh("echo 'gitdir: /tmp' > .git")).exitCode).not.toBe(0);
      expect((await sh("rm -f .git")).exitCode).not.toBe(0);
    } finally {
      await cell.teardown();
    }
    // Z0's diff reads the host's git dir, never the cell's: it sees the file and nothing else.
    expect(await readFile(join(tree, ".git"), "utf8")).toBe(gitlink);
    const repo = { gitDir: join(host, ".git", "worktrees", basename(tree)), workTree: tree };
    expect((await runHostGit(repo, ["status", "--porcelain"])).stdout).toBe("?? c.txt\n");
    expect(await git(host, "rev-parse", "task")).toBe(hostHead);
    expect((await git(host, "for-each-ref", "--format=%(refname)")).split("\n")).toEqual([
      "refs/heads/host-only-ref",
      "refs/heads/main",
      "refs/heads/task",
    ]);
    expect(existsSync(join(tree, "fsmonitor-ran"))).toBe(false);
    // The repository went with the cell.
    expect(await readdir(join(mountRoot, ".ashara-cell-state", instance))).toEqual([]);
  }, 60_000);

  // go-run-2026-10-14 G2: a recipe made a root-owned cache the cell's user could not write.
  it("every cell runs as the host's uid with a writable HOME of its own, the probe's as the task's", async () => {
    const base = await loadBaseCell();
    const worktree = await mkdtemp(join(mountRoot, "user-task-"));
    const checkout = await mkdtemp(join(mountRoot, "user-probe-"));
    // As execution-service makes them: the task cell's private tree, the probe cell's shared checkout.
    const taskCell = await substrate.createCell({ image: base.image, project: "proj-cell-test", task: `${task}-user`, role: "worker", instance, mount: { hostPath: worktree } });
    const probeCell = await substrate.createCell({
      image: base.image,
      project: "proj-cell-test",
      task: `${task}-user`,
      role: "platform",
      instance,
      mount: { hostPath: checkout, shared: true },
    });
    try {
      const whoami = 'id -u; id -g; echo "$HOME"; touch "$HOME/mine" && echo writable; ls "$HOME"';
      const expected = `${process.getuid?.() ?? -1}\n${process.getgid?.() ?? -1}\n/ashara-cell/home\nwritable\nmine\n`;
      expect((await taskCell.exec(["sh", "-c", whoami], { timeoutSeconds: 10 })).stdout).toBe(expected);
      expect((await probeCell.exec(["sh", "-c", whoami], { timeoutSeconds: 10 })).stdout).toBe(expected);
      expect((await probeCell.exec(["id", "-u"], { timeoutSeconds: 10 })).stdout).not.toBe("0\n");
    } finally {
      await taskCell.teardown();
      await probeCell.teardown();
    }
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

  // t-exec-timeout-orphans: busybox's timeout signals only its direct child, so before the sweep
  // `sh -c "sleep 30; echo after"` timed out on alpine while sleep stayed in the cell.
  it.each([
    ["alpine (busybox timeout)", ALPINE_IMAGE],
    ["debian (GNU timeout)", "base"],
  ])("on %s a timed-out multi-process command leaves no process in the cell, and the cell stays usable", async (_name, image) => {
    const cell = await substrate.createCell({
      image: image === "base" ? (await loadBaseCell()).image : image,
      project: "proj-cell-test",
      task: `${task}-orphans`,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    try {
      const left = async (): Promise<string[]> => {
        // podman top reads the cell's /proc from the host: no tool of the image is involved.
        const { stdout } = await run("podman", ["top", cell.id, "pid", "args"]);
        return stdout
          .split("\n")
          .slice(1)
          .map((line) => line.trim().replace(/\s+/g, " "))
          .filter((line) => line !== "" && !line.startsWith("1 ") && !/^\d+ sleep infinity$/.test(line));
      };
      const command = "sleep 30 & setsid sleep 40 & trap '' TERM; sleep 31; echo after";
      const timed = await cell.exec(["sh", "-c", command], { timeoutSeconds: 1 });
      expect(timed.timedOut).toBe(true);
      expect(timed.stdout).not.toContain("after");
      expect(await left()).toEqual([]);

      // A command that ends by itself and leaves a background process behind leaves nothing either.
      const background = await cell.exec(["sh", "-c", "sleep 45 & echo started"], { timeoutSeconds: 10 });
      expect(background).toMatchObject({ exitCode: 0, stdout: "started\n", timedOut: false });
      expect(await left()).toEqual([]);

      const after = await cell.exec(["sh", "-c", "echo usable"], { timeoutSeconds: 10 });
      expect(after).toMatchObject({ exitCode: 0, stdout: "usable\n", timedOut: false });
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
