import { z } from "zod";

// ---------------------------------------------------------------------------
// Provisioner — the domain-facing port for substrate-agnostic environment
// management (ADR-071, story p0-isolation, criterion C7).
//
// The Provisioner interface is the ONLY surface its consumers outside this
// package (the server composition root) see. Whether the substrate is
// podman, docker, firecracker, or a plain subprocess is an implementation
// detail of the adapter that implements this interface. No
// substrate-specific type appears here.
//
// Target Generality: Toolchain is { name, version? } — open, not an enum.
// PHP, Zig, Elixir, COBOL work with zero code changes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Zod schemas (boundary validation)
// ---------------------------------------------------------------------------

const ToolchainSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  installMethod: z.string().optional(),
});

const NetworkPhaseSchema = z.enum([
  "provision",
  "build",
  "test",
  "run",
]);

const NetworkPolicySchema = z.record(
  NetworkPhaseSchema,
  z.boolean(),
);

const EnvironmentSpecSchema = z.object({
  baseImage: z.string().min(1),
  toolchains: z.array(ToolchainSchema),
  systemPackages: z.array(z.string()),
  envVars: z.record(z.string(), z.string()),
  networkPolicy: NetworkPolicySchema,
  projectMount: z.string().min(1),
});

const ExecResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;
export type ExecResult = z.infer<typeof ExecResultSchema>;

// ---------------------------------------------------------------------------
// ExecOptions — not a boundary type, so no schema needed
// ---------------------------------------------------------------------------

export interface ExecOptions {
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ProvisionedEnv — a running environment with immutable versioning
// ---------------------------------------------------------------------------

type ProvisionedEnvStatus =
  | "provisioning"
  | "ready"
  | "updating"
  | "torn_down";

export interface ProvisionedEnv {
  readonly id: string;
  readonly version: number;
  readonly spec: EnvironmentSpec;
  readonly status: ProvisionedEnvStatus;
}

// ---------------------------------------------------------------------------
// Typed errors (Discipline C: self-diagnosing, structured context)
// ---------------------------------------------------------------------------

export interface ProvisioningErrorContext {
  readonly operation: string;
  readonly spec: EnvironmentSpec;
  readonly detail: string;
}

export class ProvisioningError extends Error {
  constructor(public readonly context: ProvisioningErrorContext) {
    super(
      `provisioning failed at ${context.operation}: ${context.detail}`,
    );
    this.name = "ProvisioningError";
  }
}

export interface SubstrateUnavailableContext {
  /** What is unavailable, named for the operator (e.g. "podman"). */
  readonly substrate: string;
  /** Where it was found missing: "probe", "build", "start", "exec". */
  readonly operation: string;
  /** The binary or endpoint that was tried. */
  readonly target: string;
  readonly detail: string;
}

/**
 * The substrate itself cannot host anything (its binary is missing, or it
 * does not answer its own health query), as opposed to a provisioning step
 * that ran and failed. The distinction routes the task: a missing substrate
 * blocks it for the operator; it is not a task failure to retry.
 */
export class SubstrateUnavailable extends Error {
  constructor(public readonly context: SubstrateUnavailableContext) {
    super(
      `execution substrate "${context.substrate}" unavailable at ${context.operation} (${context.target}): ${context.detail}`,
    );
    this.name = "SubstrateUnavailable";
  }
}

export interface TeardownErrorContext {
  readonly envId: string;
  readonly detail: string;
}

export class TeardownError extends Error {
  constructor(public readonly context: TeardownErrorContext) {
    super(`teardown failed for env ${context.envId}: ${context.detail}`);
    this.name = "TeardownError";
  }
}

// ---------------------------------------------------------------------------
// Provisioner interface — the port
// ---------------------------------------------------------------------------

export interface Provisioner {
  /**
   * Resolves only when the substrate can host an environment right now;
   * throws SubstrateUnavailable otherwise. Called before any worktree exists,
   * so an unavailable substrate never reaches a code path that runs on the host.
   */
  probe(): Promise<void>;
  provision(spec: EnvironmentSpec): Promise<ProvisionedEnv>;
  execute(env: ProvisionedEnv, command: string[], opts?: ExecOptions): Promise<ExecResult>;
  teardown(env: ProvisionedEnv): Promise<void>;
  activeContainerName(): string | undefined;
  activeContainerMount(): string | undefined;
}
