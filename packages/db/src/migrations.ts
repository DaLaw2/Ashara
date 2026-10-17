import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { LEGACY_MIGRATIONS } from "./legacy-migrations.js";

// The runner owns its tracking table, so the table and its columns are created
// here, not by a numbered migration: a numbered migration cannot describe the
// table that records whether it ran.
const TRACKING_TABLE = "schema_migrations";

// The session-level advisory lock every migration run holds from connect to end, so two
// runners against one database serialize instead of racing on the same pending file.
// A fixed literal: every runner, in every process, must name the same key.
const MIGRATION_LOCK_KEY = 7_212_345_501;

/** The repository's migrations/ directory, anchored to this module's location. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/** The file a new database starts from; LEGACY_MIGRATIONS lists the numbered files it stands in for. */
const INIT_MIGRATION = "000_init.sql";

const LEGACY_SHA256 = new Map(LEGACY_MIGRATIONS.map((m) => [m.filename, m.sha256]));

interface LegacyHashMismatch {
  readonly filename: string;
  /** null when the row records no hash. */
  readonly storedSha256: string | null;
  readonly manifestSha256: string;
}

type BaselineRefusal =
  | {
      readonly kind: "legacy_incomplete";
      readonly missing: readonly string[];
      readonly mismatched: readonly LegacyHashMismatch[];
    }
  | { readonly kind: "init_file_missing" };

/**
 * schema_migrations lists some of the numbered files 000_init.sql stands in for, but not every one
 * with its recorded hash, or the init file to record is not in the directory. The database holds a
 * schema the init does not describe, so recording the init as applied would vouch for a schema
 * that does not exist. Fail closed, naming every missing and every mismatched file.
 */
export class MigrationBaselineError extends Error {
  readonly refusal: BaselineRefusal;
  readonly migrationsDir: string;

  constructor(refusal: BaselineRefusal, migrationsDir: string) {
    super(`Migration baseline refused: ${describeRefusal(refusal)} | dir=${migrationsDir}`);
    this.name = "MigrationBaselineError";
    this.refusal = refusal;
    this.migrationsDir = migrationsDir;
  }
}

function describeRefusal(refusal: BaselineRefusal): string {
  switch (refusal.kind) {
    case "init_file_missing":
      return (
        `schema_migrations lists all ${LEGACY_MIGRATIONS.length} numbered files ${INIT_MIGRATION} stands in for, ` +
        `but ${INIT_MIGRATION} is not in the migrations directory, so there is no file to record as applied`
      );
    case "legacy_incomplete": {
      const parts = [
        `schema_migrations lists ${LEGACY_MIGRATIONS.length - refusal.missing.length} of the ` +
          `${LEGACY_MIGRATIONS.length} numbered files ${INIT_MIGRATION} stands in for`,
      ];
      if (refusal.missing.length > 0) parts.push(`missing: ${refusal.missing.join(", ")}`);
      for (const m of refusal.mismatched) {
        parts.push(
          `[${m.filename}] stored sha256=${m.storedSha256 ?? "(none)"}, expected sha256=${m.manifestSha256}`,
        );
      }
      parts.push(
        `the database holds a schema ${INIT_MIGRATION} does not describe; bring it to the last numbered file ` +
          "from a checkout that still has those files, then run `just migrate` again",
      );
      return parts.join("; ");
    }
  }
}

/**
 * Whether the database ran the numbered files 000_init.sql stands in for: "none" when it lists none
 * of them, "complete" when it lists every one with its recorded hash. Anything between throws.
 */
function legacyState(applied: ReadonlyMap<string, string | null>, migrationsDir: string): "none" | "complete" {
  const listed = LEGACY_MIGRATIONS.filter((m) => applied.has(m.filename));
  if (listed.length === 0) return "none";
  const missing = LEGACY_MIGRATIONS.filter((m) => !applied.has(m.filename)).map((m) => m.filename);
  const mismatched = listed.flatMap((m): LegacyHashMismatch[] => {
    const stored = applied.get(m.filename) ?? null;
    return stored === m.sha256 ? [] : [{ filename: m.filename, storedSha256: stored, manifestSha256: m.sha256 }];
  });
  if (missing.length > 0 || mismatched.length > 0) {
    throw new MigrationBaselineError({ kind: "legacy_incomplete", missing, mismatched }, migrationsDir);
  }
  return "complete";
}

