import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { cellLimitsSchema, readCellLimits, runLimitArgs, type CellResourceLimits } from "./cell-limits.js";
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
import { snapshotRepository } from "./host-git.js";
import { spawnProcess, type ProcessRequest, type ProcessResult, type ProcessRunner, type StreamCut } from "./process-runner.js";
import { WORKSPACE_ROOT, toWorkspaceAbsolute } from "./workspace-path.js";

const LABEL_MANAGED = "ashara.managed";
const LABEL_INSTANCE = "ashara.instance";
const LABEL_PROJECT = "ashara.project";
const LABEL_TASK = "ashara.task";
const LABEL_ROLE = "ashara.role";

/**
 * Under the mount root, by instance and cell name: each cell's own state (its home, its throwaway
 * repository), made before the cell starts and removed with it. No cell may mount it as its tree.
 */
const STATE_DIR = ".ashara-cell-state";
/** Under the mount root: the read-only gitlink every cell whose tree's `.git` is a file sees there. No cell may mount it as its tree. */
const GITLINK_STAND_IN = ".ashara-cell-gitlink";
/** In the cell: its writable home, and its throwaway repository when the tree's `.git` is a gitlink file. */
const CELL_HOME = "/ashara-cell/home";
const CELL_GIT_DIR = "/ashara-cell/git";
const GITLINK_TEXT = `gitdir: ${CELL_GIT_DIR}\n`;
type GitEntryKind = "file" | "directory";

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
/** A shell reports a process a signal ended as 128 + the signal's number, so only an exit above this is one. */
const SIGNAL_EXIT_FLOOR = 128;

/** When the host kills a `podman exec` whose in-cell timeout is `timeoutSeconds`. */
function execKillAfterMs(timeoutSeconds: number): number {
  return (timeoutSeconds + KILL_GRACE_SECONDS + HOST_BACKSTOP_SECONDS) * 1000;
}

/**
 * The longest one cell can take with every podman call ended at its own kill bound: its create,
 * an exec at each of `execTimeoutsSeconds` with the fresh-exec sweep that can follow one, and its
 * teardown. Host-side file work around them (the cell's state dir) is not counted.
 */
export function cellRunBoundMs(execTimeoutsSeconds: readonly number[]): number {
  const execs = execTimeoutsSeconds.reduce((sum, seconds) => sum + execKillAfterMs(seconds) + PODMAN_ADMIN_TIMEOUT_MS, 0);
  return 2 * PODMAN_ADMIN_TIMEOUT_MS + execs;
}

/**
 * Shell functions every exec wrapper and the standalone sweep share. They use only the POSIX
 * shell's builtins (read, set, case, kill, globbing) and the cell's /proc, never a tool the image
 * might lack. `ashara_stat DIR` reads DIR/stat into ashara_state, ashara_ppid and ashara_sid (the
 * comm field may hold ") ", so the longest prefix through ") " is dropped). `ashara_sweep` SIGKILLs
 * every live process outside the session of the cell's init (the init and its keepalive), except
 * the sweeping shell and its ancestors in the cell, round after round until none is left; it fails
 * after 50 rounds. The ancestors are what runs the sweep, never what the command started: a process
 * cannot become an ancestor of one that already runs. podman's exec process has none (its parent
 * is outside the cell); a shell that runs the wrapper as its child has one, and killing it would
 * lose the exec's own exit.
 */
