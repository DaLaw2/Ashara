import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, DEFAULT_DATABASE_URL, SecretRepository } from "@ashara/db";
import type { DbTransaction } from "@ashara/db";
import { SecretStore, createKeyFile, loadMasterKey, resolveKeyFilePath } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { LegacyImportConflict, importLegacyCredentials } from "./import-legacy-credentials.js";

// Everything here runs inside a throwaway schema this suite creates and drops:
// its own provider_configs, system_settings and secrets tables, reached through
// a transaction-local search_path. The shared database's real tables are never
// read or written.
const SCHEMA = `test_legacy_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const MIGRATION_013 = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", "migrations", "013_drop_plaintext_credentials.sql"),
  "utf-8",
);
const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
let keyDir: string;
let key: MasterKey;

function inSchema<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(`SET LOCAL search_path TO "${SCHEMA}"`);
    return fn(tx);
  });
}

async function runMigration013(): Promise<void> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${SCHEMA}"`);
    await client.query(MIGRATION_013);
    await client.query("COMMIT");
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function query(text: string): Promise<unknown[]> {
  return inSchema(async (tx) => (await tx.execute(text)).rows);
}

beforeAll(async () => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-legacy-key-"));
  const keyFile = path.join(keyDir, "secret.key");
  createKeyFile(keyFile);
  key = loadMasterKey(resolveKeyFilePath({ ASHARA_SECRET_KEY_FILE: keyFile }));
  await db.$client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await db.$client.query(`CREATE TABLE "${SCHEMA}".secrets (LIKE secrets INCLUDING ALL)`);
});

beforeEach(async () => {
  await db.$client.query(`DROP TABLE IF EXISTS "${SCHEMA}".provider_configs, "${SCHEMA}".system_settings`);
  await db.$client.query(`TRUNCATE "${SCHEMA}".secrets`);
  await db.$client.query(`CREATE TABLE "${SCHEMA}".provider_configs (name TEXT PRIMARY KEY, api_key TEXT)`);
  await db.$client.query(`CREATE TABLE "${SCHEMA}".system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
});

afterAll(async () => {
  await db.$client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$client.end();
  fs.rmSync(keyDir, { recursive: true, force: true });
});

async function seedPlaintext(): Promise<void> {
  await db.$client.query(
    `INSERT INTO "${SCHEMA}".provider_configs (name, api_key) VALUES
       ('alpha', 'throwaway-alpha'), ('beta', NULL), ('gamma', ''), ('delta', 'throwaway-delta')`,
  );
  await db.$client.query(`INSERT INTO "${SCHEMA}".system_settings (key, value) VALUES ('api_token', 'throwaway-token')`);
}

describe("import-legacy", () => {
  test("moves every plaintext credential into the store and leaves none behind; a rerun finds nothing", async () => {
    await seedPlaintext();
    const report = await inSchema((tx) => importLegacyCredentials(tx, key));
    expect(report.imported).toEqual(["provider/alpha/api_key", "provider/delta/api_key", "server/api_token"]);

    expect(await query(`SELECT name FROM provider_configs WHERE api_key IS NOT NULL AND api_key <> ''`)).toEqual([]);
    expect(await query(`SELECT key FROM system_settings WHERE key = 'api_token'`)).toEqual([]);
    const stored = await inSchema(async (tx) => {
      const store = new SecretStore(new SecretRepository(tx), key);
      const values: string[] = [];
      for (const name of report.imported) values.push(await store.get(name));
      return values;
    });
    expect(stored).toEqual(["throwaway-alpha", "throwaway-delta", "throwaway-token"]);

    expect((await inSchema((tx) => importLegacyCredentials(tx, key))).imported).toEqual([]);
  });

  test("a conflicting stored value rolls the whole import back", async () => {
    await seedPlaintext();
    await inSchema((tx) => new SecretStore(new SecretRepository(tx), key).put("provider/delta/api_key", "other"));
    await expect(inSchema((tx) => importLegacyCredentials(tx, key))).rejects.toBeInstanceOf(LegacyImportConflict);
    expect(await query(`SELECT name FROM provider_configs WHERE api_key IS NOT NULL ORDER BY name`)).toEqual([
      { name: "alpha" },
      { name: "delta" },
      { name: "gamma" },
    ]);
    expect(await query(`SELECT name FROM secrets ORDER BY name`)).toEqual([{ name: "provider/delta/api_key" }]);
  });
});

describe("migration 013", () => {
  test("refuses while plaintext remains, naming import-legacy; drops the column once it is gone", async () => {
    await seedPlaintext();
    await expect(runMigration013()).rejects.toThrow(/npx tsx scripts\/secret\.ts import-legacy/);
    expect(await query(`SELECT name FROM provider_configs WHERE name = 'alpha' AND api_key IS NOT NULL`)).toHaveLength(1);

    await inSchema((tx) => importLegacyCredentials(tx, key));
    await runMigration013();
    expect(
      await query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema = '${SCHEMA}' AND table_name = 'provider_configs' AND column_name = 'api_key'`,
      ),
    ).toEqual([]);
    expect((await inSchema((tx) => importLegacyCredentials(tx, key))).imported).toEqual([]);
  });

  test("an api_token row alone also blocks it", async () => {
    await db.$client.query(`INSERT INTO "${SCHEMA}".system_settings (key, value) VALUES ('api_token', 'throwaway')`);
    await expect(runMigration013()).rejects.toThrow(/1 system_settings 'api_token' row/);
  });
});
