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
  dependencies,
  domainEvents,
  failedApproaches,
  knowledgeEntries,
  planRepairs,
  projectBlocks,
  projects,
  replanRequests,
  suiteReviewFindings,
  taskChecks,
  visionDocuments,
  workItems,
} from "./schema/index.js";

export { WorkItemRepository } from "./repositories/work-item.js";
export { DevSessionRepository } from "./repositories/dev-session.js";
export { readRunEvidence } from "./repositories/run-report.js";
export { ProjectRepository, noOpenStop, pendingChange, pendingRepair } from "./repositories/project.js";
export type { ProjectRecord } from "./repositories/project.js";
export {
  listProjectsAwaitingFirstPlan,
  noOpenAnswer,
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
export { completedGoalTasks } from "./repositories/goal-tasks.js";
export { ClientSessionRepository } from "./repositories/client-session.js";
export { ClientRepository } from "./repositories/client.js";
export { ClientLoginFailureRepository } from "./repositories/client-login-failure.js";
export type { LoginAttemptCaps } from "./repositories/client-login-failure.js";
export { EventStoreRepository } from "./repositories/event-store.js";
export { ConfigRepository } from "./repositories/config.js";
export { SecretRepository } from "./repositories/secret.js";
export { LlmCallRepository } from "./repositories/llm-call.js";
export type { LlmCallMeasurement } from "./repositories/llm-call.js";
export { EnvironmentBuildRepository } from "./repositories/environment-build.js";
export {
  MIGRATIONS_DIR,
  MigrationDriftError,
  assertMigrationsCurrent,
  runMigrations,
} from "./migrations.js";