const SWEEP_FUNCTIONS = [
  'ashara_stat() { ashara_l=; read -r ashara_l 2>/dev/null < "$1/stat" || return 1; set -- ${ashara_l##*) }; ashara_state=$1; ashara_ppid=$2; ashara_sid=$4; }',
  "ashara_sweep() {",
  "  ashara_stat /proc/1 || return 1; ashara_keep=$ashara_sid; ashara_round=0",
  '  ashara_spare=" $$ "; ashara_p=$$',
  '  while ashara_stat "/proc/$ashara_p" && [ "$ashara_ppid" -gt 1 ]; do ashara_p=$ashara_ppid; ashara_spare="$ashara_spare$ashara_p "; done',
  '  while [ "$ashara_round" -lt 50 ]; do',
  "    ashara_live=0",
  "    for ashara_d in /proc/[0-9]*; do",
  '      case $ashara_spare in *" ${ashara_d#/proc/} "*) continue;; esac',
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
 * The sweep spares the init's session, so what the command starts must never be in it: the wrapper
 * runs nothing unless its own session is not the init's. A process leaves its session only for a
 * new one it leads, whose id is its own pid and so never the init's; everything the command starts
 * is therefore outside the init's session too. Runtimes differ in which session that is: crun 1.27
 * (podman 5.8.2) starts an exec in a session of its own, its id the exec's pid; crun 1.14.1 and 1.17
 * leave it in the caller's session, outside the cell's pid namespace, so /proc shows session id 0
 * while the init's is 1. Both are apart from the init's. A session id 0 is refused when the init's
 * is 0 too, since two sessions outside the cell cannot be told apart.
 */
const ISOLATION_CHECK = 'ashara_stat /proc/1 && ashara_init_sid=$ashara_sid && ashara_stat "/proc/$$" && [ "$ashara_sid" != "$ashara_init_sid" ] && [ "$$" != 1 ]';

/**
 * Every exec runs `sh -c EXEC_WRAPPER ashara-exec <grace> <seconds>` with podman's
 * --preserve-fds=1, so the host's fourth pipe is fd 3 in the cell. argv reaches the wrapper
 * through its environment (ASHARA_ARGC, ASHARA_ARG_<i>), never its own command line: a command
 * that kills by pattern (`pkill -f`, `kill $(pgrep -f ...)`) matches the command lines of the
 * processes it finds, and the wrapper's must not carry the command's text (M2 trial M1). The
 * wrapper rebuilds argv and unsets those variables before argv runs. The wrapper runs
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
 * process alive reports `unswept <status>`; an exec whose session cannot be told from the init's
 * reports `unisolated` and runs nothing; one that cannot run argv (no timeout(1) on the PATH, no argv in
 * its environment) reports `unrunnable` and runs nothing. A wrapper that dies before it reports,
 * killed by the command it runs or by the loss of the cell, leaves no report: PodmanCell tells the
 * two apart by sweeping the cell from a fresh exec.
 */
const ARGC_VARIABLE = "ASHARA_ARGC";
const ARG_VARIABLE_PREFIX = "ASHARA_ARG_";
const EXEC_WRAPPER = [
  ...SWEEP_FUNCTIONS,
  `${ISOLATION_CHECK} || { echo "ashara-exec: the exec's session cannot be told from the session of the cell's init" >&2; printf 'unisolated\\n' >&3; exit 125; }`,
  "command -v timeout >/dev/null 2>&1 || { echo \"ashara-exec: timeout(1) is not on the cell's PATH\" >&2; printf 'unrunnable\\n' >&3; exit 127; }",
  String.raw`case $ASHARA_ARGC in ''|*[!0-9]*|0) echo "ashara-exec: no argv in ASHARA_ARGC" >&2; printf 'unrunnable\n' >&3; exit 125;; esac`,
  'k=$1; t=$2; set --; ashara_i=0',
  String.raw`while [ "$ashara_i" -lt "$ASHARA_ARGC" ]; do eval "set -- \"\$@\" \"\$ASHARA_ARG_$ashara_i\"; unset ASHARA_ARG_$ashara_i"; ashara_i=$((ashara_i + 1)); done`,
  'unset ASHARA_ARGC ashara_i; timeout -k "$k" "$t" "$@" 3>&-; ashara_s=$?',
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
  | { readonly kind: "unisolated" }
  | { readonly kind: "unrunnable" };

/** The wrapper's one line on fd 3; null when it is none of the four the wrapper writes. */
function parseStatusReport(report: string | null): StatusReport | null {
  if (report === null) return null;
  if (report === "unisolated\n") return { kind: "unisolated" };
  if (report === "unrunnable\n") return { kind: "unrunnable" };
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

/** The instance also names a directory under the state dir, which is a volume source: no ':', and not '.' or '..'. */
const instanceValue = labelValue
  .refine((value) => !value.includes(":"), "the instance may not contain ':'")
  .refine((value) => value !== "." && value !== "..", "the instance may not be '.' or '..'");

const cellSpecSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .regex(/^[^\s-][^\s]*$/, "an image reference may not start with '-' or contain whitespace"),
    project: labelValue,
    task: labelValue,
    role: labelValue,
    instance: instanceValue,
    mount: z
      .object({
        hostPath: z
          .string()
          .regex(/^\/[^:,\0\n]*$/, "hostPath must be absolute and free of ':', ',', NUL and newline"),
        readOnly: z.boolean().optional(),
        shared: z.boolean().optional(),
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
  };
}

/*
 * What every cell sees besides its tree (ADR-074 addendum 2 d73), with no option to leave it out:
 * - It runs as the host's uid (--userns=keep-id), not root, with HOME set to a writable, empty
 *   directory of its own (CELL_HOME); the image's HOME, if any, is overridden.
 * - When hostPath holds a `.git` (a worktree's gitlink file, or a checkout's git dir), the cell
 *   never sees it: in its place is a throwaway repository of the cell's own, made by Z0 before the
 *   cell starts, whose one commit holds the tree's content (snapshotRepository). It has no remote,
 *   no host ref, object, config, hook or history, and names no host path. A gitlink file is covered
 *   by a read-only gitlink naming CELL_GIT_DIR, where the repository is mounted; a git dir is
 *   covered by the repository itself. Z0 never reads that repository once the cell started, and
 *   removes it with the cell, so whatever the cell writes there stays there. A `.git` that is a
 *   symlink, or neither a file nor a directory, refuses the cell.
 */

interface ExecOptions {
  readonly stdin?: string | Buffer;
  readonly timeoutSeconds: number;
  /** Workspace-relative working directory; policy default is the workspace root. */
  readonly cwd?: string;
}

export interface ExecResult {
  /**
   * null when the host backstop killed the podman client (then timedOut is true), or when the
   * command's status was lost in a cell that stayed healthy (then statusLost is true).
   */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /**
   * The wrapper died by a signal (podman exec exited above 128) before it reported the command's
   * status, and a sweep from a fresh exec then
   * found the cell answering and left it clean: what killed the wrapper ran in the cell, where only
   * the command ran. The command's own result, its exit status unknown: exitCode is null.
   */
  readonly statusLost: boolean;
  /** Where the middle of stdout was cut past the output cap, and how many characters; null when it is whole. */
  readonly stdoutCut: StreamCut | null;
  readonly stderrCut: StreamCut | null;
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
  /**
   * The caps every cell and every image build runs under. Absent, they are read from the process
   * environment (readCellLimits: ASHARA_CELL_MEMORY, ASHARA_CELL_CPUS, ASHARA_CELL_PIDS_LIMIT), and
   * the constructor throws CellLimitsInvalid when one is unset: there is no limit in code.
   */
  readonly limits?: CellResourceLimits;
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


function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: describeErrorChain(err) };
  }
}

/** A cell's own state on the host, as the run mounts it. */
interface CellState {
  readonly dir: string;
  readonly home: string;
  /** Null when the tree holds no `.git`; `gitlink` is the stand-in covering a gitlink file. */
  readonly repository:
    | { readonly covers: "directory"; readonly gitDir: string }
    | { readonly covers: "file"; readonly gitDir: string; readonly gitlink: string }
    | null;
}

function buildRunArgs(spec: CellSpec, name: string, hostPath: string, state: CellState, limits: CellResourceLimits): string[] {
  const label = spec.mount.shared === true ? "z" : "Z";
  const options = [...(spec.mount.readOnly === true ? ["ro"] : []), label].join(",");
  // The state is the cell's alone (private label); the gitlink stand-in is every cell's (shared label).
  const repository = state.repository;
  const repositoryMounts =
    repository === null
      ? []
      : repository.covers === "directory"
        ? ["-v", `${repository.gitDir}:${WORKSPACE_ROOT}/.git:Z`]
        : ["-v", `${repository.gitlink}:${WORKSPACE_ROOT}/.git:ro,z`, "-v", `${repository.gitDir}:${CELL_GIT_DIR}:Z`];
  return [
    "run",
    "-d",
    "--name", name,
    "--init",
    "--pull=never",
    "--network=none",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    ...runLimitArgs(limits),
    "--userns=keep-id",
    "--label", `${LABEL_MANAGED}=1`,
    "--label", `${LABEL_INSTANCE}=${spec.instance}`,
    "--label", `${LABEL_PROJECT}=${spec.project}`,
    "--label", `${LABEL_TASK}=${spec.task}`,
    "--label", `${LABEL_ROLE}=${spec.role}`,
    "-e", `HOME=${CELL_HOME}`,
    "-v", `${hostPath}:${WORKSPACE_ROOT}:${options}`,
    "-v", `${state.home}:${CELL_HOME}:Z`,
    ...repositoryMounts,
    spec.image,
    "sleep", "infinity",
  ];
}

class PodmanCell implements Cell {
  private tornDown = false;
  private containerRemoved = false;
  private lane: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly spec: CellSpec,
    /** The container name, which also names the cell's state dir. */
    readonly name: string,
    private readonly stateDir: string,
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
    if (this.tornDown || this.containerRemoved) throw new CellExecFailed(this.id, argv, null, "", "the cell has been torn down");

    const workdir = toWorkspaceAbsolute(options.cwd ?? ".");
    const argvEnvironment = [`${ARGC_VARIABLE}=${argv.length}`, ...argv.map((arg, i) => `${ARG_VARIABLE_PREFIX}${i}=${arg}`)];
    const args = [
      "exec", "-i", "--preserve-fds=1", "-w", workdir,
      ...argvEnvironment.flatMap((variable) => ["-e", variable]),
      this.id,
      "sh", "-c", EXEC_WRAPPER, EXEC_WRAPPER_NAME, String(KILL_GRACE_SECONDS), String(options.timeoutSeconds),
    ];
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.substrate.run(args, {
        stdin: options.stdin,
        killAfterMs: execKillAfterMs(options.timeoutSeconds),
        statusChannel: true,
      });
    } catch (err) {
      throw new CellExecFailed(this.id, argv, null, "", "the substrate could not run podman exec", { cause: err });
    }
    const elapsedMs = Date.now() - startedAt;

    if (result.killedByHost) {
      // The podman client hung past every in-cell bound, so the wrapper may never have swept:
      // the cell is swept from a fresh exec before the timeout is reported.
      await this.sweep(argv, "the host backstop ended the exec");
      return { ...streams(result), exitCode: null, timedOut: true, statusLost: false };
    }
    if (result.exitCode === null) {
      throw new CellExecFailed(this.id, argv, null, result.stderr, `podman exec ended by signal ${result.signal ?? "unknown"}`);
    }
    const exitCode = result.exitCode;
    if (options.stdin !== undefined && result.stdinError !== null) {
      throw new CellExecFailed(this.id, argv, exitCode, result.stderr, `stdin was not fully delivered: ${result.stdinError}`);
    }
    if (result.statusReport === "") {
      // The wrapper never reported: podman exec or the wrapper's sh failed, the cell was lost
      // mid-run, or the command killed the wrapper (M2 trial M1). Only the last leaves a cell that
      // answers a fresh exec, whose sweep also ends what the command left that the dead wrapper
      // never swept. timeout(1) never ends the wrapper.
      const unreported = `podman exec exited ${exitCode} and the in-cell wrapper reported no status for the command`;
      if (exitCode <= SIGNAL_EXIT_FLOOR) {
        // A wrapper killed by a signal exits above 128 (the trial's was 137). Anything else is podman
        // or the OCI runtime failing before the wrapper ran (125-127) or the wrapper's sh itself:
        // the substrate's failure, which a cell that still answers a probe does not change.
        throw new CellExecFailed(
          this.id,
          argv,
          exitCode,
          result.stderr,
          `${unreported}; an exit of ${SIGNAL_EXIT_FLOOR} or below is not a wrapper killed by a signal: podman exec or the wrapper's sh failed`,
        );
      }
      try {
        await this.sweep(argv, unreported);
      } catch (probe) {
        throw new CellExecFailed(
          this.id,
          argv,
          exitCode,
          result.stderr,
          `${unreported}, and the cell then failed its probe: podman exec, the wrapper's sh or the cell itself failed ` +
            `(${describeErrorChain(probe)})`,
          { cause: probe },
        );
      }
      return { ...streams(result), exitCode: null, timedOut: false, statusLost: true };
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
        "the exec's session cannot be told from the session of the cell's init, so what the command would start " +
          "could not be told from the cell's own processes; the command was not run",
      );
    }
    if (report.kind === "unrunnable") {
      throw new CellExecFailed(this.id, argv, exitCode, result.stderr, "the in-cell wrapper could not run the command; the command was not run");
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
      return { ...streams(result), exitCode, timedOut: true, statusLost: false };
    }
    return { ...streams(result), exitCode, timedOut: false, statusLost: false };
  }

  /**
   * Kills every process outside the init's session from an exec of its own; throws unless none is
   * left. It is the cell's health probe too: it passes only in a cell that answers an exec. `why`
   * names what led to the sweep, for the error.
   */
  private async sweep(argv: readonly string[], why: string): Promise<void> {
    let result: ProcessResult;
    try {
      result = await this.substrate.run(["exec", this.id, "sh", "-c", SWEEP_SCRIPT, "ashara-sweep"]);
    } catch (err) {
      throw new CellExecFailed(this.id, argv, null, "", `${why}, and the cell could not be swept`, { cause: err });
    }
    if (result.exitCode !== 0) {
      throw new CellExecFailed(
        this.id,
        argv,
        result.exitCode,
        result.stderr,
        `${why}, and sweeping the cell afterwards failed: the cell is lost, or what the command started may still run`,
      );
    }
  }

  /** The container first, then the state it mounted; a cell stays held until both are gone. */
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    if (!this.containerRemoved) {
      await this.substrate.removeContainer(this.id);
      this.containerRemoved = true;
    }
    try {
      await removeTree(this.stateDir);
    } catch (err) {
      throw new CellTeardownFailed(this.id, null, `the cell's state dir ${JSON.stringify(this.stateDir)} could not be removed: ${describeErrorChain(err)}`, {
        cause: err,
      });
    }
    this.tornDown = true;
    this.substrate.forget(this.id);
  }
}