/**
 * The init file a database that ran every numbered file is recorded against. Its absence is a
 * baseline refusal, not drift: the database is sound, the directory cannot describe it.
 */
function initFileFor(files: readonly MigrationFile[], migrationsDir: string): MigrationFile {
  const init = files.find((f) => f.filename === INIT_MIGRATION);
  if (init === undefined) throw new MigrationBaselineError({ kind: "init_file_missing" }, migrationsDir);
  return init;
}

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


type TransactionOperation = "apply" | "backfill_hashes" | "baseline";

/**
 * A migration transaction failed and was rolled back. The original error is the `cause`;
 * a ROLLBACK that also failed is attached as `rollbackError`, never in the original's place.
 */
class MigrationTransactionError extends Error {
  readonly operation: TransactionOperation;
  readonly filenames: readonly string[];
  readonly pg: PgDiagnostics | undefined;
  readonly rollbackError: unknown;

  constructor(args: {
    operation: TransactionOperation;
    filenames: readonly string[];
    cause: unknown;
    rollbackError: unknown;
  }) {
    const pgDiag = extractPgDiagnostics(args.cause);
    const label = {
      apply: "Migration failed",
      backfill_hashes: "Migration hash backfill failed",
      baseline: "Migration baseline failed",
    }[args.operation];
    const parts = [`${label} [${args.filenames.join(", ")}]: ${describeErrorChain(args.cause)}`];
    if (pgDiag?.code) parts.push(`code=${pgDiag.code}`);
    if (pgDiag?.position) parts.push(`position=${pgDiag.position}`);
    if (pgDiag?.detail) parts.push(`detail: ${pgDiag.detail}`);
    if (pgDiag?.hint) parts.push(`hint: ${pgDiag.hint}`);
    if (pgDiag?.where) parts.push(`where: ${pgDiag.where}`);
    if (pgDiag?.schema) parts.push(`schema=${pgDiag.schema}`);
    if (pgDiag?.table) parts.push(`table=${pgDiag.table}`);
    if (pgDiag?.constraint) parts.push(`constraint=${pgDiag.constraint}`);
    if (args.rollbackError !== undefined) {
      parts.push(`ROLLBACK ALSO FAILED (${describeErrorChain(args.rollbackError)}): database state unknown, inspect it before retrying`);
    }

    super(parts.join(" | "), { cause: args.cause });
    this.name = "MigrationTransactionError";
    this.operation = args.operation;
    this.filenames = args.filenames;
    this.pg = pgDiag;
    this.rollbackError = args.rollbackError;
  }
}

/**
 * One disagreement between migrations/ and schema_migrations. The two kinds that name no
 * file describe the whole directory or the whole table.
 */
type MigrationDrift =
  | {
      readonly kind: "hash_mismatch";
      readonly filename: string;
      readonly storedSha256: string;
      readonly fileSha256: string;
    }
  | { readonly kind: "not_applied" | "hash_unrecorded" | "applied_without_file"; readonly filename: string }
  | { readonly kind: "tracking_table_missing" | "no_migration_files" };

type NonEmpty<T> = readonly [T, ...T[]];

function describeDrift(drift: MigrationDrift): string {
  switch (drift.kind) {
    case "hash_mismatch":
      return (
        `[${drift.filename}] applied content differs from the file: stored sha256=${drift.storedSha256}, ` +
        `file sha256=${drift.fileSha256}. The database ran a different draft of this migration; repair the ` +
        "schema by hand or write a new migration, never edit an applied one"
      );
    case "not_applied":
      return `[${drift.filename}] file exists but is not applied; run \`just migrate\``;
    case "hash_unrecorded":
      return `[${drift.filename}] applied, but no content hash is recorded; run \`just migrate\` once to backfill hashes`;
    case "applied_without_file":
      return `[${drift.filename}] recorded as applied, but no such file exists; it was renamed or deleted after it ran`;
    case "tracking_table_missing":
      return `table ${TRACKING_TABLE} does not exist; run \`just migrate\``;
    case "no_migration_files":
      return "the migrations directory holds no .sql file, so no schema can be vouched for";
  }
}

/**
 * The database's applied migrations disagree with the files in migrations/.
 * Fail closed: the schema the code believes in is not the schema that exists.
 * Every drift found is listed, in filename order, never only the first.
 */
