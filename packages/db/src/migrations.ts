import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";

// The runner owns its tracking table, so the table and its columns are created
// here, not by a numbered migration: a numbered migration cannot describe the
// table that records whether it ran.
const TRACKING_TABLE = "schema_migrations";

/** The repository's migrations/ directory, anchored to this module's location. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

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

/** A migration file's SQL failed to apply; the transaction was rolled back. */
class MigrationApplyError extends Error {
  readonly filename: string;
  readonly pg: PgDiagnostics | undefined;
  readonly rollbackFailed: boolean;

  constructor(filename: string, cause: unknown, rollbackFailed: boolean) {
    const baseMessage = cause instanceof Error ? cause.message : String(cause);
    const pgDiag = extractPgDiagnostics(cause);

    const parts = [`Migration failed [${filename}]: ${baseMessage}`];
    if (pgDiag?.code) parts.push(`code=${pgDiag.code}`);
    if (pgDiag?.position) parts.push(`position=${pgDiag.position}`);
    if (pgDiag?.detail) parts.push(`detail: ${pgDiag.detail}`);
    if (pgDiag?.hint) parts.push(`hint: ${pgDiag.hint}`);
    if (pgDiag?.where) parts.push(`where: ${pgDiag.where}`);
    if (pgDiag?.schema) parts.push(`schema=${pgDiag.schema}`);
    if (pgDiag?.table) parts.push(`table=${pgDiag.table}`);
    if (pgDiag?.constraint) parts.push(`constraint=${pgDiag.constraint}`);
    if (rollbackFailed) parts.push("ROLLBACK ALSO FAILED — database state unknown");

    super(parts.join(" | "), { cause });
    this.name = "MigrationApplyError";
    this.filename = filename;
    this.pg = pgDiag;
    this.rollbackFailed = rollbackFailed;
  }
}

type MigrationDriftKind =
  | "hash_mismatch"
  | "not_applied"
  | "hash_unrecorded"
  | "applied_without_file"
  | "tracking_table_missing"
  | "no_migration_files";

/**
 * The database's applied migrations disagree with the files in migrations/.
 * Fail closed: the schema the code believes in is not the schema that exists.
 */
export class MigrationDriftError extends Error {
  readonly kind: MigrationDriftKind;
  readonly filename: string | undefined;
  readonly migrationsDir: string;
  readonly storedSha256: string | undefined;
  readonly fileSha256: string | undefined;

  constructor(args: {
    kind: MigrationDriftKind;
    filename: string | undefined;
    migrationsDir: string;
    storedSha256?: string;
    fileSha256?: string;
  }) {
    const subject = args.filename === undefined ? "" : ` [${args.filename}]`;
    const detail: Record<MigrationDriftKind, string> = {
      hash_mismatch:
        `applied content differs from the file: stored sha256=${args.storedSha256 ?? "?"}, ` +
        `file sha256=${args.fileSha256 ?? "?"}. The database ran a different draft of this ` +
        "migration; repair the schema by hand or write a new migration, never edit an applied one",
      not_applied: "file exists but is not applied; run `just migrate`",
      hash_unrecorded:
        "applied, but no content hash is recorded; run `just migrate` once to backfill hashes",
      applied_without_file:
        "recorded as applied, but no such file exists; it was renamed or deleted after it ran",
      tracking_table_missing: `table ${TRACKING_TABLE} does not exist; run \`just migrate\``,
      no_migration_files: "the migrations directory holds no .sql file, so no schema can be vouched for",
    };
    super(`Migration drift (${args.kind})${subject}: ${detail[args.kind]} | dir=${args.migrationsDir}`);
    this.name = "MigrationDriftError";
    this.kind = args.kind;
    this.filename = args.filename;
    this.migrationsDir = args.migrationsDir;
    this.storedSha256 = args.storedSha256;
    this.fileSha256 = args.fileSha256;
  }
}

interface MigrationFile {
  readonly filename: string;
  readonly sha256: string;
  readonly sql: string;
}

function readMigrationFiles(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const bytes = readFileSync(join(migrationsDir, filename));
      return {
        filename,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sql: bytes.toString("utf-8"),
      };
    });
  if (files.length === 0) {
    throw new MigrationDriftError({ kind: "no_migration_files", filename: undefined, migrationsDir });
  }
  return files;
}

const AppliedRowSchema = z.object({
  filename: z.string(),
  content_sha256: z.string().nullable(),
});

async function readApplied(client: pg.Client): Promise<Map<string, string | null>> {
  const result = await client.query(`SELECT filename, content_sha256 FROM ${TRACKING_TABLE}`);
  const rows = z.array(AppliedRowSchema).parse(result.rows);
  return new Map(rows.map((r) => [r.filename, r.content_sha256]));
}

