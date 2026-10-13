import { z } from "zod";
import type { ResolvedModel } from "@ashara/llm-gateway";
import type { AgentBrief, ProjectId, WorkItemId, WorkKind } from "@ashara/shared";
import { InvalidAssignment } from "./errors.js";
import type { AttemptCellImage } from "./records.js";

/** ADR-074 d56: an attempt's wall clock is 20 minutes unless the caller sets its own. */
const DEFAULT_WALL_CLOCK_MS = 20 * 60 * 1000;

/** The task instruction: the fields of today's agent brief that describe the work, not the old host sandbox. */
export type AssignmentBrief = Pick<
  AgentBrief,
  "goal" | "intent" | "projectEnvironment" | "context" | "deliverables" | "knowledgeContext" | "contextMap" | "priorAttemptFailure"
>;

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
  readonly role: string;
  /** The kind of work the task is; it decides the tools offered (build_environment for environment work only). */
  readonly workKind: WorkKind | null;
  readonly brief: AssignmentBrief;
  /** The image the attempt's cell was started from; recorded with the attempt. */
  readonly cellImage: AttemptCellImage;
  /** Resolved once by the caller; every turn of the attempt uses it (ADR-074 d44). */
  readonly model: ResolvedModel;
  readonly limits: AttemptLimits;
}

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
  if (assignment.role.trim() === "") issues.push("role: must not be empty");
  if (assignment.model.modelId.trim() === "") issues.push("model.modelId: must not be empty");
  if (!limits.success || issues.length > 0) throw new InvalidAssignment(assignment.taskId, issues);
  return {
    maxTurns: limits.data.maxTurns,
    wallClockMs: limits.data.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
    perCommandTimeoutSeconds: limits.data.perCommandTimeoutSeconds,
  };
}
