import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import {
  CellExecFailed,
  CellStartFailed,
  CellTeardownFailed,
  InvalidCellRequest,
  MountPathRejected,
  PodmanCommandFailed,
  ProcessSpawnFailed,
  SubstrateUnavailable,
  TeardownIncomplete,
} from "./errors.js";
import { spawnProcess, type ProcessRequest, type ProcessResult, type ProcessRunner } from "./process-runner.js";
import { WORKSPACE_ROOT, toWorkspaceAbsolute } from "./workspace-path.js";

const LABEL_MANAGED = "ashara.managed";
const LABEL_INSTANCE = "ashara.instance";
const LABEL_PROJECT = "ashara.project";
const LABEL_TASK = "ashara.task";
const LABEL_ROLE = "ashara.role";

/** Under the mount root: the empty stand-ins masked entries are covered with. No cell may mount it. */
const MASK_DIR = ".ashara-cell-masks";
type MaskKind = "file" | "directory";

/** Seconds `timeout` waits after its signal before SIGKILL. */
const KILL_GRACE_SECONDS = 5;
/** Host-side backstop beyond the in-cell timeout, for a podman client that itself hangs. */
const HOST_BACKSTOP_SECONDS = 30;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const PODMAN_ADMIN_TIMEOUT_MS = 120_000;
/**
 * The exit statuses a cell's timeout(1) ends with when it fires: GNU's 124, and 137 after its
 * SIGKILL; busybox's timeout (alpine:3.20) leaves the killed child's 143 (SIGTERM).
 */
const TIMEOUT_EXITS: ReadonlySet<number> = new Set([124, 137, 143]);

/**
 * Every exec runs `sh -c EXEC_WRAPPER ashara-exec <grace> <seconds> <argv...>` with podman's
 * --preserve-fds=1, so the host's fourth pipe is fd 3 in the cell. The wrapper runs
 * `timeout -k <grace> <seconds> argv` with fd 3 closed, then writes its exit status to fd 3. A
 * command's own status therefore arrives on a channel closed to the command and beyond the output
 * caps, and an exit with no report is podman's or the wrapper's own failure: exit codes alone
 * cannot tell them apart, since 125 is both podman exec's own failure and a status any command
 * may return.
 *
 * timeout(1) sits inside the wrapper, never around it: busybox's timeout signals only its own
 * child, so with the wrapper as that child the signal ended the wrapper and left argv running in
 * the cell after the exec reported a timeout. Here timeout's child is argv itself (an external
 * program found on PATH, never a shell builtin), as with timeout alone, and the wrapper outlives
 * it to report 124, 137 or 143. A missing timeout(1) exits without a report.
 */
const EXEC_WRAPPER =
  "command -v timeout >/dev/null 2>&1 || { echo \"ashara-exec: timeout(1) is not on the cell's PATH\" >&2; exit 127; }; " +
  'k=$1; t=$2; shift 2; timeout -k "$k" "$t" "$@" 3>&-; s=$?; printf \'%s\\n\' "$s" >&3; exit "$s"';
const EXEC_WRAPPER_NAME = "ashara-exec";
const statusReportSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})\n$/)
  .transform(Number)
  .refine((status) => status <= 255);

const labelValue = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@+-]+$/, "label values are limited to [A-Za-z0-9._:@+-]");

const cellSpecSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .regex(/^[^\s-][^\s]*$/, "an image reference may not start with '-' or contain whitespace"),
    project: labelValue,
    task: labelValue,
    role: labelValue,
    instance: labelValue,
    mount: z
      .object({
        hostPath: z
          .string()
          .regex(/^\/[^:,\0\n]*$/, "hostPath must be absolute and free of ':', ',', NUL and newline"),
        readOnly: z.boolean().optional(),
        shared: z.boolean().optional(),
        maskedEntries: z
          .array(
            z
              .string()
              .regex(/^[^/:,\0\n]+$/, "an entry is one name directly under the mount, free of '/', ':', ',', NUL and newline")
              .refine((name) => name !== "." && name !== "..", "an entry may not be '.' or '..'"),
          )
          .optional(),
      })
      .strict(),
  })
  .strict();

