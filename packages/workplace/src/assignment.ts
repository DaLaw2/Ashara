import { z } from "zod";
import type { AttemptCellImage } from "@ashara/execution-infra";
import type { ResolvedModel } from "@ashara/finance";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { AgentBrief } from "./agent-brief.js";
import { InvalidAssignment } from "./errors.js";

/** An attempt's wall clock is 20 minutes unless the caller sets its own. */
const DEFAULT_WALL_CLOCK_MS = 20 * 60 * 1000;

/** The task instruction: the fields of the agent brief that describe the work. */
export type AssignmentBrief = Pick<
  AgentBrief,
  | "goal"
  | "intent"
  | "visionVersion"
  | "assumptions"
  | "interfaceEntries"
  | "projectEnvironment"
  | "context"
  | "deliverables"
  | "knowledgeContext"
  | "contextMap"
  | "priorAttemptFailure"
  | "protectedPaths"
>;

/**
 * The tools and Z0 ports an attempt is given, named by what the attempt does with them:
 * - "build-environment": build_environment and the environment finish, with Z0's environment check;
 * - "define-checks": define_check and probe_foundation, with Z0's check recorder;
 * - "run-and-dispute-checks": run_checks and dispute_check when the task's stored checks are supplied;
 * - "run-checks": run_checks alone when the task's stored checks are supplied.
 * Every profile has the workspace tools and finish. Neither "build-environment" nor "define-checks"
 * is given the stored checks.
 */
export const TOOL_PROFILES = ["build-environment", "define-checks", "run-and-dispute-checks", "run-checks"] as const;

export type ToolProfile = (typeof TOOL_PROFILES)[number];

/**
 * The charter of the role an attempt works as, as its system prompt states it: who the agent is,
 * and the duties of its role beyond the task itself (null when it has none).
 */
export interface AssignmentCharter {
  readonly identity: string;
  readonly duties: string | null;
}

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
  /** The tools and Z0 ports the attempt is given. */
  readonly toolProfile: ToolProfile;
  readonly charter: AssignmentCharter;
  readonly brief: AssignmentBrief;
  /** The image the attempt's cell was started from; recorded with the attempt. */
  readonly cellImage: AttemptCellImage;
  /** Resolved once by the caller; every turn of the attempt uses it. */
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
