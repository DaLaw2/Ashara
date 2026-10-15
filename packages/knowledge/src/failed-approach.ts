import type { FailedApproachRepository } from "./repositories/failed-approach.js";

/** The task a failed approach is recorded for. */
interface ApproachTask {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

/**
 * Records a failed_approaches row. `learned` defaults to `errorDetail` — the field is never left
 * empty, even for the plain thrown-orchestrator-error call site that has no richer lesson to
 * compose. Callers on the FailureRouter-routed path pass a real lesson via `composeRoutedLesson`
 * below. `epicIdOf` walks the task's Epic ancestor, which Delivery owns; a failure of the walk or of
 * the write is logged and never reaches the caller.
 */
export async function recordFailedApproach(
  failedApproachRepo: Pick<FailedApproachRepository, "record">,
  task: ApproachTask,
  epicIdOf: () => Promise<string | null>,
  errorDetail: string,
  learned?: string,
): Promise<void> {
  try {
    const epicId = await epicIdOf();
    // FINDING: taskSpec.area was read but never written by any producer — a silent
    // death of the shouldSplit class. The fallback was always taken. Removed the
    // dead read; only the fallback remains.
    const affectedArea = task.title.toLowerCase();

    await failedApproachRepo.record(
      task.projectId,
      task.id,
      epicId,
      task.title,
      `Task '${task.title}' attempted execution`,
      errorDetail,
      learned ?? errorDetail,
      affectedArea,
    );
  } catch (e) {
    console.warn(`[${task.id}] failed to record failed approach:`, e);
  }
}

/**
 * Deterministic "lesson" text for a FailureRouter-routed failure (kl-t1): every
 * decision — replan or abandon — means
 * this dispatch attempt did not succeed, so each is worth a lesson, composed with
 * zero LLM calls from data already in scope (no distillation — deferred by story
 * decision). Provenance-bearing: names the task, the action taken, and the
 * attempt count, so a later brief's "Failed Approaches" section reads as an
 * imperative lesson rather than a bare error string.
 */
export function composeRoutedLesson(
  title: string,
  action: "replan" | "abandon",
  attempts: number,
  detail: string,
): string {
  const verb = action === "abandon" ? "abandoned" : "replanned for another attempt";
  return `Task '${title}' was ${verb} after ${attempts} attempt(s): ${detail}`;
}
