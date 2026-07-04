import type { SessionId, WorkItemId } from "@ashara/shared";

// AgentBrief is the single validated brief.json contract, owned by the Shared
// Kernel (ADR-013, restored per the ddd-boundary-audit SEAM-1 finding). Imported
// for local use (e.g. DispatchResponse below) and re-exported so existing
// @ashara/development consumers keep their import site while the type itself
// lives in @ashara/shared with its Zod schema.
import type { AgentBrief } from "@ashara/shared";
export type { AgentBrief };

export interface TaskSpec {
  readonly goal: string;
  readonly endState: string;
  readonly scope: string;
  readonly deliverables: string[];
  readonly checks: string[];
}

export interface TaskContext {
  readonly epic_title: string;
  readonly story_title: string;
  readonly feature_title: string;
}

export interface DispatchRequest {
  readonly task_id: WorkItemId;
  readonly task_spec: TaskSpec;
  readonly context: TaskContext;
}

export interface DispatchResponse {
  readonly session_id: SessionId;
  readonly brief: AgentBrief;
  readonly token_count: number;
  readonly quality_gate?: {
    readonly passed: boolean;
    readonly failedChecks: string[];
  };
}

export interface VerifyRequest {
  readonly session_id: SessionId;
  readonly task_id: WorkItemId;
  readonly task_spec?: {
    readonly checks?: string[];
  };
  // GIT-SAFETY (a): required, not optional — the caller must always supply the
  // real task working directory / git root. verify-core validates both are
  // non-empty absolute paths and fails closed rather than defaulting to the
  // host process's ambient cwd (see verify-core.ts's GIT-SAFETY note).
  readonly working_directory: string;
  readonly git_root: string;
}

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

export interface TierResult {
  readonly status: "pass" | "fail" | "skipped" | "error";
  readonly details: string;
  readonly checks?: CheckResult[];
  readonly issues?: string[];
}

export interface VerifyResponse {
  readonly session_id: SessionId;
  readonly passed: boolean;
  readonly tiers: {
    readonly deterministic: TierResult;
  };
}
