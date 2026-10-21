import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { LlmCallRepository } from "./llm-call-repository.js";

// Finance's published reads of the work ledger, for the contexts that tell the client or the operator
// of it: the requests a project drew and the requests the owner granted it, counted as the ledger
// counts them before every request (every llm_calls row, in any state, so a request is drawn from
// the moment it is admitted), and the requests each task drew.

/** A project's work ledger as Finance reads it. */
export interface ProjectWork {
  /** Requests recorded, or lost to a crash and still counted. */
  readonly spent: number;
  /** Requests admitted and not yet recorded. */
  readonly inFlight: number;
  /** Every request drawn: spent and in flight. */
  readonly drawn: number;
  /** Requests the owner granted the project. */
  readonly granted: number;
}

/** The project's work ledger. */
export async function projectWork(db: DbHandle, projectId: ProjectId): Promise<ProjectWork> {
  const { project } = await new LlmCallRepository(db).work({ projectId, taskId: null });
  return { spent: project.spent, inFlight: project.inFlight, drawn: project.spent + project.inFlight, granted: project.granted };
}

/** The requests each of `taskIds` drew, spent and in flight alike; a task that drew none is 0. */
export async function tasksWorkDrawn(db: DbHandle, taskIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
  return new LlmCallRepository(db).drawnByTask(taskIds);
}
