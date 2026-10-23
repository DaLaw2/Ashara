import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { MIGRATIONS_DIR, migrationSetHash } from "./migrations.js";
import { assertTestDatabaseReachable, readyTestDatabase, resolveSimulatorDatabaseUrl, resolveTestDatabaseUrl } from "./test-database-url.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TEST_SERVER_URL = `postgresql://ashara@localhost:5433/ashara_test_${migrationSetHash(MIGRATIONS_DIR)}`;
const refused = expect.objectContaining({ name: "TestDatabaseUrlRefused" });

describe("resolveTestDatabaseUrl", () => {
  test("defaults to the test server on 5433, in the database of exactly this checkout's migrations, never the shared database", () => {
    const url = resolveTestDatabaseUrl({});
    expect(url).toBe(TEST_SERVER_URL);
    expect(new URL(url).port).toBe("5433");
    expect(url).not.toBe(DEFAULT_DATABASE_URL);
  });

  test("a checkout whose migrations differ by a renumbered or redrafted file never shares a default database with this one", () => {
    const dir = (files: Record<string, string>): string => {
      const made = mkdtempSync(join(tmpdir(), "ashara-migration-set-"));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(made, name), text);
      return made;
    };
    const landed = dir({ "000_init.sql": "SELECT 1;", "005_reviewer_outcomes.sql": "SELECT 2;" });
    const sameAgain = dir({ "000_init.sql": "SELECT 1;", "005_reviewer_outcomes.sql": "SELECT 2;" });
    const renumbered = dir({ "000_init.sql": "SELECT 1;", "003_reviewer_outcomes.sql": "SELECT 2;" });
    const redrafted = dir({ "000_init.sql": "SELECT 1;", "005_reviewer_outcomes.sql": "SELECT 3;" });
    try {
      expect(migrationSetHash(sameAgain)).toBe(migrationSetHash(landed));
      expect(migrationSetHash(renumbered)).not.toBe(migrationSetHash(landed));
      expect(migrationSetHash(redrafted)).not.toBe(migrationSetHash(landed));
    } finally {
      for (const made of [landed, sameAgain, renumbered, redrafted]) rmSync(made, { recursive: true, force: true });
    }
  });

  test("never reads DATABASE_URL, which names the server's own database", () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: "postgresql://ashara@localhost:5432/ashara_scratch" })).toBe(TEST_SERVER_URL);
  });

  test("uses TEST_DATABASE_URL when it names another database", () => {
    const scratch = "postgresql://ashara@localhost:5432/ashara_scratch";
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: scratch })).toBe(scratch);
  });

  test.each([
    DEFAULT_DATABASE_URL,
    "postgresql://ashara@127.0.0.1:5432/ashara",
    "postgresql://ashara@localhost/ashara",
  ])("refuses TEST_DATABASE_URL naming the shared database: %s", (shared) => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: shared })).toThrow(refused);
  });

  test("refuses a TEST_DATABASE_URL that is not a URL", () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "not a url" })).toThrow(refused);
  });
});

describe("resolveSimulatorDatabaseUrl", () => {
  const shared = expect.objectContaining({
    name: "TestDatabaseUrlRefused",
    refusal: { kind: "shared_database", variable: "SIM_DATABASE_URL", url: "postgresql://ashara@localhost:5432/ashara" },
  });

  test("refuses SIM_DATABASE_URL naming the shared database", () => {
    expect(() => resolveSimulatorDatabaseUrl({ SIM_DATABASE_URL: "postgresql://ashara@localhost:5432/ashara" })).toThrow(shared);
  });

  test("uses SIM_DATABASE_URL when it names another database", () => {
    const scratch = "postgresql://ashara@localhost:5433/ashara_sim_scratch";
    expect(resolveSimulatorDatabaseUrl({ SIM_DATABASE_URL: scratch })).toBe(scratch);
  });

  test("falls back to the tests' URL, refused the same way", () => {
    expect(resolveSimulatorDatabaseUrl({})).toBe(TEST_SERVER_URL);
    expect(() => resolveSimulatorDatabaseUrl({ TEST_DATABASE_URL: DEFAULT_DATABASE_URL })).toThrow(refused);
  });
});

describe("readyTestDatabase", () => {
  test("fails closed naming `just test-db-up` before migrating when the server does not answer", async () => {
    const ready = readyTestDatabase({ TEST_DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" });
    await expect(ready).rejects.toMatchObject({ name: "TestDatabaseUnreachable", message: expect.stringContaining("just test-db-up") });
  });
});

describe("assertTestDatabaseReachable", () => {
  test("fails closed naming `just test-db-up` when the server does not answer", async () => {
    const probe = assertTestDatabaseReachable("postgresql://nobody@127.0.0.1:1/none");
    await expect(probe).rejects.toMatchObject({ name: "TestDatabaseUnreachable", message: expect.stringContaining("just test-db-up") });
  });
});

describe("no test or simulator entry point falls back to the shared database", () => {
  test("git grep finds no nullish fallback to DEFAULT_DATABASE_URL in tests, the simulator or its scripts", () => {
    const paths = ["*.test.ts", "packages/integration/src/simulator/*.ts", "scripts/simulate.ts", "scripts/test-db-ready.ts"];
    const result = spawnSync("git", ["grep", "-nE", String.raw`\?\? DEFAULT_DATABASE_URL`, "--", ...paths], { cwd: REPO, encoding: "utf8" });
    // git grep exits 1 on no match and 0 on a match; anything else is a grep that did not run.
    expect({ status: result.status, hits: result.stdout }).toEqual({ status: 1, hits: "" });
  });

  test("git grep finds no read of DATABASE_URL or loadDatabaseUrl call in tests or the integration package", () => {
    // config.test.ts unit-tests loadDatabaseUrl itself and opens no connection.
    const paths = ["*.test.ts", "packages/integration", ":!packages/server/src/config.test.ts"];
    const pattern = String.raw`\?\? DEFAULT_DATABASE_URL|DATABASE_URL"\]|[.]DATABASE_URL([^A-Za-z0-9_]|$)|loadDatabaseUrl\(`;
    const result = spawnSync("git", ["grep", "-nE", pattern, "--", ...paths], { cwd: REPO, encoding: "utf8" });
    expect({ status: result.status, hits: result.stdout }).toEqual({ status: 1, hits: "" });
  });
});
