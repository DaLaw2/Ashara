import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordingLogger } from "@ashara/shared";
import { createCellBackend } from "./cell-backend.js";
import { readCellLimits } from "./cell-limits.js";
import {
  CellExecFailed,
  CellLimitsInvalid,
  CellStartFailed,
  CellTeardownFailed,
  InvalidCellRequest,
  MountPathRejected,
  PathOutsideWorkspace,
  ProcessSpawnFailed,
  SubstrateUnavailable,
  TeardownIncomplete,
} from "./errors.js";
import { PodmanSubstrate, sweepOver, type CellSpec } from "./podman.js";
import type { ProcessRequest, ProcessResult } from "./process-runner.js";

const run = promisify(execFile);
const ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const IMAGE = "docker.io/library/debian:12-slim@sha256:" + "c".repeat(64);
const LIMITS = { memoryBytes: 512 * 1024 * 1024, cpus: 1.5, pids: 256 };

function ok(stdout = "", exitCode: number | null = 0): ProcessResult {
  return { exitCode, signal: null, stdout, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null, statusReport: null };
}

/** An exec whose in-cell wrapper reported the command's own status on fd 3. */
function ran(stdout = "", exitCode = 0): ProcessResult {
  return { ...ok(stdout, exitCode), statusReport: `${exitCode}\n` };
}

/** An exec that ended with no status report: the substrate's own failure. */
function unreported(exitCode: number, stderr = ""): ProcessResult {
  return { ...ok("", exitCode), stderr, statusReport: "" };
}

/** A logger whose every trace is `trace`: a cell's label is then known before it is created. */
function tracedAs(trace: string): ReturnType<typeof recordingLogger> {
  return { ...recordingLogger(), trace: () => trace };
}

function recorder(responses: Array<ProcessResult | Error>, logger: ReturnType<typeof recordingLogger> = tracedAs("test-trace")) {
  const requests: ProcessRequest[] = [];
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    requests.push(request);
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected podman call: ${request.args.join(" ")}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, substrate: new PodmanSubstrate({ logger, podmanPath: "/opt/podman", mountRoot: root, runner, limits: LIMITS }) };
}

