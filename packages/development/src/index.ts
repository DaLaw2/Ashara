export type { ProjectIntentSource } from "./project-intent.js";

export { DevelopmentService } from "./execution-service.js";
/** @testseam execution-service.test.ts checks it names every status; the lifecycle model of story s-independent-verify-m1 L2 is its consumer */
export { EXECUTION_STATUSES } from "./execution-service.js";
export { assertValidTargetProjectPath, InvalidTargetProjectPath } from "./workspace.js";
export { discardTaskBranch } from "./merge.js";
export { currentEnvironmentBuilt, pruneStaleEnvironmentImages } from "./current-environment.js";
export type { EnvironmentImages } from "./environment-check.js";
export type { KnowledgeSink, KnowledgeSource } from "./knowledge-writer.js";
export type { TaskCheckStore } from "./task-checks.js";
export { SuiteReviewer } from "./suite-review.js";
export type { SuiteReviewSource } from "./suite-review.js";
export type {
  AgentStaffing,
  ContractSource,
  SessionStore,
  ExecutionEventSink,
  TaskDescriptor,
} from "./execution-service.js";
