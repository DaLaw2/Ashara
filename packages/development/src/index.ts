export type { ProjectIntentSource } from "./project-intent.js";

export { DevelopmentService } from "./execution-service.js";
/** @testseam scripts/run-report.test.ts drives a scripted attempt through the session's terminal write */
export { withSessionLifecycle } from "./execution-service.js";
/** @testseam scripts/run-report.test.ts maps its scripted attempt as runExecution does */
export { toSessionAttempt } from "./cell-execution.js";
export { EXECUTION_STATUSES } from "./execution-service.js";
export { assertValidTargetProjectPath, InvalidTargetProjectPath } from "./workspace.js";
export { canonicalizeAllowingMissing } from "./checkout-lock.js";
export { probeEnvironmentWrite } from "./gates/environment-write-probe.js";
export { pruneStaleEnvironmentImages } from "./current-environment.js";
export type { EnvironmentImages } from "./environment-check.js";
export type { KnowledgeSink, KnowledgeSource } from "./knowledge-writer.js";
export type { TaskCheckStore } from "./task-checks.js";
export { SuiteReviewer, gitPublicInterface } from "./suite-review.js";
export type { SuiteReviewSource } from "./suite-review.js";
export type {
  AgentStaffing,
  ContractSource,
  SessionStore,
  ExecutionEventSink,
  TaskDescriptor,
} from "./execution-service.js";