/** First drift between files and applied rows, in filename order; `undefined` when none. */
function findDrift(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string | null>,
  migrationsDir: string,
  opts: { readonly pendingIsDrift: boolean },
): MigrationDriftError | undefined {
  const fileNames = new Set(files.map((f) => f.filename));
  const orphan = [...applied.keys()].sort().find((name) => !fileNames.has(name));
  if (orphan !== undefined) {
    return new MigrationDriftError({ kind: "applied_without_file", filename: orphan, migrationsDir });
  }
  for (const file of files) {
    if (!applied.has(file.filename)) {
      if (opts.pendingIsDrift) {
        return new MigrationDriftError({ kind: "not_applied", filename: file.filename, migrationsDir });
      }
      continue;
    }
    const stored = applied.get(file.filename);
    if (stored === null || stored === undefined) {
      return new MigrationDriftError({ kind: "hash_unrecorded", filename: file.filename, migrationsDir });
    }
    if (stored !== file.sha256) {
      return new MigrationDriftError({
        kind: "hash_mismatch",
        filename: file.filename,
        migrationsDir,
        storedSha256: stored,
        fileSha256: file.sha256,
      });
    }
  }
  return undefined;
}

async function applyMigration(client: pg.Client, file: MigrationFile): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query(file.sql);
    await client.query(
      `INSERT INTO ${TRACKING_TABLE} (filename, content_sha256) VALUES ($1, $2)`,
      [file.filename, file.sha256],
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
        `[migrate] WARN: ROLLBACK failed for ${file.filename}: ${detail}. ` +
          "Database state may be inconsistent — inspect manually before retrying.",
      );
    }
    throw new MigrationApplyError(file.filename, err, rollbackFailed);
  }
}

interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly backfilled: readonly string[];
  readonly alreadyApplied: number;
}

/**
 * Apply pending migrations in filename order, each in its own transaction, after
 * checking every already-applied file's content hash. A mismatch, or a recorded
 * migration with no file, throws MigrationDriftError before anything is applied.
 *
 * Rows applied before hashes were tracked carry a NULL hash; they are backfilled
 * with the current file's hash once, with a warning: the runner cannot know whether
 * the bytes that ran then are the bytes on disk now.
 */
export async function runMigrations(databaseUrl: string, migrationsDir: string): Promise<MigrationRunResult> {
  const files = readMigrationFiles(migrationsDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE ${TRACKING_TABLE} ADD COLUMN IF NOT EXISTS content_sha256 TEXT`);

    const applied = await readApplied(client);
    const backfill = files.filter((f) => applied.has(f.filename) && applied.get(f.filename) === null);
    if (backfill.length > 0) {
      await client.query("BEGIN");
      try {
        for (const file of backfill) {
          await client.query(
            `UPDATE ${TRACKING_TABLE} SET content_sha256 = $2 WHERE filename = $1 AND content_sha256 IS NULL`,
            [file.filename, file.sha256],
          );
          applied.set(file.filename, file.sha256);
        }
        await client.query("COMMIT");
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        throw err;
      }
      console.warn(
        `[migrate] WARN: backfilled content hashes for ${backfill.length} migration(s) applied before ` +
          `hashes were tracked: ${backfill.map((f) => f.filename).join(", ")}. The hash recorded is ` +
          "the file as it is NOW; whether the database ran these exact bytes is unknown and was not checked.",
      );
    }

    const drift = findDrift(files, applied, migrationsDir, { pendingIsDrift: false });
    if (drift !== undefined) throw drift;

    const pending = files.filter((f) => !applied.has(f.filename));
    for (const file of pending) {
      await applyMigration(client, file);
    }
    return {
      applied: pending.map((f) => f.filename),
      backfilled: backfill.map((f) => f.filename),
      alreadyApplied: files.length - pending.length,
    };
  } finally {
    await client.end();
  }
}

/**
 * Read-only startup check: every file in migrationsDir is applied with a matching
 * content hash, and nothing is recorded that has no file. Throws MigrationDriftError
 * naming the first missing or mismatched file.
 */
export async function assertMigrationsCurrent(databaseUrl: string, migrationsDir: string): Promise<void> {
  const files = readMigrationFiles(migrationsDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [TRACKING_TABLE]);
    const present = z.array(z.object({ present: z.boolean() })).length(1).parse(exists.rows)[0]?.present;
    if (present !== true) {
      throw new MigrationDriftError({ kind: "tracking_table_missing", filename: undefined, migrationsDir });
    }
    const hasHashColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'content_sha256'`,
      [TRACKING_TABLE],
    );
    if (hasHashColumn.rowCount === 0) {
      throw new MigrationDriftError({
        kind: "hash_unrecorded",
        filename: files[0]?.filename,
        migrationsDir,
      });
    }
    const drift = findDrift(files, await readApplied(client), migrationsDir, { pendingIsDrift: true });
    if (drift !== undefined) throw drift;
  } finally {
    await client.end();
  }
}
