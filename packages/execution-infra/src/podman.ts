import { z } from "zod";
import {
  CellExecFailed,
  CellStartFailed,
  CellTeardownFailed,
  InvalidCellRequest,
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

/** Seconds `timeout` waits after its signal before SIGKILL. */
const KILL_GRACE_SECONDS = 5;
/** Host-side backstop beyond the in-cell timeout, for a podman client that itself hangs. */
const HOST_BACKSTOP_SECONDS = 30;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const PODMAN_ADMIN_TIMEOUT_MS = 120_000;
/** podman exec's own failure code; anything else is the command's exit status. */
const PODMAN_EXEC_ERROR = 125;
const TIMEOUT_EXIT = 124;
const TIMEOUT_KILL_EXIT = 137;

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
      })
      .strict(),
  })
  .strict();

/** @testseam adopted by t-isolated-switchover (s-isolated-worker-m1) */
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

/** @testseam adopted by t-isolated-switchover (s-isolated-worker-m1) */
export interface ExecOptions {
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

/** @testseam adopted by t-isolated-switchover (s-isolated-worker-m1) */
export interface SubstrateInfo {
  readonly version: string;
  readonly rootless: boolean;
}

/** @testseam adopted by t-isolated-switchover (s-isolated-worker-m1) */
export interface PodmanSubstrateOptions {
  /** Path or name of the podman binary; configuration, so a missing binary can be observed. */
  readonly podmanPath: string;
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

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildRunArgs(spec: CellSpec): string[] {
  const options = [
    ...(spec.mount.readOnly === true ? ["ro"] : []),
    spec.mount.shared === true ? "z" : "Z",
  ].join(",");
  return [
    "run",
    "-d",
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
    "-v", `${spec.mount.hostPath}:${WORKSPACE_ROOT}:${options}`,
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
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
      issues.push(`timeoutSeconds must be a positive integer, got ${options.timeoutSeconds}`);
    }
    if (issues.length > 0) throw new InvalidCellRequest("exec", issues);
    if (this.tornDown) throw new CellExecFailed(this.id, argv, null, "", "the cell has been torn down");

    const workdir = toWorkspaceAbsolute(options.cwd ?? ".");
    const args = [
      "exec", "-i", "-w", workdir, this.id,
      "timeout", "-k", String(KILL_GRACE_SECONDS), String(options.timeoutSeconds),
      ...argv,
    ];
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.substrate.run(args, {
        stdin: options.stdin,
        killAfterMs: (options.timeoutSeconds + KILL_GRACE_SECONDS + HOST_BACKSTOP_SECONDS) * 1000,
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
    if (result.exitCode === PODMAN_EXEC_ERROR) {
      throw new CellExecFailed(this.id, argv, result.exitCode, result.stderr, "podman exec or timeout itself failed");
    }
    if (options.stdin !== undefined && result.stdinError !== null) {
      throw new CellExecFailed(this.id, argv, result.exitCode, result.stderr, `stdin was not fully delivered: ${result.stdinError}`);
    }
    const timedOut =
      (result.exitCode === TIMEOUT_EXIT || result.exitCode === TIMEOUT_KILL_EXIT) &&
      elapsedMs >= options.timeoutSeconds * 1000;
    return { ...streams(result), exitCode: result.exitCode, timedOut };
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

/** @testseam adopted by t-isolated-switchover (s-isolated-worker-m1) */
export class PodmanSubstrate {
  private readonly podmanPath: string;
  private readonly runner: ProcessRunner;
  private readonly maxOutputBytes: number;
  private readonly cells = new Map<string, PodmanCell>();

  constructor(options: PodmanSubstrateOptions) {
    if (options.podmanPath === "") throw new InvalidCellRequest("substrate", ["podmanPath must not be empty"]);
    this.podmanPath = options.podmanPath;
    this.runner = options.runner ?? spawnProcess;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /**
   * @internal used by PodmanCell. Runs podman with an argv array; a binary that cannot be started
   * is SubstrateUnavailable.
   */
  async run(
    args: readonly string[],
    extra: Pick<ProcessRequest, "stdin" | "killAfterMs"> = { killAfterMs: PODMAN_ADMIN_TIMEOUT_MS },
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
    const args = buildRunArgs(parsed.data);
    const result = await this.run(args);
    if (result.exitCode !== 0) throw new CellStartFailed(args, result.exitCode, result.stderr);
    const id = containerIdSchema.safeParse(result.stdout.trim());
    if (!id.success) {
      throw new CellStartFailed(args, result.exitCode, `podman run printed no container id: ${JSON.stringify(result.stdout)}; ${result.stderr}`);
    }
    const cell = new PodmanCell(id.data, parsed.data, this);
    this.cells.set(id.data, cell);
    return cell;
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

  /** Removes every cell this process created and still holds. */
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