export interface CellSpec {
  /** Opaque image reference, digest included; the substrate never pulls it (--pull=never). */
  readonly image: string;
  readonly project: string;
  readonly task: string;
  readonly role: string;
  /** The Ashara instance that owns the cell; reconcileOrphans selects on it. */
  readonly instance: string;
  readonly mount: {
    readonly hostPath: string;
    /** Policy default false. */
    readonly readOnly?: boolean;
    /** Policy default false (private `:Z` label); true for a path two cells share (`:z`). */
    readonly shared?: boolean;
    /**
     * Names directly under hostPath the cell never sees: each is covered, read-only, by an empty
     * file or an empty directory of the same kind. For Z0's own metadata in a tree the cell
     * writes: a worktree's `.git` gitlink names the host path of its git dir, so the cell can
     * neither read it nor rewrite it. Each must exist and must not be a symlink. Policy default: none.
     */
    readonly maskedEntries?: readonly string[];
  };
}

interface ExecOptions {
  readonly stdin?: string | Buffer;
  readonly timeoutSeconds: number;
  /** Workspace-relative working directory; policy default is the workspace root. */
  readonly cwd?: string;
}

export interface ExecResult {
  /** null only when the host backstop killed the podman client (then timedOut is true). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface Cell {
  readonly id: string;
  readonly spec: CellSpec;
  exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult>;
  teardown(): Promise<void>;
}

export interface SubstrateInfo {
  readonly version: string;
  readonly rootless: boolean;
}

export interface PodmanSubstrateOptions {
  /** Path or name of the podman binary; configuration, so a missing binary can be observed. */
  readonly podmanPath: string;
  /**
   * The host directory every mount must sit under once both are canonicalized (symlinks
   * resolved): Ashara's workdirBase. A mount outside it is refused before podman runs.
   */
  readonly mountRoot: string;
  /** Policy default: spawn the binary directly. Tests inject a recorder. */
  readonly runner?: ProcessRunner;
  /** Policy default 1 MiB per stream. */
  readonly maxOutputBytes?: number;
}

const podmanInfoSchema = z.object({
  version: z.object({ Version: z.string().min(1) }),
  host: z.object({ security: z.object({ rootless: z.boolean() }) }),
});

const containerIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

const psEntrySchema = z.object({
  Id: containerIdSchema,
  Labels: z.record(z.string(), z.string()).nullable().optional(),
});

/** The environment podman itself runs with: nothing of Ashara's reaches its process. */
function podmanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_RUNTIME_DIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A masked entry and the empty stand-in of its kind mounted over it. */
interface Mask {
  readonly entry: string;
  readonly source: string;
}

function buildRunArgs(spec: CellSpec, name: string, hostPath: string, masks: readonly Mask[]): string[] {
  const label = spec.mount.shared === true ? "z" : "Z";
  const options = [...(spec.mount.readOnly === true ? ["ro"] : []), label].join(",");
  // Shared label: every cell mounts the same stand-ins.
  const maskMounts = masks.flatMap(({ entry, source }) => ["-v", `${source}:${WORKSPACE_ROOT}/${entry}:ro,z`]);
  return [
    "run",
    "-d",
    "--name", name,
    "--init",
    "--pull=never",
    "--network=none",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--userns=keep-id",
    "--label", `${LABEL_MANAGED}=1`,
    "--label", `${LABEL_INSTANCE}=${spec.instance}`,
    "--label", `${LABEL_PROJECT}=${spec.project}`,
    "--label", `${LABEL_TASK}=${spec.task}`,
    "--label", `${LABEL_ROLE}=${spec.role}`,
    "-v", `${hostPath}:${WORKSPACE_ROOT}:${options}`,
    ...maskMounts,
    spec.image,
    "sleep", "infinity",
  ];
}

