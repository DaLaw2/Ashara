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
 * Shell functions every exec wrapper and the standalone sweep share. They use only the POSIX
 * shell's builtins (read, set, case, kill, globbing) and the cell's /proc, never a tool the image
 * might lack. `ashara_stat DIR` reads DIR/stat into ashara_state and ashara_sid (the comm field may
 * hold ") ", so the longest prefix through ") " is dropped). `ashara_sweep` SIGKILLs every live
 * process outside the session of the cell's init (the init and its keepalive), except the
 * sweeping shell itself, round after round until none is left; it fails after 50 rounds.
 */
const SWEEP_FUNCTIONS = [
  'ashara_stat() { ashara_l=; read -r ashara_l 2>/dev/null < "$1/stat" || return 1; set -- ${ashara_l##*) }; ashara_state=$1; ashara_sid=$4; }',
  "ashara_sweep() {",
  "  ashara_stat /proc/1 || return 1; ashara_keep=$ashara_sid; ashara_round=0",
  '  while [ "$ashara_round" -lt 50 ]; do',
  "    ashara_live=0",
  "    for ashara_d in /proc/[0-9]*; do",
  '      [ "$ashara_d" = "/proc/$$" ] && continue',
  '      ashara_stat "$ashara_d" || continue',
  "      case $ashara_state in Z|X|x) continue;; esac",
  '      [ "$ashara_sid" = "$ashara_keep" ] && continue',
  "      ashara_live=1",
  '      kill -9 "${ashara_d#/proc/}" 2>/dev/null',
  "    done",
  '    [ "$ashara_live" = 0 ] && return 0',
  "    ashara_round=$((ashara_round + 1))",
  "  done",
  "  return 1",
  "}",
];

/**
 * The runtime starts every exec in a session of its own (observed with crun under podman 5.8.2:
 * an exec's first process has session id = its pid), apart from the init's. The sweep relies on
 * that, so the wrapper checks it before running anything and fails closed otherwise.
 */
const ISOLATION_CHECK = 'ashara_stat "/proc/$$" && [ "$ashara_sid" = "$$" ] && [ "$$" != 1 ]';

/**
 * Every exec runs `sh -c EXEC_WRAPPER ashara-exec <grace> <seconds> <argv...>` with podman's
 * --preserve-fds=1, so the host's fourth pipe is fd 3 in the cell. The wrapper runs
 * `timeout -k <grace> <seconds> argv` with fd 3 closed, sweeps the cell, then writes the
 * command's exit status to fd 3. A command's own status therefore arrives on a channel closed to
 * the command and beyond the output caps, and an exit with no report is podman's or the wrapper's
 * own failure: exit codes alone cannot tell them apart, since 125 is both podman exec's own
 * failure and a status any command may return.
 *
 * timeout(1) sits inside the wrapper, never around it, and its child is argv itself. timeout(1)
 * does not end what argv started: busybox's (alpine:3.20) signals only its direct child and
 * leaves its own watcher, in a session of its own, waiting out the grace; GNU's signals argv's
 * process group, which a command can leave. So once argv ends, by itself or by timeout, the
 * wrapper sweeps the cell: every process outside the init's session is killed, whatever session
 * or group it moved to. A cell's execs are serialized (PodmanCell.exec), so nothing a sweep
 * kills belongs to another live exec: the cell holds only what runs now. A sweep that leaves a
 * process alive reports `unswept <status>`; an exec that is not its own session reports
 * `unisolated` and runs nothing. A missing timeout(1) exits without a report.
 */
const EXEC_WRAPPER = [
  ...SWEEP_FUNCTIONS,
  `${ISOLATION_CHECK} || { echo "ashara-exec: the exec is not a session of its own in the cell" >&2; printf 'unisolated\\n' >&3; exit 125; }`,
  "command -v timeout >/dev/null 2>&1 || { echo \"ashara-exec: timeout(1) is not on the cell's PATH\" >&2; exit 127; }",
  'k=$1; t=$2; shift 2; timeout -k "$k" "$t" "$@" 3>&-; ashara_s=$?',
  "ashara_sweep || { printf 'unswept %s\\n' \"$ashara_s\" >&3; exit \"$ashara_s\"; }",
  "printf '%s\\n' \"$ashara_s\" >&3; exit \"$ashara_s\"",
].join("\n");

/** Run on its own when the wrapper could not sweep: exit 0 only once nothing but the init's session is left. */
const SWEEP_SCRIPT = [...SWEEP_FUNCTIONS, `${ISOLATION_CHECK} || exit 125`, "ashara_sweep"].join("\n");
const EXEC_WRAPPER_NAME = "ashara-exec";
const exitStatusSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})$/)
  .transform(Number)
  .refine((status) => status <= 255);

type StatusReport =
  | { readonly kind: "exited"; readonly status: number }
  | { readonly kind: "unswept"; readonly status: number }
  | { readonly kind: "unisolated" };

/** The wrapper's one line on fd 3; null when it is none of the three the wrapper writes. */
function parseStatusReport(report: string | null): StatusReport | null {
  if (report === null) return null;
  if (report === "unisolated\n") return { kind: "unisolated" };
  const match = /^(unswept )?([^\n]*)\n$/.exec(report);
  if (match === null) return null;
  const status = exitStatusSchema.safeParse(match[2]);
  if (!status.success) return null;
  return match[1] === undefined ? { kind: "exited", status: status.data } : { kind: "unswept", status: status.data };
}

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
  private lane: Promise<void> = Promise.resolve();

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
    // One exec at a time: each one's sweep kills every process in the cell outside the init's
    // session, which would include a concurrent exec's. The lane only orders; each caller gets its
    // own exec's outcome from `run`.
    const run = this.lane.then(() => this.execAlone(argv, options));
    this.lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execAlone(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
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
      // The podman client hung past every in-cell bound, so the wrapper may never have swept:
      // the cell is swept from a fresh exec before the timeout is reported.
      await this.sweep(argv);
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
    const report = parseStatusReport(result.statusReport);
    if (report === null) {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `the in-cell wrapper's status report is malformed: ${JSON.stringify(result.statusReport)}`,
      );
    }
    if (report.kind === "unisolated") {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        "the exec is not a session of its own in the cell, so what the command would start could not be told " +
          "from the cell's own processes; the command was not run",
      );
    }
    if (report.kind === "unswept") {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `the command exited ${report.status}, but processes it left in the cell were still alive after the wrapper's sweep`,
      );
    }
    if (report.status !== exitCode) {
      throw new CellExecFailed(
        this.id,
        argv,
        exitCode,
        result.stderr,
        `the command exited ${report.status} in the cell but podman exec exited ${exitCode}`,
      );
    }
    if (TIMEOUT_EXITS.has(exitCode) && elapsedMs >= options.timeoutSeconds * 1000) {
      return { ...streams(result), exitCode, timedOut: true };
    }
    return { ...streams(result), exitCode, timedOut: false };
  }

  /** Kills every process outside the init's session from an exec of its own; throws unless none is left. */
  private async sweep(argv: readonly string[]): Promise<void> {
    let result: ProcessResult;
    try {
      result = await this.substrate.run(["exec", this.id, "sh", "-c", SWEEP_SCRIPT, "ashara-sweep"]);
    } catch (err) {
      throw new CellExecFailed(this.id, argv, null, "", "the host backstop ended the exec and the cell could not be swept", { cause: err });
    }
    if (result.exitCode !== 0) {
      throw new CellExecFailed(
        this.id,
        argv,
        result.exitCode,
        result.stderr,
        "the host backstop ended the exec and sweeping the cell afterwards failed: what the command started may still run",
      );
    }
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
