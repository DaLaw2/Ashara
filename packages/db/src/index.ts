export { DEFAULT_DATABASE_URL, createDb, createPgPool } from "./connection.js";
export { assertTestDatabaseReachable, readyTestDatabase, resolveSimulatorDatabaseUrl, resolveTestDatabaseUrl } from "./test-database-url.js";
export type { Database, DbHandle, DbTransaction, PoolFactory } from "./connection.js";

export type { PgListener } from "./listener.js";
export { listenForEvents } from "./listener.js";
export { TargetCheckoutClaimedElsewhere, claimTargetCheckouts } from "./target-claim.js";
export type { TargetCheckoutClaims } from "./target-claim.js";
export { insertedRow } from "./inserted-row.js";
export { qualifiedColumn } from "./qualified-column.js";
export { isDatabaseConnectionFault } from "./connection-fault.js";

// The shared tables only: a context's own tables are reached through its @ashara/db/schema/<context>
// entry, which boundary-rules.toml admits to that context, the composition root and the test harness.
export { PROJECT_LIFECYCLES, projects } from "./schema/project.js";
export { domainEvents } from "./schema/events.js";

export { ProjectRepository, projectRowColumns, toProjectRow } from "./repositories/project.js";
export type { ProjectRow } from "./repositories/project.js";
export { stepFaultLedger } from "./repositories/step-fault.js";
export { ClientSessionRepository } from "./repositories/client-session.js";
export { ClientRepository } from "./repositories/client.js";
export { ClientLoginFailureRepository } from "./repositories/client-login-failure.js";
export type { LoginAttemptCaps } from "./repositories/client-login-failure.js";
export { EventStoreRepository } from "./repositories/event-store.js";
export { legacyMigrationFile } from "./legacy-migrations.js";
export { firstAppliedAt } from "./migration-reads.js";
export {
  INIT_MIGRATION,
  MIGRATIONS_DIR,
  MigrationBaselineError,
  MigrationDriftError,
  assertMigrationsCurrent,
  runMigrations,
} from "./migrations.js";