class PodmanCell implements Cell {
  private tornDown = false;

  constructor(
    readonly id: string,
    readonly spec: CellSpec,
    private readonly substrate: PodmanSubstrate,
  ) {}

  async exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    const issues: string[] = [];
    if (argv.length === 0 || argv[0] === "") issues.push("argv must name a command");
    if (argv[0]?.startsWith("-") === true) issues.push(`argv[0] must name a command, not an option: ${JSON.stringify(argv[0])}`);
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
      issues.push(`timeoutSeconds must be a positive integer, got ${options.timeoutSeconds}`);
    }
    if (issues.length > 0) throw new InvalidCellRequest("exec", issues);
    if (this.tornDown) throw new CellExecFailed(this.id, argv, null, "", "the cell has been torn down");

    const workdir = toWorkspaceAbsolute(options.cwd ?? ".");
    const args = [
      "exec", "-i", "--preserve-fds=1", "-w", workdir, this.id,
      "sh", "-c", EXEC_WRAPPER, EXEC_WRAPPER_NAME, String(KILL_GRACE_SECONDS), String(options.timeoutSeconds),
      ...argv,
    ];
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.substrate.run(args, {
        stdin: options.stdin,
        killAfterMs: (options.timeoutSeconds + KILL_GRACE_SECONDS + HOST_BACKSTOP_SECONDS) * 1000,
        statusChannel: true,
      });
    } catch (err) {
      throw new CellExecFailed(this.id, argv, null, "", "the substrate could not run podman exec", { cause: err });
    }
    const elapsedMs = Date.now() - startedAt;

    if (result.killedByHost) {
      return { ...streams(result), exitCode: null, timedOut: true };
    }
    if (result.exitCode === null) {
      throw new CellExecFailed(this.id, argv, null, result.stderr, `podman exec ended by signal ${result.signal ?? "unknown"}`);
    }
    const exitCode = result.exitCode;
    if (options.stdin !== undefined && result.stdinError !== null) {
      throw new CellExecFailed(this.id, argv, exitCode, result.stderr, `stdin was not fully delivered: ${result.stdinError}`);
    }
    if (result.statusReport === "") {
      // The wrapper never reported: podman exec, a missing sh or timeout(1), or a cell removed
      // mid-run failed before or while running the command. timeout(1) never ends the wrapper.
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `podman exec exited ${exitCode} and the in-cell wrapper reported no status for the command: ` +
          "podman exec, the wrapper's sh or its timeout(1) failed before or while running it",
      );
    }
    const report = statusReportSchema.safeParse(result.statusReport);
    if (!report.success) {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `the in-cell wrapper's status report is malformed: ${JSON.stringify(result.statusReport)}`,
      );
    }
    if (report.data !== exitCode) {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `the command exited ${report.data} in the cell but podman exec exited ${exitCode}`,
      );
    }
    if (TIMEOUT_EXITS.has(exitCode) && elapsedMs >= options.timeoutSeconds * 1000) {
      return { ...streams(result), exitCode, timedOut: true };
    }
    return { ...streams(result), exitCode, timedOut: false };
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    await this.substrate.removeContainer(this.id);
    this.tornDown = true;
    this.substrate.forget(this.id);
  }
}

function streams(result: ProcessResult): Pick<ExecResult, "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated"> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

export class PodmanSubstrate {
  private readonly podmanPath: string;
  private readonly runner: ProcessRunner;
  private readonly maxOutputBytes: number;
  private readonly mountRoot: string;
  private readonly cells = new Map<string, PodmanCell>();
  /** Containers a failed `podman run` may have left behind and that could not be removed yet, by name. */
  private readonly unconfirmed = new Set<string>();