function streams(result: ProcessResult): Pick<ExecResult, "stdout" | "stderr" | "stdoutCut" | "stderrCut"> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutCut: result.stdoutCut,
    stderrCut: result.stderrCut,
  };
}

function errorCode(err: unknown): unknown {
  return err instanceof Error && "code" in err ? err.code : undefined;
}

/**
 * rm -rf that also removes what a cell left unwritable (a read-only directory, as some caches make
 * theirs): on EACCES/EPERM every directory under `path` is made writable, never following a symlink,
 * and the removal runs once more. Every file is the host uid's (--userns=keep-id).
 */
async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = errorCode(err);
    if (code !== "EACCES" && code !== "EPERM") throw err;
  }
  await makeDirectoriesWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  if (!entry.isDirectory()) return;
  await chmod(path, 0o700);
  for (const child of await readdir(path)) await makeDirectoriesWritable(join(path, child));
}

export class PodmanSubstrate {
  private readonly podmanPath: string;
  private readonly runner: ProcessRunner;
  private readonly maxOutputBytes: number;
  private readonly mountRoot: string;
  private readonly limits: CellResourceLimits;
  private readonly cells = new Map<string, PodmanCell>();
  /** Containers a failed `podman run` may have left behind and that could not be removed yet, by name. */
  private readonly unconfirmed = new Set<string>();
  /** Names of cells whose state is being made or whose start is in flight: no sweep removes their state. */
  private readonly starting = new Set<string>();
  /** Instances this process made cell state for: teardownAll sweeps their state dirs. */
  private readonly instances = new Set<string>();

