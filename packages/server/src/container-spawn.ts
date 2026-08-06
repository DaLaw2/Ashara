// ---------------------------------------------------------------------------
// Sandbox container configuration (p0-isolation)
//
// The image name+tag are the sole source of truth for which container image
// agent-runner processes execute in. With the provisioner active, project-
// specific images are built dynamically from EnvironmentSpec (ADR-071).
// This is the baseline for scaffold tasks and the host-spawn path.
// ---------------------------------------------------------------------------

// Fallback image for agent containers when no provisioner is active.
export const SANDBOX_IMAGE = "alpine";
export const SANDBOX_TAG = "3.20";

// ---------------------------------------------------------------------------
// Typed error (Discipline C: self-diagnosing, structured context)
// ---------------------------------------------------------------------------

export class ContainerSpawnError extends Error {
  readonly context: {
    readonly operation: string;
    readonly containerName: string;
    readonly taskId: string;
    readonly exitCode: number | null;
    readonly cause: string;
    readonly stderr: string;
  };

  constructor(ctx: ContainerSpawnError["context"]) {
    super(
      `container ${ctx.operation} failed for task ${ctx.taskId} ` +
      `(container=${ctx.containerName}, exit=${ctx.exitCode}): ${ctx.cause}`,
    );
    this.name = "ContainerSpawnError";
    this.context = ctx;
  }
}
