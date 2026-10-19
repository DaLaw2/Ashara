import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, SecretRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { EmptySecretValue, InvalidSecretName, MasterKey, SecretKeyMismatch, SecretNotFound, SecretStore } from "@ashara/security";

// Runs against the shared dev database: every row this suite writes carries a
// unique prefix, and only rows under that prefix are deleted afterwards.
const PREFIX = `test-${randomUUID()}`;
const db = createDb(resolveTestDatabaseUrl(process.env));
const repository = new SecretRepository(db);
const key = new MasterKey(randomBytes(32));
const store = new SecretStore(repository, key);

beforeAll(async () => {
  await db.$client.query("SELECT 1 FROM secrets LIMIT 1");
});

afterAll(async () => {
  await db.$client.query("DELETE FROM secrets WHERE name LIKE $1", [`${PREFIX}/%`]);
  await db.$client.end();
});

describe("SecretStore (Postgres)", () => {
  test("stores ciphertext only and round-trips the value", async () => {
    const name = `${PREFIX}/provider/api_key`;
    await store.put(name, "throwaway-value-1");
    expect(await store.get(name)).toBe("throwaway-value-1");
    expect(await store.has(name)).toBe(true);

    const raw = await db.$client.query<{ ciphertext: Buffer; key_id: string }>(
      "SELECT ciphertext, key_id FROM secrets WHERE name = $1",
      [name],
    );
    expect(raw.rows[0]?.key_id).toBe(key.id);
    expect(raw.rows[0]?.ciphertext.toString("utf-8")).not.toContain("throwaway-value-1");
  });

  test("put replaces an existing value", async () => {
    const name = `${PREFIX}/server/api_token`;
    await store.put(name, "first");
    await store.put(name, "second");
    expect(await store.get(name)).toBe("second");
  });

  test("lists names without values", async () => {
    const names = (await store.listNames()).filter((n) => n.startsWith(PREFIX));
    expect(names).toEqual([`${PREFIX}/provider/api_key`, `${PREFIX}/server/api_token`]);
  });

  test("absence is a typed error, never an empty value", async () => {
    const name = `${PREFIX}/absent`;
    await expect(store.get(name)).rejects.toBeInstanceOf(SecretNotFound);
    expect(await store.has(name)).toBe(false);
  });

  test("a store under another key refuses to decrypt", async () => {
    const other = new SecretStore(repository, new MasterKey(randomBytes(32)));
    await expect(other.get(`${PREFIX}/provider/api_key`)).rejects.toBeInstanceOf(SecretKeyMismatch);
  });

  test("rejects invalid names and empty values before touching the database", async () => {
    await expect(store.put("Provider/Upper", "v")).rejects.toBeInstanceOf(InvalidSecretName);
    await expect(store.put(`${PREFIX}//double`, "v")).rejects.toBeInstanceOf(InvalidSecretName);
    await expect(store.put(`${PREFIX}/empty`, "")).rejects.toBeInstanceOf(EmptySecretValue);
  });
});
