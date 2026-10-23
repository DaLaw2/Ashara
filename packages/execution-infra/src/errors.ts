/**
 * Every error names the operation, the exact argv sent to the substrate, the exit code and stderr
 * where one exists. Cells get no --env-host or --secret: `podman run` passes one -e, HOME, a fixed
 * in-cell path, and `podman exec` passes only the tool's own argv, as ASHARA_ARGC and ASHARA_ARG_<i>.
 */

import { describeErrorChain, renderElided } from "@ashara/shared";
import type { ElidedText } from "@ashara/shared";

class ExecutionInfraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionInfraError";
  }
}

/** The process runner could not start the binary at all (missing, not executable). */
export class ProcessSpawnFailed extends ExecutionInfraError {
  readonly file: string;
  readonly code: string;
  readonly detail: string;

  constructor(file: string, code: string, detail: string, options?: ErrorOptions) {
    super(`Could not start "${file}" (${code}): ${detail}`, options);
    this.name = "ProcessSpawnFailed";
    this.file = file;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The CPUs and memory of the host cells run on could not be read from the container runtime: the
 * command failed, or its output is not the shape expected. Nothing is assumed in its place.
 */
export class HostCapacityUnreadable extends ExecutionInfraError {
  readonly command: string;
  readonly detail: string;

  constructor(command: string, detail: string, options?: ErrorOptions) {
    super(`Cannot read the CPUs and memory cells run on from \`${command}\`: ${detail}`, options);
    this.name = "HostCapacityUnreadable";
    this.command = command;
    this.detail = detail;
  }
}

/**
 * The container substrate cannot be used. Never answered by a host fallback: the caller blocks the
 * work.
 */
export class SubstrateUnavailable extends ExecutionInfraError {
  readonly binary: string;
  readonly detail: string;

  constructor(binary: string, detail: string, options?: ErrorOptions) {
    super(`Container substrate "${binary}" is unavailable: ${detail}`, options);
    this.name = "SubstrateUnavailable";
    this.binary = binary;
    this.detail = detail;
  }
}

export class InvalidCellRequest extends ExecutionInfraError {
  readonly operation: string;
  readonly issues: readonly string[];

  constructor(operation: string, issues: readonly string[]) {
    super(`Invalid ${operation} request: ${issues.join("; ")}`);
    this.name = "InvalidCellRequest";
    this.operation = operation;
    this.issues = issues;
  }
}

/** A cell resource limit is unset or malformed: no cell may start, and the server refuses to boot. */
export class CellLimitsInvalid extends ExecutionInfraError {
  readonly variable: string;
  readonly raw: string | null;
  readonly expected: string;

  constructor(variable: string, raw: string | null, expected: string) {
    super(
      raw === null || raw.trim() === ""
        ? `${variable} is not set; every cell runs under required CPU, memory and pids limits, so set it to ${expected}`
        : `${variable}=${JSON.stringify(raw)} is not ${expected}`,
    );
    this.name = "CellLimitsInvalid";
    this.variable = variable;
    this.raw = raw;
    this.expected = expected;
  }
}

export class CellStartFailed extends ExecutionInfraError {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  /** What became of a container the failed `podman run` may have created. */
  readonly cleanup: string;

  constructor(argv: readonly string[], exitCode: number | null, stderr: string, cleanup: string, options?: ErrorOptions) {
    super(
      `Cell start failed (exit ${exitCode ?? "none"}): ${stderr.trim() || "(no stderr)"}; ${cleanup}; argv: ${JSON.stringify(argv)}`,
      options,
    );
    this.name = "CellStartFailed";
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.cleanup = cleanup;
  }
}

/**
 * The substrate failed to run a command in the cell, as opposed to the command itself failing.
 */
export class CellExecFailed extends ExecutionInfraError {
  readonly cellId: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly detail: string;

  constructor(cellId: string, argv: readonly string[], exitCode: number | null, stderr: string, detail: string, options?: ErrorOptions) {
    super(
      `Exec in cell ${cellId} failed (exit ${exitCode ?? "none"}): ${detail}; stderr: ${stderr.trim() || "(none)"}; argv: ${JSON.stringify(argv)}`,
      options,
    );
    this.name = "CellExecFailed";
    this.cellId = cellId;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.detail = detail;
  }
}

/**
 * The exec's AbortSignal (the process's shutdown) aborted before or while the command ran, so its
 * podman exec was killed and the command reached no outcome: neither a pass nor a failure of what
 * it checked, and never the substrate's fault. What it started may still run in the cell until the
 * cell is torn down, so the cell refuses every later exec. `reason` is the signal's own.
 */
export class CellExecInterrupted extends ExecutionInfraError {
  readonly cellId: string;
  readonly argv: readonly string[];
  readonly reason: unknown;

  constructor(cellId: string, argv: readonly string[], when: "before it started" | "while it ran", reason: unknown) {
    super(`Exec in cell ${cellId} was interrupted ${when}: its signal aborted (${describeErrorChain(reason)}); argv: ${JSON.stringify(argv)}`);
    this.name = "CellExecInterrupted";
    this.cellId = cellId;
    this.argv = argv;
    this.reason = reason;
  }
}

/** The interruption `err` is, or carries as a cause; null for any other failure. */
export function cellExecInterruptedOf(err: unknown): CellExecInterrupted | null {
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (current instanceof CellExecInterrupted) return current;
  }
  return null;
}

/**
 * Z0's git could not make the throwaway repository a cell mounts as its own, so no cell was
 * started. `step` is the snapshot step that failed, `argv` its exact git argv.
 */
export class WorkspaceSnapshotFailed extends ExecutionInfraError {
  readonly workTree: string;
  readonly step: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(workTree: string, step: string, argv: readonly string[], exitCode: number | null, stderr: string, options?: ErrorOptions) {
    super(
      `Snapshot of ${JSON.stringify(workTree)} into a cell repository failed at ${step} (exit ${exitCode ?? "none"}): ` +
        `${stderr.trim() || "(no stderr)"}; argv: ${JSON.stringify(argv)}`,
      options,
    );
    this.name = "WorkspaceSnapshotFailed";
    this.workTree = workTree;
    this.step = step;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class CellTeardownFailed extends ExecutionInfraError {
  readonly cellId: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(cellId: string, exitCode: number | null, stderr: string, options?: ErrorOptions) {
    super(`Teardown of cell ${cellId} failed (exit ${exitCode ?? "none"}): ${stderr.trim() || "(no stderr)"}`, options);
    this.name = "CellTeardownFailed";
    this.cellId = cellId;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Some cells could not be removed; `removed` lists the ones that were.
 */
export class TeardownIncomplete extends ExecutionInfraError {
  readonly operation: string;
  readonly removed: readonly string[];
  readonly failures: readonly CellTeardownFailed[];

  constructor(operation: string, removed: readonly string[], failures: readonly CellTeardownFailed[]) {
    super(
      `${operation}: ${failures.length} cell(s) could not be removed (${failures.map((f) => f.cellId).join(", ")}); ` +
        `removed ${removed.length}. First failure: ${failures[0]?.message ?? "(none)"}`,
    );
    this.name = "TeardownIncomplete";
    this.operation = operation;
    this.removed = removed;
    this.failures = failures;
  }
}

/**
 * Podman exited non-zero or printed something that does not match the expected schema.
 */
export class PodmanCommandFailed extends ExecutionInfraError {
  readonly operation: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly detail: string;

  constructor(operation: string, argv: readonly string[], exitCode: number | null, detail: string) {
    super(`podman ${operation} failed (exit ${exitCode ?? "none"}): ${detail}; argv: ${JSON.stringify(argv)}`);
    this.name = "PodmanCommandFailed";
    this.operation = operation;
    this.argv = argv;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

/**
 * A cell mount was refused before podman ran: after canonicalization (symlinks resolved) the host
 * path is not under the substrate's mount root, or cannot be resolved at all (Discipline B).
 */
export class MountPathRejected extends ExecutionInfraError {
  readonly hostPath: string;
  readonly canonicalPath: string | null;
  readonly mountRoot: string;
  readonly reason: string;

  constructor(hostPath: string, canonicalPath: string | null, mountRoot: string, reason: string, options?: ErrorOptions) {
    super(
      `Mount of ${JSON.stringify(hostPath)}` +
        `${canonicalPath !== null && canonicalPath !== hostPath ? ` (resolves to ${JSON.stringify(canonicalPath)})` : ""} ` +
        `refused: ${reason}; every mount must be under ${JSON.stringify(mountRoot)}`,
      options,
    );
    this.name = "MountPathRejected";
    this.hostPath = hostPath;
    this.canonicalPath = canonicalPath;
    this.mountRoot = mountRoot;
    this.reason = reason;
  }
}

export class PathOutsideWorkspace extends ExecutionInfraError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Path ${JSON.stringify(path)} is outside /workspace: ${reason}. Use a path relative to the workspace root.`);
    this.name = "PathOutsideWorkspace";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * A tool's POSIX utility ran in the cell and reported failure (or timed out).
 */
export class CellToolFailed extends ExecutionInfraError {
  readonly tool: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(tool: string, argv: readonly string[], exitCode: number | null, stderr: string, timedOut: boolean) {
    super(
      `${tool} failed in cell (exit ${exitCode ?? "none"}${timedOut ? ", timed out" : ""}): ` +
        `${stderr.trim() || "(no stderr)"}; argv: ${JSON.stringify(argv)}`,
    );
    this.name = "CellToolFailed";
    this.tool = tool;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

export class BaseCellConfigInvalid extends ExecutionInfraError {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`BaseCell reference "${path}" is unusable: ${detail}`, options);
    this.name = "BaseCellConfigInvalid";
    this.path = path;
    this.detail = detail;
  }
}

/**
 * `environment/environment.toml` is missing, is not TOML, or does not match the definition
 * schema. `issues` are the schema's own, path-qualified.
 */
export class EnvironmentDefinitionInvalid extends ExecutionInfraError {
  readonly path: string;
  readonly issues: readonly string[];

  constructor(path: string, issues: readonly string[], options?: ErrorOptions) {
    super(`Environment definition ${JSON.stringify(path)} is invalid: ${issues.join("; ")}`, options);
    this.name = "EnvironmentDefinitionInvalid";
    this.path = path;
    this.issues = issues;
  }
}

/**
 * The environment version cannot be computed at `commit`: git failed, a recipe file is missing, or
 * the build context holds an entry an image cannot be built from (a directory, a submodule, a symlink).
 */
export class EnvironmentVersionUnresolved extends ExecutionInfraError {
  readonly gitDir: string;
  readonly commit: string;
  readonly reason: string;

  constructor(gitDir: string, commit: string, reason: string, options?: ErrorOptions) {
    super(`Environment version of ${JSON.stringify(gitDir)} at ${JSON.stringify(commit)} cannot be resolved: ${reason}`, options);
    this.name = "EnvironmentVersionUnresolved";
    this.gitDir = gitDir;
    this.commit = commit;
    this.reason = reason;
  }
}

/**
 * Host git could not run a read of the environment's committed objects (a lock, an unreadable
 * object store): Ashara's own fault, which says nothing of what the commit defines.
 */
export class EnvironmentGitFailed extends ExecutionInfraError {
  readonly gitDir: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(gitDir: string, argv: readonly string[], exitCode: number | null, stderr: string, options?: ErrorOptions) {
    // eslint-disable-next-line no-restricted-syntax -- policy default: a message placeholder for an empty stderr, which the stderr field still carries verbatim
    super(`git ${argv.join(" ")} in ${JSON.stringify(gitDir)} failed (exit ${exitCode ?? "unknown"}): ${stderr.trim() || "(no stderr)"}`, options);
    this.name = "EnvironmentGitFailed";
    this.gitDir = gitDir;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** `podman build` of an environment version did not produce an image. */
export class EnvironmentBuildFailed extends ExecutionInfraError {
  readonly projectId: string;
  readonly version: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The build's log, its middle cut to a bound. */
  readonly log: ElidedText;
  readonly detail: string;

  constructor(
    projectId: string,
    version: string,
    exitCode: number | null,
    timedOut: boolean,
    log: ElidedText,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Environment build of project ${projectId} version ${version} failed (exit ${exitCode ?? "none"}` +
        `${timedOut ? ", timed out" : ""}): ${detail}; log: ${renderElided(log).trim() || "(empty)"}`,
      options,
    );
    this.name = "EnvironmentBuildFailed";
    this.projectId = projectId;
    this.version = version;
    this.exitCode = exitCode;
    this.timedOut = timedOut;
    this.log = log;
    this.detail = detail;
  }
}

/**
 * `podman build` produced an image, but its succeeded build could not be recorded. The image is
 * not used: buildEnvironmentImage reuses only an image whose build is on record, so the next
 * resolution of this version builds it again.
 */
export class EnvironmentBuildUnrecorded extends ExecutionInfraError {
  readonly projectId: string;
  readonly version: string;
  readonly commit: string;
  readonly imageRef: string;
  readonly imageId: string;

  constructor(
    build: { readonly projectId: string; readonly version: string; readonly commit: string; readonly imageRef: string; readonly imageId: string },
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Environment build of project ${build.projectId} version ${build.version} (commit ${build.commit}) produced image ` +
        `${build.imageId} (${build.imageRef}), but recording it failed: ${detail}`,
      options,
    );
    this.name = "EnvironmentBuildUnrecorded";
    this.projectId = build.projectId;
    this.version = build.version;
    this.commit = build.commit;
    this.imageRef = build.imageRef;
    this.imageId = build.imageId;
  }
}
