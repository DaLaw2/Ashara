import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { assertTestDatabaseReachable, resolveTestDatabaseUrl } from "./test-database-url.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TEST_SERVER_URL = "postgresql://ashara@localhost:5433/ashara";
const refused = expect.objectContaining({ name: "TestDatabaseUrlRefused" });

describe("resolveTestDatabaseUrl", () => {
  test("defaults to the test server on 5433, never the shared database", () => {
    const url = resolveTestDatabaseUrl({});
    expect(url).toBe(TEST_SERVER_URL);
    expect(new URL(url).port).toBe("5433");
    expect(url).not.toBe(DEFAULT_DATABASE_URL);
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
});
