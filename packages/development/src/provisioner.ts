import { z } from "zod";

// ---------------------------------------------------------------------------
// Provisioner — the domain-facing port for substrate-agnostic environment
// management (ADR-071, story p0-isolation, criterion C7).
//
// The Provisioner interface is the ONLY surface agent-runner and the
// orchestrator see. Whether the substrate is podman, docker, firecracker,
// or a plain subprocess is an implementation detail of the adapter that
// implements this interface. No substrate-specific type appears here.
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

export const EnvironmentSpecSchema = z.object({
  baseImage: z.string().min(1),
  toolchains: z.array(ToolchainSchema),
  systemPackages: z.array(z.string()),
  envVars: z.record(z.string(), z.string()),
  networkPolicy: NetworkPolicySchema,
  projectMount: z.string().min(1),
});

export const ExecResultSchema = z.object({
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

export type ProvisionedEnvStatus =
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
  provision(spec: EnvironmentSpec): Promise<ProvisionedEnv>;
  execute(env: ProvisionedEnv, command: string[], opts?: ExecOptions): Promise<ExecResult>;
  teardown(env: ProvisionedEnv): Promise<void>;
  activeContainerName(): string | undefined;
  activeContainerMount(): string | undefined;
}
