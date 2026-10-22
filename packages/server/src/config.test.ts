import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { PodmanSubstrate, type CellResourceLimits, type ProcessRunner } from "@ashara/execution-infra";
import { recordingLogger } from "@ashara/shared/testing";
import { assertLanesFitCellHost, loadServerConfig, loadDatabaseUrl, loadShutdownDeadlineMs } from "./config.js";

// This process sees four CPUs and 4 GiB, as under a systemd scope with CPUQuota=400%: a check that
// read the process's own view instead of the cell runtime's would refuse lanes the runtime's host fits.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const processView = { availableParallelism: () => 4, totalmem: () => 4 * 1024 ** 3, cpus: () => actual.cpus().slice(0, 4) };
  return { ...actual, ...processView, default: { ...actual, ...processView } };
});

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
    "ASHARA_TASK_LANES",
    "ASHARA_CELL_MEMORY",
    "ASHARA_CELL_CPUS",
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
    delete process.env["ASHARA_TASK_LANES"];
    // The lanes' fit to the cell host is checked once the runtime is composed, and tested on its own.
    process.env["ASHARA_CELL_MEMORY"] = "1g";
    process.env["ASHARA_CELL_CPUS"] = "1";
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

  test("unset ASHARA_PORT and ASHARA_TASK_LANES take their policy defaults; set ones are read", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const defaults = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect([defaults.port, defaults.coreLoop.laneCount]).toEqual([3000, 2]);
    process.env["ASHARA_PORT"] = "8080";
    process.env["ASHARA_TASK_LANES"] = "3";
    const set = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect([set.port, set.coreLoop.laneCount]).toEqual([8080, 3]);
  });

  test("a MAX_BATCH_SIZE still set refuses the boot instead of being ignored", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    process.env["MAX_BATCH_SIZE"] = "4";
    expect(() => loadServerConfig(TEST_DB_URL, TEST_TOKEN)).toThrow('MAX_BATCH_SIZE="4" is no longer read; set ASHARA_TASK_LANES instead');
  });

  test.each([
    ["ASHARA_PORT", "80a"],
    ["ASHARA_PORT", "0"],
    ["ASHARA_PORT", "70000"],
    ["ASHARA_TASK_LANES", "two"],
    ["ASHARA_TASK_LANES", "0"],
    ["ASHARA_TASK_LANES", "-1"],
    ["ASHARA_TASK_LANES", "1.5"],
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

describe("loadShutdownDeadlineMs — the one bound on a shutdown", () => {
  const saved = process.env["ASHARA_SHUTDOWN_DEADLINE_MS"];

  afterEach(() => {
    if (saved === undefined) delete process.env["ASHARA_SHUTDOWN_DEADLINE_MS"];
    else process.env["ASHARA_SHUTDOWN_DEADLINE_MS"] = saved;
  });

  test("unset takes its policy default; a set one within bounds is read", () => {
    delete process.env["ASHARA_SHUTDOWN_DEADLINE_MS"];
    expect(loadShutdownDeadlineMs()).toBe(30_000);
    process.env["ASHARA_SHUTDOWN_DEADLINE_MS"] = "1";
    expect(loadShutdownDeadlineMs()).toBe(1);
    process.env["ASHARA_SHUTDOWN_DEADLINE_MS"] = "600000";
    expect(loadShutdownDeadlineMs()).toBe(600_000);
  });

  test.each(["0", "-1", "600001", "1.5", "thirty"])("a set but unusable ASHARA_SHUTDOWN_DEADLINE_MS=%s is refused, never replaced by the default", (raw) => {
    process.env["ASHARA_SHUTDOWN_DEADLINE_MS"] = raw;
    expect(() => loadShutdownDeadlineMs()).toThrow(`ASHARA_SHUTDOWN_DEADLINE_MS="${raw}" is not an integer from 1 to 600000`);
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

describe("assertLanesFitCellHost — the lanes' cells against the host the cell runtime reports", () => {
  const GiB = 1024 ** 3;
  const CAPS: CellResourceLimits = { memoryBytes: 4 * GiB, cpus: 3, pids: 1024 };
  type ProcessResult = Awaited<ReturnType<ProcessRunner>>;
  const exited = (exitCode: number, stdout: string, stderr = ""): ProcessResult => ({
    exitCode, signal: null, stdout, stdoutCut: null, stderr, stderrCut: null, killedByHost: false, stdinError: null, statusReport: null,
  });
  /** A podman whose `info` answers `result`: the composed runtime, its host what the fake reports. */
  const runtimeAnswering = (result: ProcessResult): PodmanSubstrate =>
    new PodmanSubstrate({
      logger: recordingLogger(),
      podmanPath: "podman",
      mountRoot: "/srv/ashara-work",
      limits: CAPS,
      runner: async (request) => {
        if (request.args.join(" ") !== "info --format json") throw new Error(`unexpected podman call: ${request.args.join(" ")}`);
        return result;
      },
    });
  const info = (host: Record<string, unknown>) => exited(0, JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true }, ...host } }));
  const refusal = async (lanes: number, runtime: PodmanSubstrate): Promise<unknown> => {
    try {
      await assertLanesFitCellHost(lanes, CAPS, runtime);
    } catch (err) {
      return err;
    }
    return null;
  };

  test("two lanes of 3-CPU cells fit a 36-CPU runtime host although this process sees four CPUs", async () => {
    await expect(assertLanesFitCellHost(2, CAPS, runtimeAnswering(info({ cpus: 36, memTotal: 64 * GiB })))).resolves.toBeUndefined();
  });

  test("cells beyond the runtime host's memory refuse the boot with TaskLanesExceedHost, naming where it was read", async () => {
    const err = await refusal(2, runtimeAnswering(info({ cpus: 36, memTotal: 8 * GiB })));
    expect(err).toMatchObject({ name: "TaskLanesExceedHost", resource: "memory", cellsAtOnce: 3, needed: 12 * GiB, host: 8 * GiB });
    expect(err).toHaveProperty("message", expect.stringContaining("`podman info --format json`"));
  });

  test("cells beyond the runtime host's CPUs refuse the boot with TaskLanesExceedHost", async () => {
    expect(await refusal(3, runtimeAnswering(info({ cpus: 8, memTotal: 64 * GiB })))).toMatchObject({
      name: "TaskLanesExceedHost",
      resource: "cpus",
      needed: 12,
      host: 8,
    });
  });

  test.each([
    ["an info without host.cpus", info({ memTotal: 64 * GiB })],
    ["an info without host.memTotal", info({ cpus: 36 })],
    ["an info that is not JSON", exited(0, "not json")],
    ["a failed info", exited(125, "", "cannot connect")],
  ])("%s refuses the boot with HostCapacityUnreadable naming the command", async (_case, result) => {
    const err = await refusal(1, runtimeAnswering(result));
    expect(err).toMatchObject({ name: "HostCapacityUnreadable", command: "podman info --format json" });
  });
});
