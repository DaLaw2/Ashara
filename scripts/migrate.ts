/**
 * Apply SQL migrations in sorted filename order with applied-migration tracking.
 *
 * Creates a `schema_migrations` table to record what has been applied, and skips
 * files already recorded there. Each migration runs inside a transaction so a
 * failure rolls back cleanly and names the file that broke.
 *
 * The database URL is `DATABASE_URL` when set, otherwise the policy default
 * `DEFAULT_DATABASE_URL` from @ashara/db, the same resolution the server and the
 * test suites use. CI sets DATABASE_URL explicitly; a local run needs nothing.
 *
 * Usage: npx tsx scripts/migrate.ts
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "@ashara/db";

// ---------------------------------------------------------------------------
// Typed errors (Discipline C)
// ---------------------------------------------------------------------------

interface PgDiagnostics {
  readonly code: string | undefined;
  readonly position: string | undefined;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly where: string | undefined;
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly constraint: string | undefined;
}

function extractPgDiagnostics(err: unknown): PgDiagnostics | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (!("code" in err) || typeof err.code !== "string") return undefined;
  return {
    code: err.code,
    position: "position" in err && typeof err.position === "string" ? err.position : undefined,
    detail: "detail" in err && typeof err.detail === "string" ? err.detail : undefined,
    hint: "hint" in err && typeof err.hint === "string" ? err.hint : undefined,
    where: "where" in err && typeof err.where === "string" ? err.where : undefined,
    schema: "schema" in err && typeof err.schema === "string" ? err.schema : undefined,
    table: "table" in err && typeof err.table === "string" ? err.table : undefined,
    constraint: "constraint" in err && typeof err.constraint === "string" ? err.constraint : undefined,
  };
}

class MigrationError extends Error {
  readonly filename: string;
  readonly pg: PgDiagnostics | undefined;
  readonly rollbackFailed: boolean;

  constructor(filename: string, cause: unknown, rollbackFailed: boolean) {
    const baseMessage = cause instanceof Error ? cause.message : String(cause);
    const pg = extractPgDiagnostics(cause);

    const parts = [`Migration failed [${filename}]: ${baseMessage}`];
    if (pg?.code) parts.push(`code=${pg.code}`);
    if (pg?.position) parts.push(`position=${pg.position}`);
    if (pg?.detail) parts.push(`detail: ${pg.detail}`);
    if (pg?.hint) parts.push(`hint: ${pg.hint}`);
    if (pg?.where) parts.push(`where: ${pg.where}`);
    if (pg?.schema) parts.push(`schema=${pg.schema}`);
    if (pg?.table) parts.push(`table=${pg.table}`);
    if (pg?.constraint) parts.push(`constraint=${pg.constraint}`);
    if (rollbackFailed) parts.push("ROLLBACK ALSO FAILED — database state unknown");

    super(parts.join(" | "), { cause });
    this.name = "MigrationError";
    this.filename = filename;
    this.pg = pg;
    this.rollbackFailed = rollbackFailed;
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

const TRACKING_TABLE = "schema_migrations";

async function ensureTrackingTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedFilenames(client: pg.Client): Promise<ReadonlySet<string>> {
  const result = await client.query<{ filename: string }>(
    `SELECT filename FROM ${TRACKING_TABLE}`,
  );
  return new Set(result.rows.map((r) => r.filename));
}

function discoverMigrations(migrationsDir: string): string[] {
  const entries = fs.readdirSync(migrationsDir);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function applyMigration(
  client: pg.Client,
  migrationsDir: string,
  filename: string,
): Promise<void> {
  const filePath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(filePath, "utf-8");

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      `INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1)`,
      [filename],
    );
    await client.query("COMMIT");
  } catch (err: unknown) {
    let rollbackFailed = false;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr: unknown) {
      rollbackFailed = true;
      const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      console.warn(
        `[migrate] WARN: ROLLBACK failed for ${filename}: ${detail}. ` +
          "Database state may be inconsistent — inspect manually before retrying.",
      );
    }
    const migrationErr = new MigrationError(filename, err, rollbackFailed);
    throw migrationErr;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

  const root = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  const migrationsDir = path.join(root, "migrations");

  const sqlFiles = discoverMigrations(migrationsDir);
  if (sqlFiles.length === 0) {
    console.log("No .sql files found in migrations/. Nothing to do.");
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureTrackingTable(client);
    const applied = await appliedFilenames(client);

    const pending = sqlFiles.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log(
        `All ${sqlFiles.length} migration(s) already applied. Nothing to do.`,
      );
      return;
    }

    console.log(
      `${applied.size} already applied, ${pending.length} pending.\n`,
    );

    for (const filename of pending) {
      process.stdout.write(`  Applying ${filename} ... `);
      await applyMigration(client, migrationsDir, filename);
      console.log("done.");
    }

    console.log(`\n${pending.length} migration(s) applied successfully.`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
