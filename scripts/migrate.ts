/**
 * Apply SQL migrations in sorted filename order with applied-migration tracking.
 *
 * The runner lives in @ashara/db (`runMigrations`) so the server's startup check
 * (`assertMigrationsCurrent`) reads the same table the same way: each applied file
 * is recorded by name and sha256 in `schema_migrations`, a run refuses to apply
 * anything when an applied file's bytes changed since (MigrationDriftError), and
 * each pending file runs in its own transaction. A database that ran every numbered
 * file 000_init.sql stands in for has the init recorded instead of run.
 *
 * The database URL is `DATABASE_URL` when set, otherwise the policy default
 * `DEFAULT_DATABASE_URL` from @ashara/db, the same resolution the server uses: the
 * shared database `just dev` starts. Tests never use it; they run on the test Postgres,
 * which `just test` migrates itself (scripts/test-db-ready.ts). CI sets DATABASE_URL
 * explicitly; a local run needs nothing.
 *
 * Usage: npx tsx scripts/migrate.ts
 */

import { DEFAULT_DATABASE_URL, MIGRATIONS_DIR, runMigrations } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

  const result = await runMigrations(databaseUrl, MIGRATIONS_DIR);
  for (const filename of result.baselined) {
    console.log(`  Baselined ${filename}: recorded as applied, the database already ran every file it stands in for`);
  }
  for (const filename of result.applied) console.log(`  Applied ${filename}`);
  const backfilled = result.backfilled.length > 0 ? `, ${result.backfilled.length} hash(es) backfilled` : "";
  console.log(
    `${result.alreadyApplied} already applied (hashes verified), ${result.applied.length} applied now${backfilled}.`,
  );
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
