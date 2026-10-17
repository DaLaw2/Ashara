import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { loadServerConfig, loadDatabaseUrl } from "./config.js";

const TEST_DB_URL = "postgres://localhost:5432/test";
const TEST_TOKEN = "test-token";

// The owner's cap must reach Finance's deployment cap
// whichever of its two names the owner set. Finance's enforcement of it is
// tested against llm_calls in packages/integration/src/finance/spend-cap.test.ts.
describe("loadServerConfig — budget cap plumbing and settings that fail closed", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "DATABASE_URL",
    "ASHARA_BUDGET_LIMIT_USD",
    "ASHARA_BUDGET_TOTAL",
    "ASHARA_PROJECT_BUDGET_LIMIT_USD",
    "ASHARA_TASK_WORK_BUDGET_REQUESTS",
    "ASHARA_PROJECT_WORK_BUDGET_REQUESTS",
    "ASHARA_WORK_RESERVE_PERCENT",
    "WORKDIR_BASE",
    "ASHARA_PORT",
    "MAX_BATCH_SIZE",
  ] as const;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    delete process.env["ASHARA_BUDGET_LIMIT_USD"];
    delete process.env["ASHARA_BUDGET_TOTAL"];
    delete process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"];
    delete process.env["ASHARA_TASK_WORK_BUDGET_REQUESTS"];
    delete process.env["ASHARA_PROJECT_WORK_BUDGET_REQUESTS"];
    delete process.env["ASHARA_WORK_RESERVE_PERCENT"];
    delete process.env["ASHARA_PORT"];
    delete process.env["MAX_BATCH_SIZE"];
    process.env["WORKDIR_BASE"] = "/srv/ashara-work";
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

  test("unset work budgets are 60 and 600 model requests with a 25% reserve; set ones are read, and an unusable one is refused", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    expect(loadServerConfig(TEST_DB_URL, TEST_TOKEN).workBudgets).toEqual({ perTaskRequests: 60, perProjectRequests: 600, verificationReservePercent: 25 });
    process.env["ASHARA_TASK_WORK_BUDGET_REQUESTS"] = "5";
    process.env["ASHARA_PROJECT_WORK_BUDGET_REQUESTS"] = "50";
    process.env["ASHARA_WORK_RESERVE_PERCENT"] = "0";
    expect(loadServerConfig(TEST_DB_URL, TEST_TOKEN).workBudgets).toEqual({ perTaskRequests: 5, perProjectRequests: 50, verificationReservePercent: 0 });
    process.env["ASHARA_WORK_RESERVE_PERCENT"] = "100";
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/ASHARA_WORK_RESERVE_PERCENT="100"/);
    process.env["ASHARA_WORK_RESERVE_PERCENT"] = "25";
    process.env["ASHARA_PROJECT_WORK_BUDGET_REQUESTS"] = "0";
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/ASHARA_PROJECT_WORK_BUDGET_REQUESTS="0"/);
  });

  test("unset ASHARA_PORT and MAX_BATCH_SIZE take their policy defaults; set ones are read", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const defaults = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect([defaults.port, defaults.coreLoop.maxBatchSize]).toEqual([3000, 2]);
    process.env["ASHARA_PORT"] = "8080";
    process.env["MAX_BATCH_SIZE"] = "4";
    const set = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect([set.port, set.coreLoop.maxBatchSize]).toEqual([8080, 4]);
  });

  test.each([
    ["ASHARA_PORT", "80a"],
    ["ASHARA_PORT", "0"],
    ["ASHARA_PORT", "70000"],
    ["MAX_BATCH_SIZE", "two"],
    ["MAX_BATCH_SIZE", "0"],
    ["MAX_BATCH_SIZE", "-1"],
    ["MAX_BATCH_SIZE", "1.5"],
  ])("a set but unusable %s=%s is refused, never replaced by the default", (variable, raw) => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    process.env[variable] = raw;
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(`${variable}="${raw}" is not an integer`);
  });

  test("WORKDIR_BASE has no default: unset refuses to start", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    delete process.env["WORKDIR_BASE"];
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow(/WORKDIR_BASE is not set/);
    process.env["WORKDIR_BASE"] = "relative-work";
    expect(loadServerConfig(TEST_DB_URL, TEST_TOKEN).coreLoop.workdirBase).toBe(join(process.cwd(), "relative-work"));
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

