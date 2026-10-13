import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { loadServerConfig, loadDatabaseUrl } from "./config.js";

const TEST_DB_URL = "postgres://localhost:5432/test";
const TEST_TOKEN = "test-token";

// Finding (a), E2E Run 11: the owner's cap must reach Finance's deployment cap
// whichever of its two names the owner set. Finance's enforcement of it is
// tested against llm_calls in packages/finance/src/spend-cap.test.ts.
describe("loadServerConfig — budget cap plumbing (finding a)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "DATABASE_URL",
    "ASHARA_BUDGET_LIMIT_USD",
    "ASHARA_BUDGET_TOTAL",
    "ASHARA_PROJECT_BUDGET_LIMIT_USD",
  ] as const;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    delete process.env["ASHARA_BUDGET_LIMIT_USD"];
    delete process.env["ASHARA_BUDGET_TOTAL"];
    delete process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("ASHARA_BUDGET_TOTAL reaches the deployment cap when ASHARA_BUDGET_LIMIT_USD is unset", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.spendCaps.deploymentUsd).toBe(1);
  });

  test("ASHARA_BUDGET_LIMIT_USD wins when both are set", () => {
    process.env["ASHARA_BUDGET_LIMIT_USD"] = "2";
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.spendCaps.deploymentUsd).toBe(2);
  });

  test("a blank ASHARA_BUDGET_LIMIT_USD does not mask the ASHARA_BUDGET_TOTAL fallback", () => {
    process.env["ASHARA_BUDGET_LIMIT_USD"] = "   ";
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.spendCaps.deploymentUsd).toBe(1);
  });

  test("refuses to start when neither is set", () => {
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/must be set explicitly/);
  });

  test.each(["0", "-1", "abc", "1usd"])("rejects an unusable cap %s instead of substituting one", (raw) => {
    process.env["ASHARA_BUDGET_TOTAL"] = raw;
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/not a positive finite number/);
  });

  test("an unset project cap is the deployment cap (policy default)", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "3";
    expect(loadServerConfig(TEST_DB_URL, TEST_TOKEN).spendCaps).toEqual({ deploymentUsd: 3, perProjectUsd: 3 });
  });

  test("ASHARA_PROJECT_BUDGET_LIMIT_USD sets the project cap, and an unusable one is refused", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "3";
    process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"] = "0.5";
    expect(loadServerConfig(TEST_DB_URL, TEST_TOKEN).spendCaps.perProjectUsd).toBe(0.5);
    process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"] = "none";
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/ASHARA_PROJECT_BUDGET_LIMIT_USD="none"/);
  });
});

describe("loadDatabaseUrl — policy default", () => {
  const saved = process.env["DATABASE_URL"];

  afterEach(() => {
    if (saved === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = saved;
  });

  test("uses DEFAULT_DATABASE_URL when DATABASE_URL is not set", () => {
    delete process.env["DATABASE_URL"];
    expect(loadDatabaseUrl()).toBe(DEFAULT_DATABASE_URL);
  });

  test("DATABASE_URL env var overrides the default", () => {
    process.env["DATABASE_URL"] = "postgres://other:5432/other";
    expect(loadDatabaseUrl()).toBe("postgres://other:5432/other");
  });
});