  constructor(options: PodmanSubstrateOptions) {
    const issues: string[] = [];
    if (options.podmanPath === "") issues.push("podmanPath must not be empty");
    if (!isAbsolute(options.mountRoot)) issues.push(`mountRoot must be an absolute path, got ${JSON.stringify(options.mountRoot)}`);
    if (issues.length > 0) throw new InvalidCellRequest("substrate", issues);
    this.podmanPath = options.podmanPath;
    this.mountRoot = options.mountRoot;
    this.runner = options.runner ?? spawnProcess;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /**
   * @internal used by PodmanCell. Runs podman with an argv array; a binary that cannot be started
   * is SubstrateUnavailable.
   */
  async run(
    args: readonly string[],
    extra: Pick<ProcessRequest, "stdin" | "killAfterMs" | "statusChannel"> = { killAfterMs: PODMAN_ADMIN_TIMEOUT_MS },
  ): Promise<ProcessResult> {
    try {
      return await this.runner({
        file: this.podmanPath,
        args,
        env: podmanEnv(),
        maxOutputBytes: this.maxOutputBytes,
        ...extra,
      });
    } catch (err) {
      if (err instanceof ProcessSpawnFailed) {
        throw new SubstrateUnavailable(this.podmanPath, `cannot start the binary (${err.code}): ${err.detail}`, { cause: err });
      }
      throw err;
    }
  }

  async probeSubstrate(): Promise<SubstrateInfo> {
    const result = await this.run(["info", "--format", "json"]);
    if (result.exitCode !== 0) {
      throw new SubstrateUnavailable(
        this.podmanPath,
        `\`info\` exited ${result.exitCode ?? `by signal ${result.signal ?? "unknown"}`}: ${result.stderr.trim() || "(no stderr)"}`,
      );
    }
    const json = parseJson(result.stdout);
    if (!json.ok) throw new SubstrateUnavailable(this.podmanPath, `\`info\` printed invalid JSON: ${json.error}`);
    const parsed = podmanInfoSchema.safeParse(json.value);
    if (!parsed.success) {
      throw new SubstrateUnavailable(this.podmanPath, `\`info\` output is not the expected shape: ${issuesOf(parsed.error).join("; ")}`);
    }
    return { version: parsed.data.version.Version, rootless: parsed.data.host.security.rootless };
  }

  async createCell(spec: CellSpec): Promise<Cell> {
    const parsed = cellSpecSchema.safeParse(spec);
    if (!parsed.success) throw new InvalidCellRequest("createCell", issuesOf(parsed.error));
    const hostPath = await this.canonicalMountPath(parsed.data.mount.hostPath);
    const masks: Mask[] = [];
    for (const entry of parsed.data.mount.maskedEntries ?? []) {
      masks.push({ entry, source: await this.maskSource(await this.plainEntryKind(hostPath, entry)) });
    }
    const name = `ashara-cell-${randomUUID()}`;
    const args = buildRunArgs(parsed.data, name, hostPath, masks);
    const result = await this.run(args);
    const id = result.exitCode === 0 ? containerIdSchema.safeParse(result.stdout.trim()) : null;
    if (id === null || !id.success) {
      // podman run can create the container and then fail to start it (or print no id): the
      // container may exist, so it is removed by the name this call gave it, or kept for teardownAll.
      const cleanup = await this.removeFailedStart(name);
      const stderr =
        result.exitCode === 0 ? `podman run printed no container id: ${JSON.stringify(result.stdout)}; ${result.stderr}` : result.stderr;
      throw new CellStartFailed(args, result.exitCode, stderr, cleanup);
    }
    const cell = new PodmanCell(id.data, parsed.data, this);
    this.cells.set(id.data, cell);
    return cell;
  }

  /** realpath, then a prefix check against the realpath of mountRoot; the result must still be a valid volume source. */
  private async canonicalMountPath(hostPath: string): Promise<string> {
    let root: string;
    let canonical: string;
    try {
      root = await realpath(this.mountRoot);
    } catch (err) {
      throw new MountPathRejected(hostPath, null, this.mountRoot, `the mount root cannot be resolved: ${messageOf(err)}`, { cause: err });
    }
    try {
      canonical = await realpath(hostPath);
    } catch (err) {
      throw new MountPathRejected(hostPath, null, root, `the path cannot be resolved: ${messageOf(err)}`, { cause: err });
    }
    if (canonical === root || !canonical.startsWith(`${root}${sep}`)) {
      throw new MountPathRejected(hostPath, canonical, root, "it is not strictly inside the mount root");
    }
    const masks = join(root, MASK_DIR);
    if (canonical === masks || canonical.startsWith(`${masks}${sep}`)) {
      throw new MountPathRejected(hostPath, canonical, root, "it is the substrate's own mask stand-ins");
    }
    const source = cellSpecSchema.shape.mount.shape.hostPath.safeParse(canonical);
    if (!source.success) {
      throw new MountPathRejected(hostPath, canonical, root, `the resolved path is not a valid volume source: ${issuesOf(source.error).join("; ")}`);
    }
    return canonical;
  }

  /**
   * A masked entry is covered at its own in-cell path, so a symlink there would have the stand-in
   * mounted wherever it points; only a plain file or directory is masked.
   */
  private async plainEntryKind(canonicalHostPath: string, entry: string): Promise<MaskKind> {
    const path = `${canonicalHostPath}${sep}${entry}`;
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (err) {
      throw new MountPathRejected(path, null, canonicalHostPath, `the masked entry cannot be resolved: ${messageOf(err)}`, { cause: err });
    }
    if (canonical !== path) {
      throw new MountPathRejected(path, canonical, canonicalHostPath, "the masked entry is a symlink or resolves elsewhere");
    }
    const entryStat = await lstat(path);
    if (entryStat.isFile()) return "file";
    if (entryStat.isDirectory()) return "directory";
    throw new MountPathRejected(path, canonical, canonicalHostPath, "the masked entry is neither a regular file nor a directory");
  }

  /**
   * The empty, read-only stand-in of `kind` under the mount root (made once, shared by every
   * cell). One that exists but is not empty, or not of its kind, is refused rather than mounted.
   */
  private async maskSource(kind: MaskKind): Promise<string> {
    let root: string;
    try {
      root = await realpath(this.mountRoot);
    } catch (err) {
      throw new MountPathRejected(this.mountRoot, null, this.mountRoot, `the mount root cannot be resolved: ${messageOf(err)}`, { cause: err });
    }
    const dir = join(root, MASK_DIR);
    const source = join(dir, kind === "file" ? "empty-file" : "empty-directory");
    try {
      await mkdir(dir, { recursive: true });
      if (kind === "file") await writeFile(source, "", { flag: "wx", mode: 0o444 });
      else await mkdir(source, { mode: 0o555 });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) {
        throw new MountPathRejected(source, null, root, `the mask stand-in cannot be created: ${messageOf(err)}`, { cause: err });
      }
    }
    const made = await lstat(source);
    const empty = kind === "file" ? made.isFile() && made.size === 0 : made.isDirectory() && (await readdir(source)).length === 0;
    if (!empty) throw new MountPathRejected(source, null, root, `the mask stand-in is not an empty ${kind}`);
    return source;
  }