// A real directory tree: mounts are canonicalized with realpath before podman runs.
let root = "";
let tree = "";
let spec: CellSpec;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-mount-root-")));
  tree = join(root, "tree");
  await mkdir(tree);
  spec = { image: IMAGE, project: "proj-1", task: "task-1", role: "worker", instance: "inst-1", mount: { hostPath: tree } };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PodmanSubstrate argv", () => {
  afterEach(() => {
    delete process.env.ASHARA_PROBE_SECRET;
  });

  it("creates a labelled, network-less cell and passes podman a minimal env", async () => {
    process.env.ASHARA_PROBE_SECRET = "must-not-leak";
    const { requests, substrate } = recorder([ok(`${ID}\n`), ok()]);
    const cell = await substrate.createCell(spec);

    expect(cell.id).toBe(ID);
    expect(requests[0]?.file).toBe("/opt/podman");
    const name = requests[0]?.args[3] ?? "";
    expect(requests[0]?.args).toEqual([
      "run", "-d", "--name", expect.stringMatching(/^ashara-cell-[0-9a-f-]{36}$/), "--init", "--pull=never", "--network=none", "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--memory=536870912", "--memory-swap=536870912", "--cpu-period=100000", "--cpu-quota=150000", "--pids-limit=256",
      "--userns=keep-id",
      `--user=${process.getuid?.()}:${process.getgid?.()}`,
      "--label", "ashara.managed=1",
      "--label", "ashara.instance=inst-1",
      "--label", "ashara.project=proj-1",
      "--label", "ashara.task=task-1",
      "--label", "ashara.role=worker",
      "--label", "ashara.trace=test-trace",
      "-e", "HOME=/ashara-cell/home",
      "-v", `${tree}:/workspace:Z`,
      "-v", `${root}/.ashara-cell-state/inst-1/${name}/home:/ashara-cell/home:Z`,
      IMAGE, "sleep", "infinity",
    ]);
    expect(Object.keys(requests[0]?.env ?? {}).every((k) => ["PATH", "HOME", "XDG_RUNTIME_DIR", "CONTAINERS_STORAGE_CONF"].includes(k))).toBe(true);
    // The cell's state goes with it.
    await cell.teardown();
    expect(requests[1]?.args).toEqual(["rm", "-f", ID]);
    expect(await readdir(join(root, ".ashara-cell-state", "inst-1"))).toEqual([]);
  });

  it("runs podman on the store CONTAINERS_STORAGE_CONF names when it is set, and on podman's default store when it is not", async () => {
    const saved = process.env.CONTAINERS_STORAGE_CONF;
    try {
      process.env.CONTAINERS_STORAGE_CONF = "/srv/test-store/storage.conf";
      const named = recorder([ok(`${ID}\n`)]);
      await named.substrate.createCell(spec);
      expect(named.requests[0]?.env?.CONTAINERS_STORAGE_CONF).toBe("/srv/test-store/storage.conf");

      delete process.env.CONTAINERS_STORAGE_CONF;
      const unset = recorder([ok(`${ID}\n`)]);
      await unset.substrate.createCell(spec);
      expect(Object.keys(unset.requests[0]?.env ?? {})).not.toContain("CONTAINERS_STORAGE_CONF");
    } finally {
      if (saved === undefined) delete process.env.CONTAINERS_STORAGE_CONF;
      else process.env.CONTAINERS_STORAGE_CONF = saved;
    }
  });

  it("refuses to build a substrate without cell limits: none given and ASHARA_CELL_MEMORY unset", () => {
    const saved = process.env.ASHARA_CELL_MEMORY;
    delete process.env.ASHARA_CELL_MEMORY;
    try {
      expect(() => new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "/opt/podman", mountRoot: root })).toThrow(CellLimitsInvalid);
      expect(() => readCellLimits({ ASHARA_CELL_MEMORY: "4", ASHARA_CELL_CPUS: "1", ASHARA_CELL_PIDS_LIMIT: "10" })).toThrow(/ASHARA_CELL_MEMORY="4"/);
      expect(() => readCellLimits({ ASHARA_CELL_MEMORY: "4g", ASHARA_CELL_CPUS: "0", ASHARA_CELL_PIDS_LIMIT: "10" })).toThrow(/ASHARA_CELL_CPUS/);
      expect(() => readCellLimits({ ASHARA_CELL_MEMORY: "4g", ASHARA_CELL_CPUS: "1", ASHARA_CELL_PIDS_LIMIT: " " })).toThrow(/ASHARA_CELL_PIDS_LIMIT is not set/);
      expect(readCellLimits({ ASHARA_CELL_MEMORY: "4g", ASHARA_CELL_CPUS: "0.5", ASHARA_CELL_PIDS_LIMIT: "10" })).toEqual({
        memoryBytes: 4 * 1024 ** 3,
        cpus: 0.5,
        pids: 10,
      });
    } finally {
      if (saved !== undefined) process.env.ASHARA_CELL_MEMORY = saved;
    }
  });

  it("uses a shared read-only label when asked", async () => {
    const { requests, substrate } = recorder([ok(ID)]);
    await substrate.createCell({ ...spec, mount: { hostPath: tree, readOnly: true, shared: true } });
    expect(requests[0]?.args).toContain(`${tree}:/workspace:ro,z`);
  });

  it("covers a tree's .git with a throwaway repository of the cell's own, and refuses a symlinked .git", async () => {
    const own = { ...spec, instance: "inst-repo" };
    const states = join(root, ".ashara-cell-state", "inst-repo");
    const worktree = await mkdtemp(join(root, "worktree-"));
    await writeFile(join(worktree, ".git"), `gitdir: ${root}/host/.git/worktrees/t\n`);
    await writeFile(join(worktree, "a.txt"), "a\n");
    const checkout = await mkdtemp(join(root, "checkout-"));
    await mkdir(join(checkout, ".git"));
    const { requests, substrate } = recorder([ok(ID), ok(OTHER_ID), ok(), ok()]);

    const linked = await substrate.createCell({ ...own, mount: { hostPath: worktree, shared: true } });
    const args = requests[0]?.args ?? [];
    const state = join(states, args[3] ?? "");
    expect(args.slice(args.indexOf(`${worktree}:/workspace:z`) - 1, args.indexOf(IMAGE))).toEqual([
      "-v", `${worktree}:/workspace:z`,
      "-v", `${state}/home:/ashara-cell/home:Z`,
      "-v", `${root}/.ashara-cell-gitlink:/workspace/.git:ro,z`,
      "-v", `${state}/git:/ashara-cell/git:Z`,
    ]);
    expect(await readFile(join(root, ".ashara-cell-gitlink"), "utf8")).toBe("gitdir: /ashara-cell/git\n");
    // No volume source is the tree's own .git, and nothing in the repository names a host path.
    expect(args.some((arg) => arg.startsWith(`${worktree}/.git`))).toBe(false);
    const hostPaths = await run("grep", ["-rlF", root, join(state, "git")]).catch((e: unknown) => e);
    expect(hostPaths).toMatchObject({ code: 1 });
    expect(await readdir(join(state, "git"))).not.toContain("hooks");

    const dir = await substrate.createCell({ ...own, mount: { hostPath: checkout } });
    const dirArgs = requests[1]?.args ?? [];
    expect(dirArgs).toContain(`${join(states, dirArgs[3] ?? "")}/git:/workspace/.git:Z`);
    expect(dirArgs.some((arg) => arg.includes(".ashara-cell-gitlink"))).toBe(false);

    await linked.teardown();
    await dir.teardown();
    expect(await readdir(states)).toEqual([]);

    const symlinked = await mkdtemp(join(root, "symlinked-"));
    await symlink(join(checkout, ".git"), join(symlinked, ".git"));
    await expect(substrate.createCell({ ...own, mount: { hostPath: symlinked } })).rejects.toBeInstanceOf(MountPathRejected);
    // The state and the gitlink stand-in are the substrate's own: no cell mounts them as its tree.
    await mkdir(join(states, "x"));
    for (const hostPath of [join(states, "x"), join(root, ".ashara-cell-gitlink")]) {
      await expect(substrate.createCell({ ...own, mount: { hostPath } })).rejects.toBeInstanceOf(MountPathRejected);
    }
    await rm(join(states, "x"), { recursive: true });
    expect(requests).toHaveLength(4);
    await expect(substrate.createCell({ ...own, instance: ".." })).rejects.toBeInstanceOf(InvalidCellRequest);
  });

  it("removes a read-only directory a cell left in its state, and sweeps state no cell owns", async () => {
    const own = { ...spec, instance: "inst-sweep" };
    const states = join(root, ".ashara-cell-state", "inst-sweep");
    const { requests, substrate } = recorder([ok(ID), ok(), ok("[]")]);
    const cell = await substrate.createCell(own);
    const home = join(states, requests[0]?.args[3] ?? "", "home");
    await mkdir(join(home, "cache", "deep"), { recursive: true });
    await writeFile(join(home, "cache", "deep", "f"), "x");
    await chmod(join(home, "cache", "deep"), 0o500);
    await chmod(join(home, "cache"), 0o500);
    await cell.teardown();
    expect(await readdir(states)).toEqual([]);

    await mkdir(join(states, "ashara-cell-stray", "home"), { recursive: true });
    expect(await substrate.reconcileOrphans("inst-sweep")).toEqual([]);
    expect(await readdir(states)).toEqual([]);
  });

  it("labels a cell with the trace its creator's logger scope is in, and refuses a trace that is no label value", async () => {
    const logger = recordingLogger();
    const requests: ProcessRequest[] = [];
    const responses = [ok(ID), ok(OTHER_ID)];
    const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
      requests.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected podman call: ${request.args.join(" ")}`);
      return next;
    };
    const substrate = new PodmanSubstrate({ podmanPath: "/opt/podman", mountRoot: root, runner, limits: LIMITS, logger });

    const traces = await Promise.all([1, 2].map((attempt) =>
      logger.scope({ taskId: "task-1", attempt, trace: "new" }, async () => {
        await substrate.createCell(spec);
        return logger.trace();
      }),
    ));
    expect(new Set(traces).size).toBe(2);
    expect(traces).not.toContain(logger.trace());
    // The two creations interleave, so the runner sees them in either order: match by label, not by index.
    const labels = requests.map((request) => request.args.filter((arg) => arg.startsWith("ashara.trace=")));
    expect(labels.every((own) => own.length === 1)).toBe(true);
    expect(labels.flat().sort()).toEqual(traces.map((trace) => `ashara.trace=${trace}`).sort());

    const unlabelled = new PodmanSubstrate({ podmanPath: "/opt/podman", mountRoot: root, runner, limits: LIMITS, logger: tracedAs("a b") });
    await expect(unlabelled.createCell(spec)).rejects.toBeInstanceOf(InvalidCellRequest);
    expect(requests).toHaveLength(2);
  });

  it("rejects specs that could become options or break the volume syntax", async () => {
    const { substrate } = recorder([]);
    await expect(substrate.createCell({ ...spec, image: "--privileged" })).rejects.toBeInstanceOf(InvalidCellRequest);
    await expect(substrate.createCell({ ...spec, mount: { hostPath: "/a:/etc" } })).rejects.toBeInstanceOf(InvalidCellRequest);
    await expect(substrate.createCell({ ...spec, task: "a b" })).rejects.toBeInstanceOf(InvalidCellRequest);
  });

  it("refuses a mount outside the root, including one a symlink leads out of, before podman runs", async () => {
    const { requests, substrate } = recorder([]);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ashara-outside-")));
    try {
      const link = join(root, "escape");
      await symlink(outside, link);
      for (const hostPath of [outside, link, root, join(root, "missing")]) {
        await expect(substrate.createCell({ ...spec, mount: { hostPath } })).rejects.toBeInstanceOf(MountPathRejected);
      }
      expect(requests).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("types a failed start and removes the container it may have created, by the name it gave it", async () => {
    const { requests, substrate } = recorder([{ ...ok("", 125), stderr: "image not known" }, ok()]);
    const error = await substrate.createCell(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CellStartFailed);
    if (!(error instanceof CellStartFailed)) return;
    expect(error.exitCode).toBe(125);
    expect(error.stderr).toBe("image not known");
    expect(error.argv[0]).toBe("run");
    const name = requests[0]?.args[3];
    expect(requests[1]?.args).toEqual(["rm", "-f", "--ignore", name]);
  });

  it("keeps a failed start's container tracked when its removal fails, and teardownAll retries it", async () => {
    const { requests, substrate } = recorder([ok("", 126), { ...ok("", 1), stderr: "busy" }, ok()]);
    const error = await substrate.createCell(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CellStartFailed);
    const name = requests[0]?.args[3];
    expect(await substrate.teardownAll()).toEqual([name]);
    expect(requests[2]?.args).toEqual(["rm", "-f", "--ignore", name]);
  });

  it("execs argv under timeout and the status wrapper in the workspace", async () => {
    const { requests, substrate } = recorder([ok(ID), ran("out"), ran("", 124)]);
    const cell = await substrate.createCell(spec);
    const result = await cell.exec(["cat", "--", "./a"], { timeoutSeconds: 30, stdin: "in", cwd: "src" });
    const args = requests[1]?.args ?? [];
    // argv travels in the wrapper's environment, never on its command line.
    expect(args.slice(0, 14)).toEqual([
      "exec", "-i", "--preserve-fds=1", "-w", "/workspace/src",
      "-e", "ASHARA_ARGC=3", "-e", "ASHARA_ARG_0=cat", "-e", "ASHARA_ARG_1=--", "-e", "ASHARA_ARG_2=./a",
      ID,
    ]);
    expect(args.slice(14, 16)).toEqual(["sh", "-c"]);
    expect(args.slice(17)).toEqual(["ashara-exec", "5", "30"]);
    // The wrapper runs argv under timeout(1), then sweeps the cell before it reports.
    expect(args[16]).toContain('timeout -k "$k" "$t" "$@" 3>&-; ashara_s=$?\nashara_sweep ||');
    expect(requests[1]?.statusChannel).toBe(true);
    expect(requests[1]?.stdin).toBe("in");
    expect(result).toMatchObject({ exitCode: 0, stdout: "out", timedOut: false });

    // 124 the command reported itself is its own exit code, not a timeout.
    const early = await cell.exec(["sh", "-c", "exit 124"], { timeoutSeconds: 30 });
    expect(early).toMatchObject({ exitCode: 124, timedOut: false });
  });

  it("logs each exec at debug in its caller's attempt scope: the command's name, exit and duration, never an argument or the environment", async () => {
    process.env.ASHARA_PROBE_SECRET = "must-not-leak";
    const logger = recordingLogger();
    const { substrate } = recorder([ok(ID), ran("", 3), unreported(125)], logger);
    const cell = await substrate.createCell(spec);

    await logger.scope({ taskId: "task-1", attempt: 2, trace: "new" }, async () => {
      await cell.exec(["deploy", "--token=argv-secret"], { timeoutSeconds: 30 });
      await cell.exec(["deploy", "--token=argv-secret"], { timeoutSeconds: 30 }).catch((e: unknown) => e);
    });

    const execs = logger.records.filter((r) => r.event === "execution-infra.cell-exec");
    expect(execs).toHaveLength(2);
    for (const record of execs) {
      expect(record).toMatchObject({ level: "debug", taskId: "task-1", attempt: 2, fields: { command: "deploy", argc: 2, cellId: ID } });
      expect(typeof record.fields?.durationMs).toBe("number");
      const line = JSON.stringify(record);
      for (const leak of ["argv-secret", "must-not-leak", "ASHARA_ARG"]) expect(line).not.toContain(leak);
    }
    expect(execs[0]?.fields).toMatchObject({ exitCode: 3, timedOut: false, statusLost: false });
    expect(execs[1]?.fields).toMatchObject({ exitCode: 125, failed: true });
  });

  it("a command that exits 125 is the command's result; a wrapper killed by a signal in a cell that fails its probe is the substrate's failure", async () => {
    const { requests, substrate } = recorder([
      ok(ID),
      ran("", 125),
      unreported(137, "partial err"),
      { ...ok("", 125), stderr: "Error: no container with name or ID found" },
      { ...ran("", 3), exitCode: 125 },
      { ...ok("", 0), statusReport: "zero\n" },
    ]);
    const cell = await substrate.createCell(spec);
    expect(await cell.exec(["sh", "-c", "exit 125"], { timeoutSeconds: 1 })).toMatchObject({ exitCode: 125, timedOut: false });

    const cellLost = await cell.exec(["true"], { timeoutSeconds: 1 }).catch((e: unknown) => e);
    expect(cellLost).toBeInstanceOf(CellExecFailed);
    if (!(cellLost instanceof CellExecFailed)) return;
    expect(cellLost).toMatchObject({ exitCode: 137, stderr: "partial err", argv: ["true"] });
    expect(cellLost.message).toMatch(/failed its probe/);
    expect(requests[3]?.args.slice(0, 4)).toEqual(["exec", ID, "sh", "-c"]);
    expect(requests[3]?.args[4]).toContain("ashara_sweep");

    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/exited 3 in the cell but podman exec exited 125/);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/status report is malformed/);
  });

  it("podman exec failing before the wrapper ran (125-127) is the substrate's failure even in a cell that would pass its probe", async () => {
    for (const exitCode of [125, 126, 127]) {
      // No probe response is queued: the verdict does not consult the cell, so a healthy one cannot turn it into statusLost.
      const { requests, substrate } = recorder([ok(ID), unreported(exitCode, "Error: OCI runtime error")]);
      const cell = await substrate.createCell(spec);
      const failed = await cell.exec(["true"], { timeoutSeconds: 1 }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(CellExecFailed);
      if (!(failed instanceof CellExecFailed)) return;
      expect(failed).toMatchObject({ exitCode, stderr: "Error: OCI runtime error", argv: ["true"] });
      expect(failed.message).toMatch(/not a wrapper killed by a signal/);
      expect(requests).toHaveLength(2);
    }
  });

  // A command such as `kill -9 $(pgrep -f ...)` can kill the wrapper itself.
  it("an exit with no status report in a cell that passes its probe is the command's result, its status unknown", async () => {
    const { requests, substrate } = recorder([ok(ID), { ...unreported(137, "partial err"), stdout: "partial" }, ok("", 0)]);
    const cell = await substrate.createCell(spec);
    const result = await cell.exec(["sh", "-c", "pkill -f marker"], { timeoutSeconds: 10 });
    expect(result).toEqual({
      exitCode: null,
      stdout: "partial",
      stderr: "partial err",
      timedOut: false,
      statusLost: true,
      stdoutCut: null,
      stderrCut: null,
    });
    // The probe is the sweep: it also ends what the command left that the dead wrapper never swept.
    expect(requests[2]?.args.slice(0, 4)).toEqual(["exec", ID, "sh", "-c"]);
    expect(requests[2]?.args[4]).toContain("ashara_sweep");
  });

  it("a sweep that left a process alive, an exec in the init's session, or one that cannot run argv is CellExecFailed", async () => {
    const { substrate } = recorder([
      ok(ID),
      { ...ran("", 0), statusReport: "unswept 0\n" },
      { ...ran("", 125), statusReport: "unisolated\n" },
      { ...ran("", 127), statusReport: "unrunnable\n" },
      { ...ran("", 0), statusReport: "unswept zero\n" },
    ]);
    const cell = await substrate.createCell(spec);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/still alive after the wrapper's sweep/);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/cannot be told from the session of the cell's init.*not run/);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/could not run the command; the command was not run/);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toThrow(/status report is malformed/);
  });

  it("sweeps the cell from a fresh exec after the host backstop, and fails closed when that sweep fails", async () => {
    const hung: ProcessResult = { ...ok("", null), killedByHost: true, statusReport: "" };
    const { requests, substrate } = recorder([ok(ID), hung, ok("", 0), hung, ok("", 1)]);
    const cell = await substrate.createCell(spec);
    expect(await cell.exec(["sleep", "99"], { timeoutSeconds: 1 })).toMatchObject({ exitCode: null, timedOut: true });
    expect(requests[2]?.args.slice(0, 4)).toEqual(["exec", ID, "sh", "-c"]);
    expect(requests[2]?.args[4]).toContain("ashara_sweep");
    await expect(cell.exec(["sleep", "99"], { timeoutSeconds: 1 })).rejects.toThrow(/sweeping the cell afterwards failed/);
  });

  it("runs a cell's execs one at a time", async () => {
    let active = 0;
    let most = 0;
    const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
      if (request.args[0] === "run") return ok(ID);
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return ran("", 0);
    };
    const substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "/opt/podman", mountRoot: root, runner });
    const cell = await substrate.createCell(spec);
    const results = await Promise.all([1, 2, 3].map(() => cell.exec(["true"], { timeoutSeconds: 1 })));
    expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    expect(most).toBe(1);
  });

  it("refuses a malformed exec request before podman runs", async () => {
    const { requests, substrate } = recorder([ok(ID)]);
    const cell = await substrate.createCell(spec);
    await expect(cell.exec(["true"], { timeoutSeconds: 0 })).rejects.toBeInstanceOf(InvalidCellRequest);
    await expect(cell.exec(["-x"], { timeoutSeconds: 1 })).rejects.toBeInstanceOf(InvalidCellRequest);
    await expect(cell.exec(["true"], { timeoutSeconds: 1, cwd: "../x" })).rejects.toBeInstanceOf(PathOutsideWorkspace);
    expect(requests).toHaveLength(1);
  });

  it("throws a typed teardown failure instead of swallowing it", async () => {
    const failed = { ...ok("", 2), stderr: "boom" };
    const { requests, substrate } = recorder([ok(ID), failed, failed, ok(ID)]);
    const cell = await substrate.createCell(spec);
    await expect(cell.teardown()).rejects.toBeInstanceOf(CellTeardownFailed);
    expect(requests[1]?.args).toEqual(["rm", "-f", ID]);
    // Still tracked after a failed teardown, so teardownAll retries it, and names what it could not remove.
    await expect(substrate.teardownAll()).rejects.toBeInstanceOf(TeardownIncomplete);
    expect(await substrate.teardownAll()).toEqual([ID]);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toBeInstanceOf(CellExecFailed);
  });

  it("reconciles by both labels, skips live cells, and leaves alone what a podman that ORs its filters lists with one label", async () => {
    const labels = { "ashara.managed": "1", "ashara.instance": "inst-1" };
    const { requests, substrate } = recorder([
      ok(ID),
      ok(JSON.stringify([{ Id: ID, Labels: labels }, { Id: OTHER_ID, Labels: labels }])),
      ok(),
      ok(JSON.stringify([
        { Id: OTHER_ID, Labels: { "ashara.managed": "1", "ashara.instance": "inst-2" } },
        { Id: "c".repeat(64), Labels: { "ashara.instance": "inst-1" } },
        { Id: "d".repeat(64), Labels: null },
      ])),
    ]);
    await substrate.createCell(spec);
    expect(await substrate.reconcileOrphans("inst-1")).toEqual([OTHER_ID]);
    expect(requests[1]?.args).toEqual([
      "ps", "-a", "--filter", "label=ashara.managed=1", "--filter", "label=ashara.instance=inst-1", "--format", "json",
    ]);
    expect(requests[2]?.args).toEqual(["rm", "-f", OTHER_ID]);
    expect(await substrate.reconcileOrphans("inst-1")).toEqual([]);
    expect(requests).toHaveLength(4);
  });

  it("probes with podman info and maps a missing binary to SubstrateUnavailable", async () => {
    const info = { version: { Version: "5.8.2" }, host: { security: { rootless: true } } };
    const { requests, substrate } = recorder([ok(JSON.stringify(info)), new ProcessSpawnFailed("/opt/podman", "ENOENT", "spawn ENOENT")]);
    expect(await substrate.probeSubstrate()).toEqual({ version: "5.8.2", rootless: true });
    expect(requests[0]?.args).toEqual(["info", "--format", "json"]);
    await expect(substrate.probeSubstrate()).rejects.toBeInstanceOf(SubstrateUnavailable);
  });
});

describe("the sweep, over a fake process table", () => {
  // Its pids exceed every pid_max (at most 2^22), so the sweep's kill -9 reaches no host process.
  const LINGERING_PID = "9999999";
  let table = "";

  beforeAll(async () => {
    table = await mkdtemp(join(tmpdir(), "ashara-fake-proc-"));
  });

  afterAll(async () => {
    await rm(table, { recursive: true, force: true });
  });

  function sweepExit(procRoot: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", sweepOver(procRoot)], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", resolve);
    });
  }

  it("waits for a killed process that stays listed, as one in uninterruptible I/O does, and succeeds once it is gone", async () => {
    const root = await mkdtemp(join(table, "lingering-"));
    await mkdir(join(root, "1"));
    await writeFile(join(root, "1", "stat"), "1 (catatonit) S 0 1 1 0 -1\n");
    await mkdir(join(root, "2"));
    await writeFile(join(root, "2", "stat"), "2 (sleep) S 1 2 1 0 -1\n");
    await mkdir(join(root, LINGERING_PID));
    await writeFile(join(root, LINGERING_PID, "stat"), `${LINGERING_PID} (dd) D 1 ${LINGERING_PID} ${LINGERING_PID} 0 -1\n`);
    const lingerMs = 1500;
    const startedAt = Date.now();
    const [exit] = await Promise.all([
      sweepExit(root),
      new Promise((resolve) => setTimeout(resolve, lingerMs)).then(() => rm(join(root, LINGERING_PID), { recursive: true })),
    ]);
    expect(exit).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(lingerMs);
  });

  it("succeeds at once when only the init's session and the dead are listed", async () => {
    const root = await mkdtemp(join(table, "clean-"));
    await mkdir(join(root, "1"));
    await writeFile(join(root, "1", "stat"), "1 (catatonit) S 0 1 1 0 -1\n");
    await mkdir(join(root, LINGERING_PID));
    await writeFile(join(root, LINGERING_PID, "stat"), `${LINGERING_PID} (dd) Z 1 ${LINGERING_PID} ${LINGERING_PID} 0 -1\n`);
    expect(await sweepExit(root)).toBe(0);
  });
});

describe("CellBackend", () => {
  function fakeCell(result: Partial<ProcessResult> = {}) {
    const calls: Array<{ argv: readonly string[]; stdin?: string | Buffer }> = [];
    return {
      calls,
      cell: {
        exec: async (argv: readonly string[], options: { stdin?: string | Buffer; timeoutSeconds: number }) => {
          calls.push({ argv, stdin: options.stdin });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null, ...result };
        },
      },
    };
  }

  it("builds POSIX argv with workspace-relative paths after --", async () => {
    const { calls, cell } = fakeCell({ stdout: "./src/\n./src/a.ts\n" });
    const backend = createCellBackend(cell, { toolTimeoutSeconds: 10 });
    await backend.readFile("src/a.ts");
    await backend.writeFile("src/b.ts", "body");
    const listing = await backend.listDirectory(".", 2);
    await backend.search("needle", "src");
    await backend.run("make test", 60);

    expect(calls.map((c) => c.argv)).toEqual([
      ["cat", "--", "./src/a.ts"],
      ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", "./src/b.ts"],
      ["find", "--", ".", "-mindepth", "1", "-maxdepth", "2", "-type", "d", "-exec", "printf", "%s/\\n", "{}", "+", "-o", "-print"],
      ["grep", "-rn", "-E", "-e", "needle", "--", "./src"],
      ["sh", "-c", "make test"],
    ]);
    expect(calls[1]?.stdin).toBe("body");
    expect(listing).toEqual([{ kind: "kept", text: "src/\nsrc/a.ts\n" }]);
  });

  it("drops a listing line the output cap split and counts it with the cut, sorting each side on its own", async () => {
    // Kept: "./b\n./a\n./sp" | 500 characters cut | "lit\n./d\n./c\n".
    const head = "./b\n./a\n./sp";
    const { cell } = fakeCell({ stdout: `${head}lit\n./d\n./c\n`, stdoutCut: { at: head.length, chars: 500 } });
    const backend = createCellBackend(cell, { toolTimeoutSeconds: 10 });
    expect(await backend.listDirectory(".", 1)).toEqual([
      { kind: "kept", text: "a\nb\n" },
      { kind: "cut", chars: 4 + 500 + 4 },
      { kind: "kept", text: "c\nd\n" },
    ]);
  });

  it("rejects absolute paths and '..' escapes before any exec", async () => {
    const { calls, cell } = fakeCell();
    const backend = createCellBackend(cell, { toolTimeoutSeconds: 10 });
    for (const path of ["/etc/passwd", "..", "../x", "a/../../x", "a/\0b"]) {
      await expect(backend.readFile(path)).rejects.toBeInstanceOf(PathOutsideWorkspace);
    }
    await expect(backend.writeFile("src/../../x", "")).rejects.toBeInstanceOf(PathOutsideWorkspace);
    expect(calls).toHaveLength(0);
  });
});
