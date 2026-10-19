/**
 * Readies the test Postgres before a test run (`readyTestDatabase`): resolves its URL as every test
 * does (TEST_DATABASE_URL, else the test server, never the shared database), fails closed naming
 * `just test-db-up` when the server does not answer, and applies the migrations, since the test
 * server keeps its data in tmpfs and starts empty.
 *
 * Usage: npx tsx scripts/test-db-ready.ts
 */

import { readyTestDatabase } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";

async function main(): Promise<void> {
  const result = await readyTestDatabase(process.env);
  console.log(`test database: ${result.alreadyApplied} migration(s) already applied, ${result.applied.length} applied now`);
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
