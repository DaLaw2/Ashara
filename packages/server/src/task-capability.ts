import type { TaskDescriptor } from "@ashara/development";
import { classifyFailure, shouldEscalate, tryParseEnvelope } from "@ashara/planning";
import type { CapabilityLevel, StoredBlockedReason, WorkItemId } from "@ashara/shared";

/**
 * A task reached dispatch with no capability level on its stored spec. Every producer sets one
 * (ADR-074 addendum 2 d70: the planner grades a decomposed task, and sets a fixed level on every
 * task it adds), so its absence is a row written before grading or by a producer that skipped it.
 * Dispatch fails rather than assuming a level the planner never chose.
 */
class TaskCapabilityUngraded extends Error {
  constructor(
    readonly taskId: WorkItemId,
    readonly origin: string | undefined,
  ) {
    super(
      `task ${taskId} (origin ${origin ?? "unrecorded"}) carries no capability level in its task_spec: ` +
        `no model can be chosen for it, so it is not dispatched`,
    );
    this.name = "TaskCapabilityUngraded";
  }
}

/**
 * The capability an attempt is dispatched at: the task's stored grade, or Frontier when the prior
 * attempt's failure calls for escalation (the safety net under a grade set too low, d70).
 */
export function determineCapability(task: TaskDescriptor): CapabilityLevel {
  const graded = task.taskSpec?.capability;
  if (graded === undefined) throw new TaskCapabilityUngraded(task.id, task.taskSpec?.origin);
  if (task.dispatchCount === 0) return graded;

  const envelope = extractPriorEnvelope(task.blockedReason);
  if (!envelope) return graded;

  const category = classifyFailure(envelope);
  if (shouldEscalate(category, task.dispatchCount >= 2 ? [category] : [])) return "Frontier";

  return graded;
}

function extractPriorEnvelope(blockedReason: StoredBlockedReason | undefined): ReturnType<typeof tryParseEnvelope> {
  if (!blockedReason) return null;
  // Only the "replan" variant carries replanContext.
  if (blockedReason.source !== "replan") return null;
  const raw = blockedReason.replanContext.raw;
  if (!isRecord(raw)) return null;
  return tryParseEnvelope(raw);
}

// open-by-design: generic type guard — narrows unknown to Record as a stepping stone
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
