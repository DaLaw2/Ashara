import type { FailedApproachRepository } from "./repositories/failed-approach.js";

/** The task a failed approach is recorded for. */
interface ApproachTask {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

/** What the FailureRouter decided for a failed attempt, and the attempts the task had made. */
interface RoutedFailure {
  readonly action: "replan" | "abandon";
  readonly attempts: number;
}

/**
 * Deterministic lesson text for a routed failure (kl-t1): every decision means this dispatch
 * attempt did not succeed, so each is worth a lesson, composed with zero LLM calls from data
 * already in scope. It names the task, the action taken and the attempt count, so a later brief's
 * "Failed Approaches" section reads as a lesson rather than a bare error string.
 */
function routedLesson(title: string, routed: RoutedFailure, detail: string): string {
  const verb = routed.action === "abandon" ? "abandoned" : "replanned for another attempt";
  return `Task '${title}' was ${verb} after ${routed.attempts} attempt(s): ${detail}`;
}

/**
 * Records a failed_approaches row. `learned` defaults to `errorDetail` — the field is never left
 * empty, even for the plain thrown-orchestrator-error call site that has no richer lesson to
 * compose. A failure the FailureRouter routed passes its decision (RoutedFailure), and the lesson
 * is composed here. `epicIdOf` walks the task's Epic ancestor, which Delivery owns; a failure of the walk or of
 * the write is logged and never reaches the caller.
 */
export async function recordFailedApproach(
  failedApproachRepo: Pick<FailedApproachRepository, "record">,
  task: ApproachTask,
  epicIdOf: () => Promise<string | null>,
  errorDetail: string,
  learned?: string | RoutedFailure,
): Promise<void> {
  try {
    const epicId = await epicIdOf();
    await failedApproachRepo.record(
      task.projectId,
      task.id,
      epicId,
      task.title,
      errorDetail,
      typeof learned === "object" ? routedLesson(task.title, learned, errorDetail) : (learned ?? errorDetail),
    );
  } catch (e) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: a lesson is context for later briefs; a lost one is absent from them, never rendered as none, and no verdict, counter or charge reads it
    console.warn(`[${task.id}] failed to record failed approach:`, e);
  }
}