  constructor(options: PodmanSubstrateOptions) {
    const issues: string[] = [];
    if (options.podmanPath === "") issues.push("podmanPath must not be empty");
    if (!isAbsolute(options.mountRoot)) issues.push(`mountRoot must be an absolute path, got ${JSON.stringify(options.mountRoot)}`);
    const limits = cellLimitsSchema.safeParse(options.limits ?? readCellLimits(process.env));
    if (!limits.success) issues.push(...issuesOf(limits.error).map((issue) => `limits.${issue}`));
    if (issues.length > 0 || !limits.success) throw new InvalidCellRequest("substrate", issues);
    this.limits = limits.data;
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

  /** The caps every container this substrate starts runs under, cells and image builds alike. */
  resourceLimits(): CellResourceLimits {
    return this.limits;
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
    const gitEntry = await this.gitEntryKind(hostPath);
    const name = `ashara-cell-${randomUUID()}`;
    this.starting.add(name);
    try {
      const state = await this.prepareState(parsed.data.instance, name, hostPath, gitEntry);
      const args = buildRunArgs(parsed.data, name, hostPath, state, this.limits);
      let result: ProcessResult;
      try {
        result = await this.run(args);
      } catch (err) {
        // podman never ran, or its client failed: no container holds the state, which goes now or
        // with the next sweep (teardownAll, reconcileOrphans), and the substrate's own error stands.
        await this.discardState(state.dir);
        throw err;
      }
      const id = result.exitCode === 0 ? containerIdSchema.safeParse(result.stdout.trim()) : null;
      if (id === null || !id.success) {
        // podman run can create the container and then fail to start it (or print no id): the
        // container may exist, so it is removed by the name this call gave it, or kept for teardownAll.
        const cleanup = `${await this.removeFailedStart(name)}; ${await this.discardState(state.dir)}`;
        const stderr =
          result.exitCode === 0 ? `podman run printed no container id: ${JSON.stringify(result.stdout)}; ${result.stderr}` : result.stderr;
        throw new CellStartFailed(args, result.exitCode, stderr, cleanup);
      }
      const cell = new PodmanCell(id.data, parsed.data, name, state.dir, this);
      this.cells.set(id.data, cell);
      return cell;
    } finally {
      this.starting.delete(name);
    }
  }

  private stateRoot(): string {
    return join(this.mountRoot, STATE_DIR);
  }

  /**
   * The cell's state dir with an empty home and, when the tree holds a `.git`, its throwaway
   * repository. A snapshot that fails is a cell that could not start (CellStartFailed); its state
   * is removed first.
   */
  private async prepareState(instance: string, name: string, hostPath: string, gitEntry: GitEntryKind | null): Promise<CellState> {
    const dir = join(await this.canonicalRoot(hostPath), STATE_DIR, instance, name);
    const home = join(dir, "home");
    const gitDir = join(dir, "git");
    this.instances.add(instance);
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      if (gitEntry === null) return { dir, home, repository: null };
      await snapshotRepository(hostPath, gitDir);
      if (gitEntry === "directory") return { dir, home, repository: { covers: "directory", gitDir } };
      return { dir, home, repository: { covers: "file", gitDir, gitlink: await this.gitlinkStandIn() } };
    } catch (err) {
      const cleanup = await this.discardState(dir);
      if (err instanceof MountPathRejected) throw err;
      throw new CellStartFailed([], null, `the cell's state could not be prepared: ${describeErrorChain(err)}`, `no container was created; ${cleanup}`, {
        cause: err,
      });
    }
  }

