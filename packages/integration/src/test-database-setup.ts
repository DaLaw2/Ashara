import { readyTestDatabase } from "@ashara/db";

// vitest's globalSetup: every run, `just test` or a direct `npx vitest`, starts on a migrated test
// database or stops before any test with the reason, naming `just test-db-up` when the test Postgres
// does not answer.

/** @testseam vitest.config.ts names this file as globalSetup, a reference knip does not read */
export default async function setup(): Promise<void> {
  await readyTestDatabase(process.env);
}
