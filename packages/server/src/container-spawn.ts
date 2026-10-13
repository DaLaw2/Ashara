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
