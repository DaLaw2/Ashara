import { afterEach, describe, expect, test, vi } from "vitest";
import setup from "./test-database-setup.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("test database globalSetup", () => {
  test("stops the run naming `just test-db-up` when the test Postgres does not answer", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://nobody@127.0.0.1:1/none");
    await expect(setup()).rejects.toMatchObject({ name: "TestDatabaseUnreachable", message: expect.stringContaining("just test-db-up") });
  });
});
