export { DEFAULT_DATABASE_URL, createDb, createPgPool } from "./connection.js";
export { assertTestDatabaseReachable, resolveTestDatabaseUrl } from "./test-database-url.js";
export type { Database, DbHandle, DbTransaction, PoolFactory } from "./connection.js";

export type { PgListener } from "./listener.js";
export { listenForEvents } from "./listener.js";
export { TargetCheckoutClaimedElsewhere, claimTargetCheckouts } from "./target-claim.js";
export { insertedRow } from "./inserted-row.js";
export { isDatabaseConnectionFault } from "./connection-fault.js";

export {
  PROJECT_BLOCK_KINDS,
  PROJECT_LIFECYCLES,
  acceptanceSweeps,
  checkDisputes,
  checkSetFreezes,
  clientMessages,
  dependencies,
  domainEvents,
  devSessions,
  failedApproaches,
  intakeReadings,
  knowledgeEntries,
  planRepairs,
  planRevisions,
  projectBlocks,
  projects,
  replanRequests,
  suiteReviewClaims,
  suiteReviewFindings,
  suiteReviewJudgements,
  taskChecks,
  undecidedItemClaims,
  undecidedItems,
  visionDocuments,
  workBurnWarnings,
  workItems,
} from "./schema/index.js";

export { ProjectRepository, noOpenAnswer, noOpenStop, pendingChange, pendingRepair, projectAtWork, projectHalted } from "./repositories/project.js";
export type { ProjectRecord } from "./repositories/project.js";
export { latestRosterRevision, latestRosterRoles, listProjectsAwaitingRoster, recordFirstRoster } from "./repositories/roster.js";
export { completedGoalTasks, goalTaskSql, isGoalTask } from "./repositories/goal-tasks.js";
export { stepFaultLedger } from "./repositories/step-fault.js";
export { ClientSessionRepository } from "./repositories/client-session.js";
export { ClientRepository } from "./repositories/client.js";
export { ClientLoginFailureRepository } from "./repositories/client-login-failure.js";
export type { LoginAttemptCaps } from "./repositories/client-login-failure.js";
export { EventStoreRepository } from "./repositories/event-store.js";
export { ConfigRepository } from "./repositories/config.js";
export { SecretRepository } from "./repositories/secret.js";
export { LlmCallRepository } from "./repositories/llm-call.js";
export type { LlmCallMeasurement } from "./repositories/llm-call.js";
export { WorkGrantRepository } from "./repositories/work-grant.js";
export { EnvironmentBuildRepository } from "./repositories/environment-build.js";
export {
  MIGRATIONS_DIR,
  MigrationBaselineError,
  MigrationDriftError,
  assertMigrationsCurrent,
  runMigrations,
} from "./migrations.js";
