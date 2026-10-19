import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveTestDatabaseUrl } from "@ashara/db";
import { contendedWait } from "@ashara/shared";
import type * as CoverageModule from "./coverage.js";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import type * as DatabaseModule from "./database.js";
import type * as PlantsModule from "./plants.js";
import { PriorRunUnsettled, RunCleanupFailed, runSeed } from "./run.js";
import type { RunOptions, RunResult } from "./run.js";
import { runSignal } from "./simulator-harness.js";
import type { TestScope } from "./simulator-harness.js";

/*
 * How runSeed wires a run into the process: its console output captured by async context, its
 * wait on the run before it bounded, and its process-wide state put back whatever its cleanup
 * throws. Each scenario plants its fault through the scratch database's module, the one seam every
 * run passes through before its first cycle.
 */
const hooks = vi.hoisted(() => {
  const state: {
    beforeCreate: (() => Promise<void>) | null;
    dropFails: boolean;
    codePlanted: number;
    codeEverPlanted: boolean;
    sweepObservers: number;
  } = { beforeCreate: null, dropFails: false, codePlanted: 0, codeEverPlanted: false, sweepObservers: 0 };
  return state;
});

class PlantedDropFailure extends Error {
  constructor() {
    super("the planted run database drop failed after dropping it");
    this.name = "PlantedDropFailure";
  }
}

class PlantedHangReleased extends Error {
  constructor() {
    super("the planted hang in the run database's creation was released");
    this.name = "PlantedHangReleased";
  }
}

vi.mock("./database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    createRunDatabase: async (...args: Parameters<typeof actual.createRunDatabase>) => {
      const before = hooks.beforeCreate;
      hooks.beforeCreate = null;
      if (before !== null) await before();
      const created = await actual.createRunDatabase(...args);
      return {
        ...created,
        drop: async () => {
          await created.drop();
          if (hooks.dropFails) throw new PlantedDropFailure();
        },
      };
    },
  };
});

vi.mock("./coverage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CoverageModule>();
  return {
    ...actual,
    observeAcceptanceSweeps: (onSweep: (outcome: string) => void) => {
      const restore = actual.observeAcceptanceSweeps(onSweep);
      hooks.sweepObservers += 1;
      return () => {
        hooks.sweepObservers -= 1;
        restore();
      };
    },
  };
});

vi.mock("./plants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PlantsModule>();
  const planted = actual.PLANTED["no-checkout-lock"];
  return {
    ...actual,
    PLANTED: {
      ...actual.PLANTED,
      "no-checkout-lock": {
        ...planted,
        code: () => {
          hooks.codePlanted += 1;
          hooks.codeEverPlanted = true;
          return () => {
            hooks.codePlanted -= 1;
          };
        },
      },
    },
  };
});

const databaseUrl = resolveTestDatabaseUrl(process.env);
let template = "";

beforeAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
  template = await prepareTemplate(databaseUrl);
}, 120_000);

afterAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
});

/** A short benign run: what these tests judge is its wiring, never its verdict. */
function shortRun(test: TestScope, seed: number, scenario: Pick<RunOptions, "mutation" | "signal"> = {}): Promise<RunResult> {
  const { signal, ...shape } = scenario;
  return runSeed({
    seed,
    profile: "typical",
    tape: { kind: "directed", directions: [] },
    databaseUrl,
    template,
    scratchRoot: tmpdir(),
    maxCycles: 3,
    timeoutMs: 60_000,
    ...shape,
    signal: signal === undefined ? runSignal(test) : AbortSignal.any([runSignal(test), signal]),
  });
}

