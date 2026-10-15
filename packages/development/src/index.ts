export type { ProjectIntentSource } from "./project-intent.js";
export { loadProjectIntent } from "./project-intent.js";

export { DevelopmentService } from "./execution-service.js";
/** @testseam scripts/run-report.test.ts drives a scripted attempt through the session's terminal write */
export { withSessionLifecycle } from "./execution-service.js";
/** @testseam scripts/run-report.test.ts maps its scripted attempt as runExecution does */
export { toSessionAttempt } from "./cell-execution.js";
export { EXECUTION_STATUSES } from "./execution-service.js";
export type { FaultClass } from "./fault-class.js";
export { taskMergeOnMain } from "./merge.js";
/** Delivery has no Execution Infrastructure edge (ADR-075): it checks a target workspace through Quality's merge reader. */
export { assertValidTargetProjectPath, InvalidTargetProjectPath } from "@ashara/execution-infra";
export { probeEnvironmentWrite } from "./gates/environment-write-probe.js";
export type { KnowledgeSink, KnowledgeSource } from "./knowledge-writer.js";
export type { TaskCheckStore } from "./task-checks.js";
export { SuiteReviewer, gitPublicInterface } from "./suite-review.js";
export type { SuiteReviewSource } from "./suite-review.js";
export type {
  AgentStaffing,
  SessionStore,
  ExecutionEventSink,
  TaskDescriptor,
} from "./execution-service.js";
