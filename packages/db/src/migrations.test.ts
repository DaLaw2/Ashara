import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { LEGACY_MIGRATIONS } from "./legacy-migrations.js";
import {
  MIGRATIONS_DIR,
  MigrationBaselineError,
  MigrationDriftError,
  assertMigrationsCurrent,
  runMigrations,
} from "./migrations.js";

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

async function baselineRefusalOf(run: Promise<unknown>): Promise<MigrationBaselineError> {
  const err: unknown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof MigrationBaselineError)) throw new Error(`expected MigrationBaselineError, got ${String(err)}`);
  return err;
}

async function present(table: string): Promise<boolean> {
  const r = await admin("SELECT to_regclass($1) IS NOT NULL AS present", [table]);
  return z.object({ present: z.boolean() }).parse(r.rows[0]).present;
}

/** schema_migrations as a database that ran `rows` of the numbered files the init stands in for. */
async function recordLegacy(rows: readonly { readonly filename: string; readonly sha256: string }[]): Promise<void> {
  await admin(
    "CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), content_sha256 TEXT)",
  );
  for (const row of rows) {
    await admin("INSERT INTO schema_migrations (filename, content_sha256) VALUES ($1, $2)", [row.filename, row.sha256]);
  }
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

describe("baseline onto 000_init.sql", () => {
  // The init here is a marker table: the test reads whether it ran, not what it builds.
  beforeEach(() => {
    rmSync(join(dir, "001_a.sql"));
    rmSync(join(dir, "002_b.sql"));
    writeFileSync(join(dir, "000_init.sql"), "CREATE TABLE init_ran (id int);");
  });

  test("an empty database runs the init", async () => {
    const result = await runMigrations(url, dir);
    expect(result.applied).toEqual(["000_init.sql"]);
    expect(result.baselined).toEqual([]);
    expect(await present("init_ran")).toBe(true);
    await assertMigrationsCurrent(url, dir);
  });

  test("a database that ran every numbered file with its hash records the init without running it, removing nothing", async () => {
    await recordLegacy(LEGACY_MIGRATIONS);
    const notYet = await driftOf(assertMigrationsCurrent(url, dir));
    expect(notYet.drifts.map((d) => ("filename" in d ? `${d.kind}:${d.filename}` : d.kind))).toEqual([
      "not_applied:000_init.sql",
    ]);

    const result = await runMigrations(url, dir);
    expect(result.baselined).toEqual(["000_init.sql"]);
    expect(result.applied).toEqual([]);
    expect(await present("init_ran")).toBe(false);
    const rows = await admin("SELECT count(*)::int AS n FROM schema_migrations");
    expect(z.object({ n: z.number() }).parse(rows.rows[0]).n).toBe(LEGACY_MIGRATIONS.length + 1);
    await assertMigrationsCurrent(url, dir);

    const again = await runMigrations(url, dir);
    expect(again.baselined).toEqual([]);
    expect(again.applied).toEqual([]);
  });

  test("a database that ran only some numbered files fails closed naming every missing one", async () => {
    const [first, second, ...rest] = LEGACY_MIGRATIONS;
    if (first === undefined || second === undefined) throw new Error("the legacy manifest lists fewer than two files");
    await recordLegacy(rest);

    const err = await baselineRefusalOf(runMigrations(url, dir));
    if (err.refusal.kind !== "legacy_incomplete") throw new Error(`expected legacy_incomplete, got ${err.refusal.kind}`);
    expect(err.refusal.missing).toEqual([first.filename, second.filename]);
    expect(err.refusal.mismatched).toEqual([]);
    expect(err.message).toContain(first.filename);
    expect(err.message).toContain(second.filename);
    expect(await present("init_ran")).toBe(false);
    const init = await admin("SELECT count(*)::int AS n FROM schema_migrations WHERE filename = '000_init.sql'");
    expect(z.object({ n: z.number() }).parse(init.rows[0]).n).toBe(0);

    await baselineRefusalOf(assertMigrationsCurrent(url, dir));
  });

  test("a numbered file recorded with a different hash fails closed naming it and both hashes", async () => {
    const [first, ...rest] = LEGACY_MIGRATIONS;
    if (first === undefined) throw new Error("the legacy manifest is empty");
    const otherHash = "0".repeat(64);
    await recordLegacy([{ filename: first.filename, sha256: otherHash }, ...rest]);

    const err = await baselineRefusalOf(runMigrations(url, dir));
    if (err.refusal.kind !== "legacy_incomplete") throw new Error(`expected legacy_incomplete, got ${err.refusal.kind}`);
    expect(err.refusal.missing).toEqual([]);
    expect(err.refusal.mismatched).toEqual([
      { filename: first.filename, storedSha256: otherHash, manifestSha256: first.sha256 },
    ]);
    expect(err.message).toContain(first.filename);
    expect(err.message).toContain(otherHash);
    expect(err.message).toContain(first.sha256);
    expect(await present("init_ran")).toBe(false);
  });

  test("a complete record with no init file to record fails closed", async () => {
    rmSync(join(dir, "000_init.sql"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
    await recordLegacy(LEGACY_MIGRATIONS);
    const err = await baselineRefusalOf(runMigrations(url, dir));
    expect(err.refusal.kind).toBe("init_file_missing");
    expect(await present("a")).toBe(false);

    const onStart = await baselineRefusalOf(assertMigrationsCurrent(url, dir));
    expect(onStart.refusal.kind).toBe("init_file_missing");
  });
});

describe("migrations/ holds one init equal to the numbered files it stands in for", () => {
  test("000_init.sql is the only file in migrations/", () => {
    expect(readdirSync(MIGRATIONS_DIR)).toEqual(["000_init.sql"]);
  });

  // The fingerprint file was taken from a database built by running every numbered file in order;
  // a database built from 000_init.sql alone must match it object for object and row for row.
  test("a database built from 000_init.sql alone has the schema and seeded rows of the numbered files", async () => {
    const base = new URL(DATABASE_URL);
    const name = `${base.pathname.slice(1)}_init_${randomBytes(6).toString("hex")}`;
    const fresh = new URL(DATABASE_URL);
    fresh.pathname = `/${name}`;
    const server = new pg.Client({ connectionString: DATABASE_URL });
    await server.connect();
    try {
      await server.query(`CREATE DATABASE ${name}`);
      try {
        const result = await runMigrations(fresh.toString(), MIGRATIONS_DIR);
        expect(result.applied).toEqual(["000_init.sql"]);
        const client = new pg.Client({ connectionString: fresh.toString() });
        await client.connect();
        let fingerprint: string;
        try {
          const sql = readFileSync(new URL("./schema-fingerprint.sql", import.meta.url), "utf-8");
          const rows = await client.query(sql);
          fingerprint = z.array(z.object({ fingerprint: z.string() })).length(1).parse(rows.rows)[0]?.fingerprint ?? "";
        } finally {
          await client.end();
        }
        const expected = readFileSync(new URL("./init-schema.fingerprint.txt", import.meta.url), "utf-8");
        expect(`${fingerprint}\n`).toBe(expected);
      } finally {
        await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await server.end();
    }
  }, 60_000);
});