  /** Removes a cell's state; what cannot be removed now is left to the next sweep, and said so. */
  private async discardState(dir: string): Promise<string> {
    try {
      await removeTree(dir);
      return "its state dir was removed";
    } catch (err) {
      return `its state dir ${JSON.stringify(dir)} could not be removed (${describeErrorChain(err)}); teardownAll and reconcileOrphans remove it`;
    }
  }

  /**
   * Removes every state dir of `instance` that no held or starting cell owns. Each failure is
   * returned as a CellTeardownFailed named by the cell's name.
   */
  private async sweepState(instance: string): Promise<{ removed: string[]; failures: CellTeardownFailed[] }> {
    const owned = new Set([...this.starting, ...[...this.cells.values()].map((cell) => cell.name)]);
    const instanceDir = join(this.stateRoot(), instance);
    let names: string[];
    try {
      names = await readdir(instanceDir);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return { removed: [], failures: [] };
      return { removed: [], failures: [new CellTeardownFailed(instanceDir, null, `the state dir cannot be listed: ${describeErrorChain(err)}`, { cause: err })] };
    }
    const removed: string[] = [];
    const failures: CellTeardownFailed[] = [];
    for (const name of names.filter((entry) => !owned.has(entry))) {
      try {
        await removeTree(join(instanceDir, name));
        removed.push(name);
      } catch (err) {
        failures.push(new CellTeardownFailed(name, null, `its state dir could not be removed: ${describeErrorChain(err)}`, { cause: err }));
      }
    }
    return { removed, failures };
  }

