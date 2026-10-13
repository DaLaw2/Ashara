import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCellBackend } from "./cell-backend.js";
import {
  CellExecFailed,
  CellStartFailed,
  CellTeardownFailed,
  InvalidCellRequest,
  MountPathRejected,
  PathOutsideWorkspace,
  PodmanCommandFailed,
  ProcessSpawnFailed,
  SubstrateUnavailable,
} from "./errors.js";
import { PodmanSubstrate, type CellSpec } from "./podman.js";
import type { ProcessRequest, ProcessResult } from "./process-runner.js";

const ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const IMAGE = "docker.io/library/debian:12-slim@sha256:" + "c".repeat(64);

function ok(stdout = "", exitCode: number | null = 0): ProcessResult {
  return { exitCode, signal: null, stdout, stdoutTruncated: false, stderr: "", stderrTruncated: false, killedByHost: false, stdinError: null };
}

function recorder(responses: Array<ProcessResult | Error>) {
  const requests: ProcessRequest[] = [];
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    requests.push(request);
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected podman call: ${request.args.join(" ")}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, substrate: new PodmanSubstrate({ podmanPath: "/opt/podman", mountRoot: root, runner }) };
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
    const { requests, substrate } = recorder([ok(`${ID}\n`)]);
    const cell = await substrate.createCell(spec);

    expect(cell.id).toBe(ID);
    expect(requests[0]?.file).toBe("/opt/podman");
    expect(requests[0]?.args).toEqual([
      "run", "-d", "--name", expect.stringMatching(/^ashara-cell-[0-9a-f-]{36}$/), "--init", "--pull=never", "--network=none", "--cap-drop=all",
      "--security-opt=no-new-privileges", "--userns=keep-id",
      "--label", "ashara.managed=1",
      "--label", "ashara.instance=inst-1",
      "--label", "ashara.project=proj-1",
      "--label", "ashara.task=task-1",
      "--label", "ashara.role=worker",
      "-v", `${tree}:/workspace:Z`,
      IMAGE, "sleep", "infinity",
    ]);
    expect(Object.keys(requests[0]?.env ?? {}).every((k) => ["PATH", "HOME", "XDG_RUNTIME_DIR"].includes(k))).toBe(true);
  });

  it("uses a shared read-only label when asked", async () => {
    const { requests, substrate } = recorder([ok(ID)]);
    await substrate.createCell({ ...spec, mount: { hostPath: tree, readOnly: true, shared: true } });
    expect(requests[0]?.args).toContain(`${tree}:/workspace:ro,z`);
  });

  it("covers each masked entry with an empty stand-in of its kind, and refuses one that is missing or a symlink", async () => {
    await mkdir(join(tree, ".git"), { recursive: true });
    await writeFile(join(tree, "gitlink"), `gitdir: ${root}/host/.git/worktrees/t\n`);
    const { requests, substrate } = recorder([ok(ID)]);
    await substrate.createCell({ ...spec, mount: { hostPath: tree, shared: true, maskedEntries: [".git", "gitlink"] } });
    const args = requests[0]?.args ?? [];
    expect(args.slice(args.indexOf(`${tree}:/workspace:z`) - 1, args.indexOf(IMAGE))).toEqual([
      "-v", `${tree}:/workspace:z`,
      "-v", `${root}/.ashara-cell-masks/empty-directory:/workspace/.git:ro,z`,
      "-v", `${root}/.ashara-cell-masks/empty-file:/workspace/gitlink:ro,z`,
    ]);
    // No volume source names the masked entries themselves: the host path in the gitlink never reaches the cell.
    expect(args.some((arg) => arg.startsWith(`${tree}/.git`) || arg.startsWith(`${tree}/gitlink`))).toBe(false);
    expect(await readFile(join(root, ".ashara-cell-masks", "empty-file"), "utf8")).toBe("");
    expect(await readdir(join(root, ".ashara-cell-masks", "empty-directory"))).toEqual([]);

    await symlink(join(tree, ".git"), join(tree, "linked"));
    for (const entry of ["linked", "absent", "..", "a/b"]) {
      await expect(substrate.createCell({ ...spec, mount: { hostPath: tree, maskedEntries: [entry] } })).rejects.toBeInstanceOf(
        entry === ".." || entry === "a/b" ? InvalidCellRequest : MountPathRejected,
      );
    }
    // The stand-ins are the substrate's own: no cell mounts them as its tree.
    await expect(substrate.createCell({ ...spec, mount: { hostPath: join(root, ".ashara-cell-masks") } })).rejects.toBeInstanceOf(MountPathRejected);
    expect(requests).toHaveLength(1);
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

  it("execs under timeout in the workspace and reports timeouts", async () => {
    const { requests, substrate } = recorder([ok(ID), ok("out"), { ...ok("", 124) }]);
    const cell = await substrate.createCell(spec);
    const result = await cell.exec(["cat", "--", "./a"], { timeoutSeconds: 30, stdin: "in", cwd: "src" });
    expect(requests[1]?.args).toEqual(["exec", "-i", "-w", "/workspace/src", ID, "timeout", "-k", "5", "30", "cat", "--", "./a"]);
    expect(requests[1]?.stdin).toBe("in");
    expect(result).toMatchObject({ exitCode: 0, stdout: "out", timedOut: false });

    // 124 before the deadline is the command's own exit code, not a timeout.
    const early = await cell.exec(["sh", "-c", "exit 124"], { timeoutSeconds: 30 });
    expect(early.timedOut).toBe(false);
  });

  it("distinguishes a substrate exec failure from a failing command", async () => {
    const { substrate } = recorder([ok(ID), ok("", 125)]);
    const cell = await substrate.createCell(spec);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toBeInstanceOf(CellExecFailed);
    await expect(cell.exec(["true"], { timeoutSeconds: 0 })).rejects.toBeInstanceOf(InvalidCellRequest);
    await expect(cell.exec(["true"], { timeoutSeconds: 1, cwd: "../x" })).rejects.toBeInstanceOf(PathOutsideWorkspace);
  });

  it("throws a typed teardown failure instead of swallowing it", async () => {
    const { requests, substrate } = recorder([ok(ID), { ...ok("", 2), stderr: "boom" }, ok(ID)]);
    const cell = await substrate.createCell(spec);
    await expect(cell.teardown()).rejects.toBeInstanceOf(CellTeardownFailed);
    expect(requests[1]?.args).toEqual(["rm", "-f", ID]);
    // Still tracked after a failed teardown, so teardownAll retries it.
    expect(await substrate.teardownAll()).toEqual([ID]);
    await expect(cell.exec(["true"], { timeoutSeconds: 1 })).rejects.toBeInstanceOf(CellExecFailed);
  });

  it("reconciles by both labels, skips live cells, and refuses a foreign result", async () => {
    const labels = { "ashara.managed": "1", "ashara.instance": "inst-1" };
    const { requests, substrate } = recorder([
      ok(ID),
      ok(JSON.stringify([{ Id: ID, Labels: labels }, { Id: OTHER_ID, Labels: labels }])),
      ok(),
      ok(JSON.stringify([{ Id: OTHER_ID, Labels: { "ashara.managed": "1" } }])),
    ]);
    await substrate.createCell(spec);
    expect(await substrate.reconcileOrphans("inst-1")).toEqual([OTHER_ID]);
    expect(requests[1]?.args).toEqual([
      "ps", "-a", "--filter", "label=ashara.managed=1", "--filter", "label=ashara.instance=inst-1", "--format", "json",
    ]);
    expect(requests[2]?.args).toEqual(["rm", "-f", OTHER_ID]);
    await expect(substrate.reconcileOrphans("inst-1")).rejects.toBeInstanceOf(PodmanCommandFailed);
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

describe("CellBackend", () => {
  function fakeCell(result: Partial<ProcessResult> = {}) {
    const calls: Array<{ argv: readonly string[]; stdin?: string | Buffer }> = [];
    return {
      calls,
      cell: {
        exec: async (argv: readonly string[], options: { stdin?: string | Buffer; timeoutSeconds: number }) => {
          calls.push({ argv, stdin: options.stdin });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false, ...result };
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
    expect(listing.entries).toEqual(["src/", "src/a.ts"]);
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
