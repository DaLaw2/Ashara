import type { SessionId, WorkItemId } from "@ashara/shared";

export interface TaskSpec {
  readonly goal: string;
  readonly endState: string;
  readonly scope: string;
  readonly deliverables: string[];
  readonly checks: string[];
}

export interface VerifyRequest {
  readonly session_id: SessionId;
  readonly task_id: WorkItemId;
  readonly task_spec?: {
    readonly checks?: string[];
  };
  /**
   * Executable checks extracted from the contract's knowledge-graph `check`
   * nodes (zero-enum). Passed through to `runVerifyCore.contractChecks`.
   */
  readonly contractChecks?: readonly string[];
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

export type VerifyVerdict = "passed" | "failed" | "unverified";

export interface VerifyResponse {
  readonly session_id: SessionId;
  readonly verdict: VerifyVerdict;
  readonly tiers: {
    readonly deterministic: TierResult;
  };
}