  private async removeFailedStart(name: string): Promise<string> {
    try {
      const removal = await this.run(["rm", "-f", "--ignore", name]);
      if (removal.exitCode === 0) return `any container named ${name} was removed`;
      this.unconfirmed.add(name);
      return `removing a container named ${name} failed (exit ${removal.exitCode ?? "none"}: ${removal.stderr.trim() || "no stderr"}); it stays tracked for teardownAll`;
    } catch (err) {
      this.unconfirmed.add(name);
      return `removing a container named ${name} failed (${messageOf(err)}); it stays tracked for teardownAll`;
    }
  }

  /** @internal used by PodmanCell.teardown and reconcileOrphans. */
  async removeContainer(id: string): Promise<void> {
    let result: ProcessResult;
    try {
      result = await this.run(["rm", "-f", id]);
    } catch (err) {
      throw new CellTeardownFailed(id, null, "", { cause: err });
    }
    if (result.exitCode !== 0) throw new CellTeardownFailed(id, result.exitCode, result.stderr);
  }

  /** @internal */
  forget(id: string): void {
    this.cells.delete(id);
  }

  /**
   * Removes every container labelled ashara.managed=1 AND ashara.instance=<instance>, except the
   * cells this process still holds. Never selects by name: other services share this podman.
   */
  async reconcileOrphans(instance: string): Promise<string[]> {
    const parsedInstance = labelValue.safeParse(instance);
    if (!parsedInstance.success) throw new InvalidCellRequest("reconcileOrphans", issuesOf(parsedInstance.error));
    const args = [
      "ps", "-a",
      "--filter", `label=${LABEL_MANAGED}=1`,
      "--filter", `label=${LABEL_INSTANCE}=${instance}`,
      "--format", "json",
    ];
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new PodmanCommandFailed("ps", args, result.exitCode, result.stderr.trim() || "(no stderr)");
    }
    const json = parseJson(result.stdout);
    if (!json.ok) throw new PodmanCommandFailed("ps", args, result.exitCode, `invalid JSON: ${json.error}`);
    const entries = z.array(psEntrySchema).safeParse(json.value);
    if (!entries.success) {
      throw new PodmanCommandFailed("ps", args, result.exitCode, `unexpected shape: ${issuesOf(entries.error).join("; ")}`);
    }
    // The label filter is the selector; re-checking it here means a change in podman's filter
    // semantics refuses to delete rather than deleting someone else's container.
    const foreign = entries.data.filter(
      (entry) => entry.Labels?.[LABEL_MANAGED] !== "1" || entry.Labels[LABEL_INSTANCE] !== instance,
    );
    if (foreign.length > 0) {
      throw new PodmanCommandFailed(
        "ps",
        args,
        result.exitCode,
        `the label filter returned ${foreign.length} container(s) without both labels (${foreign.map((e) => e.Id).join(", ")}); refusing to remove anything`,
      );
    }
    const orphans = entries.data.map((entry) => entry.Id).filter((id) => !this.cells.has(id));
    return this.removeAll("reconcileOrphans", orphans);
  }

  /** Removes every cell this process created and still holds, and any container a failed start left. */
  async teardownAll(): Promise<string[]> {
    const removed: string[] = [];
    const failures: CellTeardownFailed[] = [];
    for (const cell of [...this.cells.values()]) {
      try {
        await cell.teardown();
        removed.push(cell.id);
      } catch (err) {
        if (!(err instanceof CellTeardownFailed)) throw err;
        failures.push(err);
      }
    }
    for (const name of [...this.unconfirmed]) {
      try {
        const result = await this.run(["rm", "-f", "--ignore", name]);
        if (result.exitCode !== 0) throw new CellTeardownFailed(name, result.exitCode, result.stderr);
        this.unconfirmed.delete(name);
        removed.push(name);
      } catch (err) {
        failures.push(err instanceof CellTeardownFailed ? err : new CellTeardownFailed(name, null, "", { cause: err }));
      }
    }
    if (failures.length > 0) throw new TeardownIncomplete("teardownAll", removed, failures);
    return removed;
  }

  private async removeAll(operation: string, ids: readonly string[]): Promise<string[]> {
    const removed: string[] = [];
    const failures: CellTeardownFailed[] = [];
    for (const id of ids) {
      try {
        await this.removeContainer(id);
        removed.push(id);
      } catch (err) {
        if (!(err instanceof CellTeardownFailed)) throw err;
        failures.push(err);
      }
    }
    if (failures.length > 0) throw new TeardownIncomplete(operation, removed, failures);
    return removed;
  }
}
