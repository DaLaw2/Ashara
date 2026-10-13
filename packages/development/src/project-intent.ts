import { z } from "zod";
import type { AgentBrief, WorkItemId } from "@ashara/shared";

/** The project's current vision as stored: its version, its text verbatim, and its inferences jsonb unparsed. */
interface StoredVision {
  readonly version: number;
  readonly visionText: string;
  readonly inferences: unknown;
}

/** Port: the current vision of the project a task belongs to (never the summary), or null when it has none. */
export interface ProjectIntentSource {
  loadIntent(taskId: string): Promise<StoredVision | null>;
}

/** What the brief carries of the vision: the owner's text and every assumption work proceeds on, by id. */
type ProjectIntent = Pick<AgentBrief, "intent" | "visionVersion" | "assumptions">;

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

// The keyed assumption records intake and the stack choice write (vision_documents.inferences).
// The map shape the deleted CLI path wrote carries no ids, so a worker could not be told which
// assumption it may not contradict: it is refused, never rendered without them.
const StoredAssumptionsSchema = z.array(
  z.looseObject({ key: z.string().min(1), status: z.string().min(1), statement: z.string().min(1) }),
);

/** The task's project intent; throws {@link ProjectIntentUnavailable} when there is none or it cannot be read. */
export async function loadProjectIntent(source: ProjectIntentSource, taskId: WorkItemId): Promise<ProjectIntent> {
  let vision: StoredVision | null;
  try {
    vision = await source.loadIntent(taskId);
  } catch (err) {
    throw new ProjectIntentUnavailable(taskId, `the lookup threw: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (vision === null || vision.visionText.trim() === "") throw new ProjectIntentUnavailable(taskId, "no vision text is recorded for its project");
  const assumptions = StoredAssumptionsSchema.safeParse(vision.inferences);
  if (!assumptions.success) {
    throw new ProjectIntentUnavailable(
      taskId,
      `vision v${vision.version} inferences are not a list of keyed assumptions: ${z.prettifyError(assumptions.error)}`,
    );
  }
  return {
    intent: vision.visionText.trim(),
    visionVersion: vision.version,
    assumptions: assumptions.data.map(({ key, status, statement }) => ({ key, status, statement })),
  };
}