class Deferred {
  readonly promise: Promise<void>;
  resolve: () => void = () => undefined;
  reject: (err: Error) => void = () => undefined;
  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const PLANTED_LINE = "planted write of the first run, made while the second runs";

/** How soon a run refuses to wait on a stuck one: the run's settle grace past its abort, and a poll. */
const REFUSAL_BOUND_MS = 25_000;

describe("lifecycle simulator, a run's wiring into the process", () => {
  it("keeps a write the first run makes while the second runs in the first run's log", async (ctx) => {
    const secondStarted = new Deferred();
    let fired = false;
    hooks.beforeCreate = () => {
      void secondStarted.promise.then(() => {
        console.warn(PLANTED_LINE);
        fired = true;
      });
      return Promise.resolve();
    };
    const first = await shortRun(ctx, 1);
    hooks.beforeCreate = () => {
      secondStarted.resolve();
      return Promise.resolve();
    };
    const next = await shortRun(ctx, 2);
    expect(fired).toBe(true);
    expect(next.log.filter((line) => line.includes(PLANTED_LINE))).toEqual([]);
    expect(first.log.some((line) => line.includes(PLANTED_LINE))).toBe(true);
  }, 120_000);

  it("puts process-wide state back and logs the failure at warn when its cleanup throws", async (ctx) => {
    const env0 = { WORKDIR_BASE: process.env["WORKDIR_BASE"], ASHARA_BUDGET_LIMIT_USD: process.env["ASHARA_BUDGET_LIMIT_USD"], ASHARA_CELL_MEMORY: process.env["ASHARA_CELL_MEMORY"] };
    const uuid0 = globalThis.crypto.randomUUID;
    hooks.dropFails = true;
    let thrown: unknown = null;
    try {
      await shortRun(ctx, 3, { mutation: "no-checkout-lock" });
    } catch (err) {
      thrown = err;
    } finally {
      hooks.dropFails = false;
    }
    expect(thrown).toBeInstanceOf(RunCleanupFailed);
    const failed = thrown instanceof RunCleanupFailed ? thrown : null;
    expect(failed?.failures.map((failure) => failure.step)).toEqual(["the run database's drop"]);
    expect(failed?.log.some((line) => line.startsWith("warn [simulator] run cleanup:") && line.includes("PlantedDropFailure"))).toBe(true);
    expect({ WORKDIR_BASE: process.env["WORKDIR_BASE"], ASHARA_BUDGET_LIMIT_USD: process.env["ASHARA_BUDGET_LIMIT_USD"], ASHARA_CELL_MEMORY: process.env["ASHARA_CELL_MEMORY"] }).toEqual(env0);
    expect(globalThis.crypto.randomUUID).toBe(uuid0);
    const waiting = Promise.resolve();
    expect(contendedWait("target-checkout", waiting)).toBe(waiting);
    expect(hooks.sweepObservers).toBe(0);
    expect(hooks.codeEverPlanted).toBe(true);
    expect(hooks.codePlanted).toBe(0);
  }, 120_000);

  it("refuses to start over a run that never settles, naming it, within its bound", async (ctx) => {
    const reached = new Deferred();
    const hang = new Deferred();
    hooks.beforeCreate = () => {
      reached.resolve();
      return hang.promise;
    };
    const controller = new AbortController();
    const stuck = Promise.allSettled([shortRun(ctx, 7, { signal: controller.signal })]);
    try {
      await reached.promise;
      controller.abort();
      const calledAt = Date.now();
      const refused = await Promise.allSettled([shortRun(ctx, 8)]);
      const tookMs = Date.now() - calledAt;
      const [outcome] = refused;
      expect(outcome.status).toBe("rejected");
      const reason: unknown = outcome.status === "rejected" ? outcome.reason : null;
      expect(reason).toBeInstanceOf(PriorRunUnsettled);
      expect(reason instanceof PriorRunUnsettled ? reason.stuck : "").toContain("seed 7");
      expect(tookMs).toBeLessThan(REFUSAL_BOUND_MS);
      // A run called while the stuck one still holds the process is refused at once, naming the stuck run, not the refused one.
      const [later] = await Promise.allSettled([shortRun(ctx, 9)]);
      const laterReason: unknown = later.status === "rejected" ? later.reason : null;
      expect(laterReason instanceof PriorRunUnsettled ? laterReason.stuck : "").toContain("seed 7");
    } finally {
      hang.reject(new PlantedHangReleased());
      await stuck;
    }
  }, 60_000);
});
