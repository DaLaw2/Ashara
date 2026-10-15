export { DEFAULT_DATABASE_URL, createDb, createPgPool } from "./connection.js";
export type { Database, DbHandle, DbTransaction, PoolFactory } from "./connection.js";

export type { PgListener } from "./listener.js";
export { listenForEvents } from "./listener.js";
export { TargetCheckoutClaimedElsewhere, claimTargetCheckouts } from "./target-claim.js";

export {
  PROJECT_BLOCK_KINDS,
  acceptanceSweeps,
  checkDisputes,
  clientMessages,
  domainEvents,
  planRepairs,
  projectBlocks,
  projects,
  replanRequests,
  taskChecks,
  visionDocuments,
  workItems,
} from "./schema/index.js";

export { WorkItemRepository } from "./repositories/work-item.js";
export { DevSessionRepository } from "./repositories/dev-session.js";
export { readRunEvidence } from "./repositories/run-report.js";
export { ProjectRepository, noOpenStop } from "./repositories/project.js";
export type { ProjectRecord } from "./repositories/project.js";
export {
  listProjectsAwaitingFirstPlan,
  withFirstPlanTransaction,
  recordFirstPlanFailure,
  stopFirstPlanning,
} from "./repositories/first-plan.js";
export { latestRosterRevision, latestRosterRoles, listProjectsAwaitingRoster, recordFirstRoster } from "./repositories/roster.js";
export { listDuePlanReports, postPlanReport } from "./repositories/plan-report.js";
export {
  listDuePlanRevisionReports,
  listProjectsAwaitingReplan,
  postPlanRevisionReport,
  recordReplanFailure,
  withPlanRevisionTransaction,
} from "./repositories/replan.js";
export {
  completedGoalTasks,
  listProjectsReadyForAcceptance,
  recordAcceptance,
  recordAcceptanceDefect,
  recordAcceptanceSweepFault,
} from "./repositories/acceptance.js";
export { ClientSessionRepository } from "./repositories/client-session.js";
export { ClientRepository } from "./repositories/client.js";
export { ClientLoginFailureRepository } from "./repositories/client-login-failure.js";
export type { LoginAttemptCaps } from "./repositories/client-login-failure.js";
export { EventStoreRepository } from "./repositories/event-store.js";
export { KnowledgeRepository } from "./repositories/knowledge.js";
export { FailedApproachRepository } from "./repositories/failed-approach.js";
export { ConfigRepository } from "./repositories/config.js";
export { SecretRepository } from "./repositories/secret.js";
export { LlmCallRepository } from "./repositories/llm-call.js";
export type { LlmCallMeasurement } from "./repositories/llm-call.js";
export { EnvironmentBuildRepository } from "./repositories/environment-build.js";
export { TaskCheckRepository } from "./repositories/task-check.js";
export { CheckDisputeRepository } from "./repositories/check-dispute.js";
export { SuiteReviewFindingRepository, blockingReview } from "./repositories/suite-review.js";
export {
  MIGRATIONS_DIR,
  MigrationDriftError,
  assertMigrationsCurrent,
  runMigrations,
} from "./migrations.js";
