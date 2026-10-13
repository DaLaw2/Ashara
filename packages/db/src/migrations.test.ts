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
    expect(onMigrate.kind).toBe("hash_mismatch");
    expect(onMigrate.filename).toBe("002_b.sql");
    expect(onMigrate.storedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onMigrate.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onMigrate.storedSha256).not.toBe(onMigrate.fileSha256);
    // Nothing pending was applied after the drift was found.
    const c = await admin("SELECT to_regclass('c') IS NOT NULL AS present");
    expect(z.object({ present: z.boolean() }).parse(c.rows[0]).present).toBe(false);

    expect((await driftOf(assertMigrationsCurrent(url, dir))).kind).toBe("hash_mismatch");
  });

  test("startup check names the first unapplied file", async () => {
    await runMigrations(url, dir);
    writeFileSync(join(dir, "003_c.sql"), "CREATE TABLE c (id int);");
    const drift = await driftOf(assertMigrationsCurrent(url, dir));
    expect(drift.kind).toBe("not_applied");
    expect(drift.filename).toBe("003_c.sql");
  });

  test("rows from before hashes were tracked are backfilled once, with a warning", async () => {
    await admin(`
      CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE a (id int);
      INSERT INTO schema_migrations (filename) VALUES ('001_a.sql');
    `);
    expect((await driftOf(assertMigrationsCurrent(url, dir))).kind).toBe("hash_unrecorded");

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