  /** The realpath of mountRoot; one that cannot be resolved refuses `forPath`. */
  private async canonicalRoot(forPath: string): Promise<string> {
    try {
      return await realpath(this.mountRoot);
    } catch (err) {
      throw new MountPathRejected(forPath, null, this.mountRoot, `the mount root cannot be resolved: ${describeErrorChain(err)}`, { cause: err });
    }
  }

  /** realpath, then a prefix check against the realpath of mountRoot; the result must still be a valid volume source. */
  private async canonicalMountPath(hostPath: string): Promise<string> {
    const root = await this.canonicalRoot(hostPath);
    let canonical: string;
    try {
      canonical = await realpath(hostPath);
    } catch (err) {
      throw new MountPathRejected(hostPath, null, root, `the path cannot be resolved: ${describeErrorChain(err)}`, { cause: err });
    }
    if (canonical === root || !canonical.startsWith(`${root}${sep}`)) {
      throw new MountPathRejected(hostPath, canonical, root, "it is not strictly inside the mount root");
    }
    for (const own of [STATE_DIR, GITLINK_STAND_IN]) {
      const ownPath = join(root, own);
      if (canonical === ownPath || canonical.startsWith(`${ownPath}${sep}`)) {
        throw new MountPathRejected(hostPath, canonical, root, `it is the substrate's own cell state (${own})`);
      }
    }
    const source = cellSpecSchema.shape.mount.shape.hostPath.safeParse(canonical);
    if (!source.success) {
      throw new MountPathRejected(hostPath, canonical, root, `the resolved path is not a valid volume source: ${issuesOf(source.error).join("; ")}`);
    }
    return canonical;
  }

