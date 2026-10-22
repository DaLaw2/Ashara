import { describeErrorChain } from "@ashara/shared";
import type { WorkItemId } from "@ashara/shared";
import type { AgentBrief } from "./agent-brief.js";

/**
 * The project's current vision as the Assignment carries it: its version, its text verbatim, every
 * assumption by key, already rendered by Delivery in neutral words, and every public interface entry by key.
 */
interface AssignmentVision {
  readonly version: number;
  readonly visionText: string;
  readonly assumptions: AgentBrief["assumptions"];
  readonly interfaceEntries: AgentBrief["interfaceEntries"];
}

/** Port: the current vision of the project a task belongs to (never the summary), or null when it has none. */
export interface ProjectIntentSource {
  loadIntent(taskId: string): Promise<AssignmentVision | null>;
}

/** What the brief carries of the vision: the owner's text, every assumption work proceeds on, and every interface entry, by id. */
type ProjectIntent = Pick<AgentBrief, "intent" | "visionVersion" | "assumptions" | "interfaceEntries">;

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

/**
 * The task's project intent; throws {@link ProjectIntentUnavailable} when there is none or it cannot
 * be read (the source throws for a vision that does not read, or an assumption without its key).
 */
export async function loadProjectIntent(source: ProjectIntentSource, taskId: WorkItemId): Promise<ProjectIntent> {
  let vision: AssignmentVision | null;
  try {
    vision = await source.loadIntent(taskId);
  } catch (err) {
    throw new ProjectIntentUnavailable(taskId, `the lookup threw: ${describeErrorChain(err)}`, { cause: err });
  }
  if (vision === null || vision.visionText.trim() === "") throw new ProjectIntentUnavailable(taskId, "no vision text is recorded for its project");
  return { intent: vision.visionText.trim(), visionVersion: vision.version, assumptions: vision.assumptions, interfaceEntries: vision.interfaceEntries };
}
