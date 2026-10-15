import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, DEFAULT_DATABASE_URL, SecretRepository } from "@ashara/db";
import { SecretStore, createKeyFile, loadMasterKey } from "@ashara/security";
import type { MasterKey } from "@ashara/security";

// Every row this suite writes carries a unique prefix; only rows under it are deleted afterwards.
const PREFIX = `test-${randomUUID()}`;
const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
let keyDir: string;
let key: MasterKey;
let store: SecretStore;

class RollBack extends Error {}

beforeAll(async () => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-secret-delete-key-"));
  const keyFile = path.join(keyDir, "secret.key");
  createKeyFile(keyFile);
  key = loadMasterKey(keyFile);
  store = new SecretStore(new SecretRepository(db), key);
});

afterAll(async () => {
  fs.rmSync(keyDir, { recursive: true, force: true });
  await db.$client.query("DELETE FROM secrets WHERE name LIKE $1", [`${PREFIX}/%`]);
  await db.$client.end();
});

describe("SecretStore.delete", () => {
  test("removes a stored secret and reports whether one existed", async () => {
    const name = `${PREFIX}/client/access_code`;
    await store.put(name, "throwaway-value");
    expect(await store.delete(name)).toBe(true);
    expect(await store.has(name)).toBe(false);
    expect(await store.delete(name)).toBe(false);
  });

  test("a delete inside a rolled-back transaction leaves the secret in place", async () => {
    const name = `${PREFIX}/server/api_token`;
    await store.put(name, "kept-value");
    const outcome = await db
      .transaction(async (tx) => {
        expect(await new SecretStore(new SecretRepository(tx), key).delete(name)).toBe(true);
        throw new RollBack("roll back on purpose");
      })
      .catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(RollBack);
    expect(await store.get(name)).toBe("kept-value");
  });

  test("refuses an invalid name with a typed error", async () => {
    await expect(store.delete(`${PREFIX}//double`)).rejects.toMatchObject({ name: "InvalidSecretName" });
    await expect(store.delete("Upper/Case")).rejects.toMatchObject({ name: "InvalidSecretName" });
  });
});
