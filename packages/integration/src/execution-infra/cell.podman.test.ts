import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CellExecFailed,
  PodmanSubstrate,
  createCellBackend,
  loadBaseCell,
  runHostGit,
  spawnProcess,
  type ProcessRunner,
} from "@ashara/execution-infra";
import { recordingLogger } from "@ashara/shared/testing";
import { testCellInstance } from "../test-cells.js";
import { TEST_IMAGES } from "../test-images.js";

// Real podman, no skip: CI rejects skipped tests, and a substrate test that skips when podman is
// absent reports the same green as one that ran.
const run = promisify(execFile);
const psSchema = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()).nullable().optional() }));

async function ps(filter: string): Promise<z.infer<typeof psSchema>> {
  const { stdout } = await run("podman", ["ps", "-a", "--filter", filter, "--format", "json"]);
  return psSchema.parse(JSON.parse(stdout));
}

/** A busybox image, pinned like the BaseCell. */
const ALPINE_IMAGE = TEST_IMAGES.alpine;
/** An image with a git client and no entrypoint, pinned. */
const GIT_IMAGE = TEST_IMAGES.git;
const instance = testCellInstance();
/** How many times the self-kill case runs in one cell. */
const SELF_KILL_ROUNDS = 50;
const task = `task-${randomUUID()}`;
const strayIds: string[] = [];
let mountRoot = "";
let workspace = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  process.env.ASHARA_PROBE_SECRET = "probe-secret-must-not-reach-the-cell";
  mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-cell-root-")));
  workspace = await mkdtemp(join(mountRoot, "ws-"));
  substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot });
});

afterAll(async () => {
  delete process.env.ASHARA_PROBE_SECRET;
  // The strays go whether or not the substrate's own teardown completes.
  try {
    await substrate.teardownAll();
  } finally {
    if (strayIds.length > 0) await run("podman", ["rm", "-f", "--ignore", "-t", "0", ...strayIds]);
    await rm(mountRoot, { recursive: true, force: true });
  }
});