  /**
   * The kind of the tree's `.git`, or null when it has none. It is covered at its own in-cell path,
   * so a symlink there would have the cover mounted wherever it points: only a plain file or
   * directory is covered, anything else refuses the cell.
   */
  private async gitEntryKind(canonicalHostPath: string): Promise<GitEntryKind | null> {
    const path = `${canonicalHostPath}${sep}.git`;
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return null;
      throw new MountPathRejected(path, null, canonicalHostPath, `the tree's .git cannot be read: ${describeErrorChain(err)}`, { cause: err });
    }
    if (entry.isSymbolicLink()) throw new MountPathRejected(path, null, canonicalHostPath, "the tree's .git is a symlink");
    if (entry.isFile()) return "file";
    if (entry.isDirectory()) return "directory";
    throw new MountPathRejected(path, null, canonicalHostPath, "the tree's .git is neither a regular file nor a directory");
  }

  /**
   * The read-only gitlink naming CELL_GIT_DIR, under the mount root (made once, shared by every
   * cell). One that exists with other content, or is not a regular file, is refused rather than mounted.
   */
  private async gitlinkStandIn(): Promise<string> {
    const root = await this.canonicalRoot(GITLINK_STAND_IN);
    const source = join(root, GITLINK_STAND_IN);
    try {
      await writeFile(source, GITLINK_TEXT, { flag: "wx", mode: 0o444 });
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        throw new MountPathRejected(source, null, root, `the gitlink stand-in cannot be created: ${describeErrorChain(err)}`, { cause: err });
      }
    }
    const made = await lstat(source);
    if (!made.isFile() || (await readFile(source, "utf8")) !== GITLINK_TEXT) {
      throw new MountPathRejected(source, null, root, `the gitlink stand-in is not a regular file holding ${JSON.stringify(GITLINK_TEXT)}`);
    }
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
      return `removing a container named ${name} failed (${describeErrorChain(err)}); it stays tracked for teardownAll`;
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
   * cells this process still holds, then every state dir of that instance no held or starting cell
   * owns. Never selects a container by name: other services share this podman.
   */
  async reconcileOrphans(instance: string): Promise<string[]> {
    const parsedInstance = instanceValue.safeParse(instance);
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
    const containers = await this.removeAll(orphans);
    // Only once their containers are gone: a state dir is removed only when nothing mounts it.
    const state = await this.sweepState(instance);
    const failures = [...containers.failures, ...state.failures];
    if (failures.length > 0) throw new TeardownIncomplete("reconcileOrphans", containers.removed, failures);
    return containers.removed;
  }

  /**
   * Removes every cell this process created and still holds, any container a failed start left,
   * and every state dir of this process's instances that no cell owns any more.
   */
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
    // A cell whose teardown failed is still held, so its state is not swept.
    for (const instance of this.instances) failures.push(...(await this.sweepState(instance)).failures);
    if (failures.length > 0) throw new TeardownIncomplete("teardownAll", removed, failures);
    return removed;
  }

  private async removeAll(ids: readonly string[]): Promise<{ removed: string[]; failures: CellTeardownFailed[] }> {
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
    return { removed, failures };
  }
}
