import { z } from "zod";
import type { AttemptCellImage } from "@ashara/execution-infra";
import type { ResolvedModel } from "@ashara/model-access";
import type { AgentBrief, ProjectId, WorkItemId, WorkKind } from "@ashara/shared";
import { InvalidAssignment } from "./errors.js";

/** ADR-074 d56: an attempt's wall clock is 20 minutes unless the caller sets its own. */
const DEFAULT_WALL_CLOCK_MS = 20 * 60 * 1000;

/** The task instruction: the fields of today's agent brief that describe the work, not the old host sandbox. */
export type AssignmentBrief = Pick<
  AgentBrief,
  | "goal"
  | "intent"
  | "visionVersion"
  | "assumptions"
  | "projectEnvironment"
  | "context"
  | "deliverables"
  | "knowledgeContext"
  | "contextMap"
  | "priorAttemptFailure"
  | "protectedPaths"
>;

/** The roster role an attempt works as: the task's owner, by its roster id and name. */
interface AssignmentRole {
  readonly id: string;
  readonly name: string;
}

interface AttemptLimits {
  readonly maxTurns: number;
  /** Policy default DEFAULT_WALL_CLOCK_MS. */
  readonly wallClockMs?: number;
  /** Upper bound for one run_command; the model may ask for less, never more. */
  readonly perCommandTimeoutSeconds: number;
}

export interface Assignment {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId;
  readonly role: AssignmentRole;
  /** The kind of work the task is; it decides the tools offered (build_environment for environment work only). */
  readonly workKind: WorkKind | null;
  readonly brief: AssignmentBrief;
  /** The image the attempt's cell was started from; recorded with the attempt. */
  readonly cellImage: AttemptCellImage;
  /** Resolved once by the caller; every turn of the attempt uses it (ADR-074 d44). */
  readonly model: ResolvedModel;
  readonly limits: AttemptLimits;
}

/** Who works an attempt and on which model: the agent half of an Assignment, which its caller staffs. */
export type AssignmentStaff = Pick<Assignment, "role" | "model">;

const positiveInt = z.number().int().positive();

const limitsSchema = z
  .object({
    maxTurns: positiveInt,
    wallClockMs: positiveInt.optional(),
    perCommandTimeoutSeconds: positiveInt,
  })
  .strict();

export interface ResolvedLimits {
  readonly maxTurns: number;
  readonly wallClockMs: number;
  readonly perCommandTimeoutSeconds: number;
}

export function resolveLimits(assignment: Assignment): ResolvedLimits {
  const issues: string[] = [];
  const limits = limitsSchema.safeParse(assignment.limits);
  if (!limits.success) {
    issues.push(...limits.error.issues.map((issue) => `limits.${issue.path.join(".")}: ${issue.message}`));
  }
  if (assignment.role.id.trim() === "") issues.push("role.id: must not be empty");
  if (assignment.role.name.trim() === "") issues.push("role.name: must not be empty");
  if (assignment.model.modelId.trim() === "") issues.push("model.modelId: must not be empty");
  if (!limits.success || issues.length > 0) throw new InvalidAssignment(assignment.taskId, issues);
  return {
    maxTurns: limits.data.maxTurns,
    wallClockMs: limits.data.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
    perCommandTimeoutSeconds: limits.data.perCommandTimeoutSeconds,
  };
}