describe("cell on real podman", () => {
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
    expect(await backend.readFile("src/notes.txt")).toEqual([{ kind: "kept", text: "alpha\nneedle here\n" }]);
    expect(await backend.listDirectory(".", 2)).toEqual([{ kind: "kept", text: "src/\nsrc/notes.txt\n" }]);
    expect(await backend.search("need+le", ".")).toEqual([{ kind: "kept", text: "src/notes.txt:2:needle here\n" }]);

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

  // A worktree's gitlink names its git dir's host path, which a cell cannot reach, and a toolchain
  // that reads the repository needs a usable one, not a stand-in.
  it("a cell created inside a logger scope is found by that scope's trace label, and by no other trace's", async () => {
    const logger = recordingLogger();
    const traced = new PodmanSubstrate({ podmanPath: "podman", mountRoot, logger });
    try {
      const base = await loadBaseCell();
      const { cell, trace } = await logger.scope({ taskId: task, attempt: 1, trace: "new" }, async () => ({
        cell: await traced.createCell({ image: base.image, project: "proj-cell-test", task, role: "worker", instance, mount: { hostPath: workspace } }),
        trace: logger.trace(),
      }));
      const found = await ps(`label=ashara.trace=${trace}`);
      expect(found.map((entry) => entry.Id)).toEqual([cell.id]);
      expect(await ps(`label=ashara.trace=${logger.trace()}`)).toHaveLength(0);
      await cell.teardown();
    } finally {
      await traced.teardownAll();
    }
  });

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
  });

  // A recipe must not leave a root-owned cache the cell's user cannot write.
  it("every cell runs as the host's uid with a writable HOME of its own, the probe's as the task's", async () => {
    const base = await loadBaseCell();
    const worktree = await mkdtemp(join(mountRoot, "user-task-"));
    const checkout = await mkdtemp(join(mountRoot, "user-probe-"));
    // As the dispatch and its verification make them: the task cell's private tree, the probe cell's shared checkout.
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
      try {
        await taskCell.teardown();
      } finally {
        await probeCell.teardown();
      }
    }
  });

  // An image's `USER root` must not make the cell root: it could write neither its tree nor HOME.
  it("a cell on an image whose USER is root runs as the host's uid and gid and writes its tree and HOME as them", async () => {
    const context = await mkdtemp(join(mountRoot, "user-root-image-"));
    await writeFile(join(context, "Containerfile"), `FROM ${ALPINE_IMAGE}\nUSER root\n`);
    // Built locally from the pinned base and never removed, so a rerun reuses it.
    const image = "localhost/ashara-test-user-root:alpine-3.20";
    await run("podman", ["build", "--pull=never", "-q", "-t", image, "-f", join(context, "Containerfile"), context]);
    const tree = await mkdtemp(join(mountRoot, "user-root-tree-"));
    const cell = await substrate.createCell({ image, project: "proj-cell-test", task: `${task}-user-root`, role: "worker", instance, mount: { hostPath: tree } });
    try {
      const ids = await cell.exec(["sh", "-c", 'id -u; id -g; touch /workspace/made-here "$HOME/made-here"'], { timeoutSeconds: 10 });
      expect(ids).toMatchObject({ exitCode: 0, stdout: `${process.getuid?.()}\n${process.getgid?.()}\n` });
      const { stdout } = await run("podman", ["inspect", "--format", "{{range .Mounts}}{{.Destination}}={{.Source}}\n{{end}}", cell.id]);
      const home = stdout.split("\n").find((line) => line.startsWith("/ashara-cell/home="))?.slice("/ashara-cell/home=".length);
      expect(home).toBeDefined();
      for (const made of [join(tree, "made-here"), join(home ?? "", "made-here")]) {
        const owner = await stat(made);
        expect({ made, uid: owner.uid, gid: owner.gid }).toEqual({ made, uid: process.getuid?.(), gid: process.getgid?.() });
      }
    } finally {
      await cell.teardown();
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
      // eslint-disable-next-line no-restricted-syntax -- the exec's process must be running when the cell is removed and nothing reports when it starts; a poll for the process would replace this wait
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
  });

  // busybox's timeout signals only its direct child, so without the sweep
  // `sh -c "sleep 30; echo after"` times out on alpine while sleep stays in the cell.
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
  });

  // CI's podman 4.9.3 (crun) starts an exec in the caller's session, outside the cell, where
  // podman 5.8.2 (crun 1.27) starts it in a session of its own; a wrapper must run under both. Here
  // the wrapper runs as the child of a shell, so it leads no session on any runtime, and that shell
  // must outlive the wrapper's sweep for the exec's exit to arrive.
  it.each([
    ["alpine (busybox)", ALPINE_IMAGE],
    ["debian (dash, GNU timeout)", "base"],
  ])("on %s a wrapper that leads no session runs the command, sweeps what it left and spares the shell that runs it", async (_name, image) => {
    const marker = "ashara-test-trampoline";
    const trampoline: ProcessRunner = (request) => {
      const at = request.args.indexOf("-c");
      const wrapped =
        request.args[0] === "exec" && at > 0 && request.args[at - 1] === "sh"
          ? [...request.args.slice(0, at + 1), `sh -c "$0" "$@"; exit $? # ${marker}`, ...request.args.slice(at + 1)]
          : request.args;
      return spawnProcess({ ...request, args: wrapped });
    };
    const nested = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot, runner: trampoline });
    const cell = await nested.createCell({
      image: image === "base" ? (await loadBaseCell()).image : image,
      project: "proj-cell-test",
      task: `${task}-nested`,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    try {
      // The command's session is the wrapper's: led by the trampoline shell, or outside the cell.
      const session =
        'read -r l < /proc/$$/stat; set -- ${l##*) }; sid=$4; if [ "$sid" = 0 ]; then echo outside; ' +
        `elif tr '\\0' ' ' < "/proc/$sid/cmdline" | grep -qF '${marker.slice(0, 6)}''${marker.slice(6)}'; then echo trampoline; ` +
        'else echo "other $sid"; fi; sleep 43 & setsid sleep 44 & echo started';
      const ran = await cell.exec(["sh", "-c", session], { timeoutSeconds: 10 });
      expect(ran, ran.stderr).toMatchObject({ exitCode: 0, timedOut: false, statusLost: false });
      expect(ran.stdout).toMatch(/^(trampoline|outside)\nstarted\n$/);
      const { stdout: left } = await run("podman", ["top", cell.id, "args"]);
      expect(left).not.toMatch(/sleep 4[34]/);

      const timed = await cell.exec(["sh", "-c", "sleep 45 & trap '' TERM; sleep 30"], { timeoutSeconds: 1 });
      expect(timed).toMatchObject({ timedOut: true, statusLost: false });
      const { stdout: afterTimeout } = await run("podman", ["top", cell.id, "args"]);
      expect(afterTimeout).not.toMatch(/sleep (45|30)/);
      expect(await cell.exec(["sh", "-c", "echo usable; exit 4"], { timeoutSeconds: 10 })).toMatchObject({ exitCode: 4, stdout: "usable\n" });
    } finally {
      await cell.teardown();
    }
  });

  // `kill -9 $(pgrep -f '<pattern from the command>')` must not match
  // the wrapper, and a lost status in a cell that still answers is not a lost cell.
  it("a command that kills by a pattern from its own text ends itself, never the wrapper; one that kills the wrapper is a lost status in a healthy cell", async () => {
    const cell = await substrate.createCell({
      image: (await loadBaseCell()).image,
      project: "proj-cell-test",
      task: `${task}-self-kill`,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    // `kill -9 $(pgrep -f <pattern>)` in POSIX sh over the cell's /proc, so no procps is needed in the
    // image: like pgrep, the listing subshell leaves out only itself.
    const pkill = (pattern: string): string =>
      `kill -9 $(read -r me _ < /proc/self/stat; for p in /proc/[0-9]*; do [ "\${p#/proc/}" = "$me" ] && continue; ` +
      `tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qF -- ${pattern} && echo "\${p#/proc/}"; done)`;
    try {
      // Repeated, since whether a killed process is gone by the sweep's next look depends on the
      // scheduler: every round must end the same way, never in CellExecFailed.
      for (let round = 0; round < SELF_KILL_ROUNDS; round++) {
        // The marker is in the command's own text, so it matches its own processes.
        const own = await cell.exec(
          ["sh", "-c", `sleep 41 & echo started; ${pkill("'flock-x-ltest3'")}; sleep 2; echo survived`],
          { timeoutSeconds: 20 },
        );
        expect(own, `round ${round}: ${own.stderr}`).toMatchObject({ exitCode: 137, statusLost: false, timedOut: false, stdout: "started\n" });

        // A pattern only the wrapper's script holds (split, so this command's text does not): the
        // wrapper dies, the cell answers its probe, and its sweep ends what the command left.
        const wrapper = await cell.exec(["sh", "-c", `sleep 42 & echo started; ${pkill('"ashara""_sweep"')}; sleep 5`], { timeoutSeconds: 20 });
        expect(wrapper, `round ${round}`).toMatchObject({ exitCode: null, statusLost: true, timedOut: false, stdout: "started\n" });
        const { stdout: left } = await run("podman", ["top", cell.id, "args"]);
        expect(left, `round ${round}`).not.toMatch(/sleep 4[12]/);
      }
      expect(await cell.exec(["sh", "-c", "echo usable"], { timeoutSeconds: 10 })).toMatchObject({ exitCode: 0, stdout: "usable\n" });
    } finally {
      await cell.teardown();
    }
  });

  it("reconciles a leaked cell of this instance and leaves every other container alone", async () => {
    const base = await loadBaseCell();
    // A previous process of this instance that died without tearing down.
    const previous = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot });
    const leaked = await previous.createCell({
      image: base.image,
      project: "proj-cell-test",
      task: `${task}-leaked`,
      role: "worker",
      instance,
      mount: { hostPath: workspace },
    });
    strayIds.push(leaked.id);

    // This instance's label without ashara.managed: the reconciler selects on both. The instance
    // label lets the run's leak guard find it should this test's own removal never run.
    const unmanaged = (
      await run("podman", ["run", "-d", "--pull=never", "--network=none", "--label", `ashara.instance=${instance}`, base.image, "sleep", "infinity"])
    ).stdout.trim();
    strayIds.push(unmanaged);
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
    expect(await ps(`id=${unmanaged}`)).toHaveLength(1);
    expect(await ps(`id=${otherInstance}`)).toHaveLength(1);
    strayIds.splice(strayIds.indexOf(leaked.id), 1);
  });
});
