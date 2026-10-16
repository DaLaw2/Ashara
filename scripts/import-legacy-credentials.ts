/**
 * Moves pre-store plaintext credentials into the secret store (ADR-075 C3/C4):
 * every non-empty provider_configs.api_key becomes provider/<name>/api_key and
 * the system_settings 'api_token' row becomes server/api_token; then the
 * plaintext is NULLed / deleted. The caller supplies the transaction, so the
 * reads, the store writes and the plaintext removal commit or roll back as one.
 *
 * Tables are referenced unqualified: they resolve through the transaction's
 * search_path. Migration 013 drops provider_configs.api_key once this has run,
 * so a missing column means there is nothing left to import there.
 */

import { SecretRepository } from "@ashara/db";
import type { DbTransaction } from "@ashara/db";
import { API_TOKEN_SECRET_NAME, SecretStore, providerApiKeySecretName } from "@ashara/security";
import type { MasterKey } from "@ashara/security";

interface LegacyImportReport {
  /** Secret names written (or already holding the same value). Never values. */
  readonly imported: readonly string[];
}

/**
 * The store already holds a different value under the name a legacy credential maps to.
 * @testseam import-legacy-credentials.test.ts asserts the typed rejection
 */
export class LegacyImportConflict extends Error {
  readonly secretName: string;
  readonly source: string;

  constructor(secretName: string, source: string) {
    super(
      `Secret "${secretName}" already exists in the store with a different value than ${source}. ` +
        `Nothing was imported (the transaction rolled back). Decide which value is current: ` +
        `re-put it with \`npx tsx scripts/secret.ts put ${secretName}\`, then clear ${source} by hand.`,
    );
    this.name = "LegacyImportConflict";
    this.secretName = secretName;
    this.source = source;
  }
}

/** A legacy row came back in a shape this importer does not recognise. */
class LegacyRowInvalid extends Error {
  readonly table: string;
  readonly issues: readonly string[];

  constructor(table: string, issues: readonly string[]) {
    super(`Unexpected ${table} row shape during import-legacy: ${issues.join("; ")}. Nothing was imported.`);
    this.name = "LegacyRowInvalid";
    this.table = table;
    this.issues = issues;
  }
}

// Rows come back from Postgres as unknown: each field is checked before use.
// (The root workspace has no zod dependency; these guards are the boundary check.)
function fieldOf(table: string, rows: unknown, index: number, field: string): unknown {
  if (!Array.isArray(rows)) {
    throw new LegacyRowInvalid(table, ["result rows are not an array"]);
  }
  const row: unknown = rows[index];
  if (typeof row !== "object" || row === null || !(field in row)) {
    throw new LegacyRowInvalid(table, [`row ${index} has no "${field}" field`]);
  }
  const value: unknown = Reflect.get(row, field);
  return value;
}

function stringFieldOf(table: string, rows: unknown, index: number, field: string): string {
  const value = fieldOf(table, rows, index, field);
  if (typeof value !== "string") {
    throw new LegacyRowInvalid(table, [`row ${index} field "${field}" is ${typeof value}, expected string`]);
  }
  return value;
}

function rowCount(table: string, rows: unknown): number {
  if (!Array.isArray(rows)) {
    throw new LegacyRowInvalid(table, ["result rows are not an array"]);
  }
  return rows.length;
}

async function importOne(store: SecretStore, secretName: string, value: string, source: string): Promise<void> {
  if (await store.has(secretName)) {
    if ((await store.get(secretName)) !== value) {
      throw new LegacyImportConflict(secretName, source);
    }
    return;
  }
  await store.put(secretName, value);
}

export async function importLegacyCredentials(tx: DbTransaction, key: MasterKey): Promise<LegacyImportReport> {
  const store = new SecretStore(new SecretRepository(tx), key);
  const imported: string[] = [];

  // Blocks concurrent writers (readers proceed) until commit, so the plaintext
  // cleared below is exactly the plaintext read and imported here.
  await tx.execute(`LOCK TABLE provider_configs, system_settings IN EXCLUSIVE MODE`);

  const columnRows = (
    await tx.execute(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'provider_configs'
           AND column_name = 'api_key') AS present`,
    )
  ).rows;
  if (fieldOf("information_schema.columns", columnRows, 0, "present") === true) {
    const providerRows = (
      await tx.execute(
        `SELECT name, api_key FROM provider_configs
           WHERE api_key IS NOT NULL AND api_key <> '' ORDER BY name`,
      )
    ).rows;
    for (let i = 0; i < rowCount("provider_configs", providerRows); i++) {
      const provider = stringFieldOf("provider_configs", providerRows, i, "name");
      const secretName = providerApiKeySecretName(provider);
      const value = stringFieldOf("provider_configs", providerRows, i, "api_key");
      await importOne(store, secretName, value, `provider_configs.api_key for "${provider}"`);
      imported.push(secretName);
    }
    await tx.execute(`UPDATE provider_configs SET api_key = NULL WHERE api_key IS NOT NULL`);
  }

  const tokenRows = (await tx.execute(`SELECT value FROM system_settings WHERE key = 'api_token'`)).rows;
  if (rowCount("system_settings", tokenRows) > 0) {
    const token = stringFieldOf("system_settings", tokenRows, 0, "value");
    if (token !== "") {
      await importOne(store, API_TOKEN_SECRET_NAME, token, "system_settings 'api_token'");
      imported.push(API_TOKEN_SECRET_NAME);
    }
    await tx.execute(`DELETE FROM system_settings WHERE key = 'api_token'`);
  }

  return { imported };
}