export class MigrationDriftError extends Error {
  readonly drifts: NonEmpty<MigrationDrift>;
  readonly migrationsDir: string;

  constructor(drifts: NonEmpty<MigrationDrift>, migrationsDir: string) {
    const kinds = [...new Set(drifts.map((d) => d.kind))].join(", ");
    super(`Migration drift (${kinds}): ${drifts.map(describeDrift).join("; ")} | dir=${migrationsDir}`);
    this.name = "MigrationDriftError";
    this.drifts = drifts;
    this.migrationsDir = migrationsDir;
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
    throw new MigrationDriftError([{ kind: "no_migration_files" }], migrationsDir);
  }
  return files;
}

/**
 * A client that has lost its connection while idle emits 'error'; without a listener that
 * event kills the process. The loss itself surfaces as the next query's rejection.
 */
async function connectClient(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  client.on("error", (err: Error) => {
    console.warn(`[migrate] WARN: the migration connection reported an error while idle: ${describeErrorChain(err)}`);
  });
  await client.connect();
  return client;
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

/**
 * Every drift between files and applied rows, in filename order; `undefined` when none. Rows of the
 * numbered files 000_init.sql stands in for are not drift: legacyState has vouched for them.
 */
function findDrift(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string | null>,
  migrationsDir: string,
  opts: { readonly pendingIsDrift: boolean },
): MigrationDriftError | undefined {
  const fileNames = new Set(files.map((f) => f.filename));
  const drifts: MigrationDrift[] = [...applied.keys()]
    .filter((name) => !fileNames.has(name) && !LEGACY_SHA256.has(name))
    .map((filename) => ({ kind: "applied_without_file", filename }));
  for (const file of files) {
    if (!applied.has(file.filename)) {
      if (opts.pendingIsDrift) drifts.push({ kind: "not_applied", filename: file.filename });
      continue;
    }
    const stored = applied.get(file.filename);
    if (stored === null || stored === undefined) {
      drifts.push({ kind: "hash_unrecorded", filename: file.filename });
    } else if (stored !== file.sha256) {
      drifts.push({ kind: "hash_mismatch", filename: file.filename, storedSha256: stored, fileSha256: file.sha256 });
    }
  }
  drifts.sort((a, b) => ("filename" in a ? a.filename : "").localeCompare("filename" in b ? b.filename : ""));
  const [first, ...rest] = drifts;
  return first === undefined ? undefined : new MigrationDriftError([first, ...rest], migrationsDir);
}

/**
 * Runs `body` inside BEGIN/COMMIT. On failure the transaction is rolled back, and the error
 * thrown carries the body's error as its cause; a failing ROLLBACK is attached beside it.
 */
async function inTransaction(
  client: pg.Client,
  operation: TransactionOperation,
  filenames: readonly string[],
  body: () => Promise<void>,
): Promise<void> {
  try {
    await client.query("BEGIN");
    await body();
    await client.query("COMMIT");
  } catch (err: unknown) {
    let rollbackError: unknown = undefined;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr: unknown) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failed ROLLBACK is kept as rollbackError and thrown with the body's error in MigrationTransactionError below
      rollbackError = rollbackErr;
    }
    throw new MigrationTransactionError({ operation, filenames, cause: err, rollbackError });
  }
}

interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly backfilled: readonly string[];
  /** The init recorded as applied without running it, because the database ran every file it stands in for. */
  readonly baselined: readonly string[];
  readonly alreadyApplied: number;
}

/**
 * Apply pending migrations in filename order, each in its own transaction, after
 * checking every already-applied file's content hash. A mismatch, or a recorded
 * migration with no file, throws MigrationDriftError before anything is applied.
 * The whole run holds a database-wide advisory lock, so concurrent runs serialize.
 *
 * Rows applied before hashes were tracked carry a NULL hash; they are backfilled
 * with the current file's hash once, with a warning: the runner cannot know whether
 * the bytes that ran then are the bytes on disk now.
 *
 * A database that ran every numbered file 000_init.sql stands in for, each with its
 * recorded hash, has the init recorded as applied without running it; no row is
 * removed. One that ran some of them, or ran one with a different hash, throws
 * MigrationBaselineError before anything is written. An empty database runs the init.
 */
