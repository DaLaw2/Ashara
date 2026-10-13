import type { WorkItemId } from "@ashara/shared";

/** Port: the vision text of the project a task belongs to, verbatim (never the summary). */
export interface ProjectIntentSource {
  loadIntent(taskId: string): Promise<string | null>;
}

/**
 * No vision text is on record for the task's project, or it could not be read. Nothing is
 * dispatched: a brief with an invented intent is exactly the substituted prior the brief's
 * intent section exists to prevent.
 */
export class ProjectIntentUnavailable extends Error {
  constructor(
    readonly taskId: WorkItemId,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`no project intent for task ${taskId}: ${detail}; refusing to dispatch without the owner's own statement of the project`, options);
    this.name = "ProjectIntentUnavailable";
  }
}

/** The task's project intent, trimmed; throws {@link ProjectIntentUnavailable} when there is none. */
export async function loadProjectIntent(source: ProjectIntentSource, taskId: WorkItemId): Promise<string> {
  let intent: string | null;
  try {
    intent = await source.loadIntent(taskId);
  } catch (err) {
    throw new ProjectIntentUnavailable(taskId, `the lookup threw: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (intent === null || intent.trim() === "") throw new ProjectIntentUnavailable(taskId, "no vision text is recorded for its project");
  return intent.trim();
}
