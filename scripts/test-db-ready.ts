/**
 * Readies the test Postgres before a test run: resolves its URL as every test does
 * (`resolveTestDatabaseUrl`: TEST_DATABASE_URL, else the test server, never the shared database),
 * fails closed naming `just test-db-up` when the server does not answer, and applies the
 * migrations, since the test server keeps its data in tmpfs and starts empty.
 *
 * Usage: npx tsx scripts/test-db-ready.ts
 */

import { MIGRATIONS_DIR, assertTestDatabaseReachable, resolveTestDatabaseUrl, runMigrations } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";

async function main(): Promise<void> {
  const databaseUrl = resolveTestDatabaseUrl(process.env);
  await assertTestDatabaseReachable(databaseUrl);
  const result = await runMigrations(databaseUrl, MIGRATIONS_DIR);
  console.log(`test database: ${result.alreadyApplied} migration(s) already applied, ${result.applied.length} applied now`);
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