export async function runMigrations(databaseUrl: string, migrationsDir: string): Promise<MigrationRunResult> {
  const files = readMigrationFiles(migrationsDir);
  const client = await connectClient(databaseUrl);
  try {
    // Held until client.end(): a session-level lock is released when its session closes.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
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
      await inTransaction(client, "backfill_hashes", backfill.map((f) => f.filename), async () => {
        for (const file of backfill) {
          await client.query(
            `UPDATE ${TRACKING_TABLE} SET content_sha256 = $2 WHERE filename = $1 AND content_sha256 IS NULL`,
            [file.filename, file.sha256],
          );
        }
      });
      for (const file of backfill) applied.set(file.filename, file.sha256);
      console.warn(
        `[migrate] WARN: backfilled content hashes for ${backfill.length} migration(s) applied before ` +
          `hashes were tracked: ${backfill.map((f) => f.filename).join(", ")}. The hash recorded is ` +
          "the file as it is NOW; whether the database ran these exact bytes is unknown and was not checked.",
      );
    }

    const baselined: string[] = [];
    if (legacyState(applied, migrationsDir) === "complete" && !applied.has(INIT_MIGRATION)) {
      const init = initFileFor(files, migrationsDir);
      await inTransaction(client, "baseline", [init.filename], async () => {
        await client.query(`INSERT INTO ${TRACKING_TABLE} (filename, content_sha256) VALUES ($1, $2)`, [
          init.filename,
          init.sha256,
        ]);
      });
      applied.set(init.filename, init.sha256);
      baselined.push(init.filename);
    }

    const drift = findDrift(files, applied, migrationsDir, { pendingIsDrift: false });
    if (drift !== undefined) throw drift;

    const pending = files.filter((f) => !applied.has(f.filename));
    // A migration reports what it did to existing rows (a backfill, a deletion) through RAISE
    // NOTICE; without a listener pg drops it and the count is never seen.
    client.on("notice", (notice) => {
      console.log(`  [migrate] ${notice.severity ?? "NOTICE"}: ${notice.message ?? "(no message)"}`);
    });
    for (const file of pending) {
      await inTransaction(client, "apply", [file.filename], async () => {
        await client.query(file.sql);
        await client.query(`INSERT INTO ${TRACKING_TABLE} (filename, content_sha256) VALUES ($1, $2)`, [
          file.filename,
          file.sha256,
        ]);
      });
    }
    return {
      applied: pending.map((f) => f.filename),
      backfilled: backfill.map((f) => f.filename),
      baselined,
      alreadyApplied: files.length - pending.length,
    };
  } finally {
    await client.end();
  }
}

/**
 * Read-only startup check: every file in migrationsDir is applied with a matching
 * content hash, and nothing is recorded that has no file. Throws MigrationDriftError
 * naming every missing, unhashed or mismatched file, and MigrationBaselineError when
 * the numbered files 000_init.sql stands in for are recorded only in part, or recorded in
 * full with no init file in the directory to record against them.
 */
export async function assertMigrationsCurrent(databaseUrl: string, migrationsDir: string): Promise<void> {
  const files = readMigrationFiles(migrationsDir);
  const client = await connectClient(databaseUrl);
  try {
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [TRACKING_TABLE]);
    const present = z.array(z.object({ present: z.boolean() })).length(1).parse(exists.rows)[0]?.present;
    if (present !== true) {
      throw new MigrationDriftError([{ kind: "tracking_table_missing" }], migrationsDir);
    }
    const hasHashColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'content_sha256'`,
      [TRACKING_TABLE],
    );
    let applied: Map<string, string | null>;
    if (hasHashColumn.rowCount === 0) {
      // A table from before hashes were tracked: every row it records is unhashed.
      const result = await client.query(`SELECT filename FROM ${TRACKING_TABLE}`);
      const rows = z.array(z.object({ filename: z.string() })).parse(result.rows);
      applied = new Map(rows.map((r) => [r.filename, null]));
    } else {
      applied = await readApplied(client);
    }
    if (legacyState(applied, migrationsDir) === "complete") initFileFor(files, migrationsDir);
    const drift = findDrift(files, applied, migrationsDir, { pendingIsDrift: true });
    if (drift !== undefined) throw drift;
  } finally {
    await client.end();
  }
}
