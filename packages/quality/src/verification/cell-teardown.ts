import type { Cell } from "@ashara/execution-infra";
import { CellTeardownFailed } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import type { EventSubject, ExecutionEventSink } from "../dispatch-result.js";

export interface CellTeardownDeps {
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** Quality's teardown of every cell a dispatch or a sweep ran in. */
export class CellTeardown {
  private readonly deps: CellTeardownDeps;

  constructor(deps: CellTeardownDeps) {
    this.deps = deps;
  }

  /** A failed teardown is logged at warn with its typed context; the substrate keeps the cell for teardownAll and reconcileOrphans. */
  async teardownCell(subject: EventSubject, cell: Cell): Promise<void> {
    try {
      await cell.teardown();
    } catch (e) {
      if (!(e instanceof CellTeardownFailed)) throw e;
      const owner = "projectId" in subject ? `acceptance-${subject.projectId}` : `${subject.taskId} attempt ${subject.attempt}`;
      this.deps.logger.warn(
        "quality.cell-teardown-failed",
        `[${owner}] cell teardown failed; the next cycle's release of held cells removes it (teardownAll at shutdown and reconcileOrphans at startup if the process ends first)`,
        { ...subject, cellId: e.cellId },
        e,
      );
      this.deps.eventSink?.emit({ event: "cell_teardown_failed", ...subject, cellId: e.cellId, exitCode: e.exitCode, stderr: e.stderr });
    }
  }
}
