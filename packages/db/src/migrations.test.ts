import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { MigrationDriftError, assertMigrationsCurrent, runMigrations } from "./migrations.js";

// Each test owns a fresh Postgres schema (search_path pinned through the URL) and a
// temp migrations dir, so the database's real schema_migrations is never touched.
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

let schema: string;
let url: string;
let dir: string;

async function admin(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function driftOf(run: Promise<unknown>): Promise<MigrationDriftError> {
  const err: unknown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof MigrationDriftError)) throw new Error(`expected MigrationDriftError, got ${String(err)}`);
  return err;
}

beforeEach(async () => {
  schema = `mig_test_${randomBytes(6).toString("hex")}`;
  const u = new URL(DATABASE_URL);
  u.searchParams.set("options", `-c search_path=${schema}`);
  url = u.toString();
  await admin(`CREATE SCHEMA ${schema}`);
  dir = mkdtempSync(join(tmpdir(), "ashara-mig-"));
  writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
  writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id int);");
});

afterEach(async () => {
  await admin(`DROP SCHEMA ${schema} CASCADE`);
  rmSync(dir, { recursive: true, force: true });
});

describe("migration content hashes", () => {
  test("an applied file whose bytes changed fails closed naming file and both hashes", async () => {
    const first = await runMigrations(url, dir);
    expect(first.applied).toEqual(["001_a.sql", "002_b.sql"]);
    await assertMigrationsCurrent(url, dir);

    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id int, extra text);");
    writeFileSync(join(dir, "003_c.sql"), "CREATE TABLE c (id int);");

    const onMigrate = await driftOf(runMigrations(url, dir));
    expect(onMigrate.drifts).toHaveLength(1);
    const mismatch = onMigrate.drifts[0];
    if (mismatch.kind !== "hash_mismatch") throw new Error(`expected hash_mismatch, got ${mismatch.kind}`);
    expect(mismatch.filename).toBe("002_b.sql");
    expect(mismatch.storedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mismatch.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mismatch.storedSha256).not.toBe(mismatch.fileSha256);
    // Nothing pending was applied after the drift was found.
    const c = await admin("SELECT to_regclass('c') IS NOT NULL AS present");
    expect(z.object({ present: z.boolean() }).parse(c.rows[0]).present).toBe(false);

    const onStart = await driftOf(assertMigrationsCurrent(url, dir));
    expect(onStart.drifts.map((d) => d.kind)).toEqual(["hash_mismatch", "not_applied"]);
  });

  test("the drift error names every drifted file, not the first", async () => {
    await runMigrations(url, dir);
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int, extra text);");
    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id int, extra text);");
    writeFileSync(join(dir, "003_c.sql"), "CREATE TABLE c (id int);");
    const drift = await driftOf(assertMigrationsCurrent(url, dir));
    expect(drift.drifts.map((d) => ("filename" in d ? `${d.kind}:${d.filename}` : d.kind))).toEqual([
      "hash_mismatch:001_a.sql",
      "hash_mismatch:002_b.sql",
      "not_applied:003_c.sql",
    ]);
    for (const name of ["001_a.sql", "002_b.sql", "003_c.sql"]) expect(drift.message).toContain(name);
  });

  test("rows from before hashes were tracked are backfilled once, with a warning", async () => {
    await admin(`
      CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE a (id int);
      INSERT INTO schema_migrations (filename) VALUES ('001_a.sql');
    `);
    // No hash column at all: every recorded file is unhashed, and each one is named.
    const unhashed = await driftOf(assertMigrationsCurrent(url, dir));
    expect(unhashed.drifts.map((d) => ("filename" in d ? `${d.kind}:${d.filename}` : d.kind))).toEqual([
      "hash_unrecorded:001_a.sql",
      "not_applied:002_b.sql",
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runMigrations(url, dir);
      expect(result.backfilled).toEqual(["001_a.sql"]);
      expect(result.applied).toEqual(["002_b.sql"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("001_a.sql");
      expect(String(warn.mock.calls[0]?.[0])).toContain("unknown");

      const again = await runMigrations(url, dir);
      expect(again.backfilled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    await assertMigrationsCurrent(url, dir);
  });
});

describe("migration runner robustness", () => {
  test("two concurrent runs serialize: one applies, the other finds nothing pending", async () => {
    // The sleep holds the first run inside 001 long enough for the second to reach it unlocked.
    writeFileSync(join(dir, "001_a.sql"), "SELECT pg_sleep(0.5); CREATE TABLE a (id int);");
    const results = await Promise.all([runMigrations(url, dir), runMigrations(url, dir)]);
    const applied = results.map((r) => r.applied.length).sort();
    expect(applied).toEqual([0, 2]);
    await assertMigrationsCurrent(url, dir);
  });

  test("a migration whose ROLLBACK also fails reports the original error, the rollback failure beside it", async () => {
    await runMigrations(url, dir);
    // Terminating its own backend fails the migration and leaves no connection to roll back on.
    writeFileSync(join(dir, "003_c.sql"), "SELECT pg_terminate_backend(pg_backend_pid());");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let err: unknown;
    try {
      err = await runMigrations(url, dir).then(
        () => undefined,
        (e: unknown) => e,
      );
    } finally {
      warn.mockRestore();
    }
    if (!(err instanceof Error)) throw new Error(`expected an Error, got ${String(err)}`);
    expect(err.name).toBe("MigrationTransactionError");
    expect(err.message).toContain("[003_c.sql]");
    expect(err.message).toContain("ROLLBACK ALSO FAILED");
    const cause: unknown = err.cause;
    if (!(cause instanceof Error)) throw new Error(`expected the original error as cause, got ${String(cause)}`);
    expect(cause.message).toMatch(/terminat/i);
    expect(err.message).toContain(cause.message);
    const rollbackError: unknown = "rollbackError" in err ? err.rollbackError : undefined;
    if (!(rollbackError instanceof Error)) throw new Error(`expected rollbackError, got ${String(rollbackError)}`);
    expect(rollbackError).not.toBe(cause);
    const row = await admin("SELECT count(*)::int AS n FROM schema_migrations WHERE filename = '003_c.sql'");
    expect(z.object({ n: z.number() }).parse(row.rows[0]).n).toBe(0);
  });
});
