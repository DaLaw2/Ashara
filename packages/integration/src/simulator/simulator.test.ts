import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import { diffExpected } from "./expected-failures.js";
import { minimize } from "./minimize.js";
import { profileOfSeed } from "./profile.js";
import { runSeed } from "./run.js";
import type { Mutation, RunResult } from "./run.js";

/**
 * The fast tier (design §4.13): fixed seeds on today's code, each judged against
 * expected-failures.ts. A seed listed there must fail exactly the violation keys listed; any
 * other seed must pass every invariant. The soak tier is `just simulate`.
 */
const FAST_SEEDS = [1, 2, 4, 10, 14, 30, 41] as const;
const MAX_CYCLES = 120;
const SEED_TIMEOUT_MS = 60_000;

const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
let template = "";

beforeAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
  template = await prepareTemplate(databaseUrl);
}, 120_000);

afterAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
});

function seeded(seed: number, mutation?: Mutation): Promise<RunResult> {
  return runSeed({
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "seeded", seed },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...(mutation === undefined ? {} : { mutation }),
  });
}

function failed(result: RunResult): string[] {
  return [...new Set(result.violations.map((v) => v.invariant))].sort();
}

describe("lifecycle simulator, fast tier", () => {
  for (const seed of FAST_SEEDS) {
    it(`seed ${seed} fails exactly its listed violations`, async () => {
      const result = await seeded(seed);
      expect(diffExpected(seed, result.violations), result.violations.map((v) => `${v.key}: ${v.statement}`).join("\n")).toEqual({ unexpected: [], missing: [] });
    }, 90_000);
  }

  it("replays a seed to the same trace", async () => {
    const first = await seeded(21);
    const second = await runSeed({
      seed: 21,
      profile: profileOfSeed(21),
      tape: { kind: "replay", decisions: first.decisions },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
    });
    expect(second.trace).toEqual(first.trace);
  }, 90_000);

  // B8 (baseline §3) has no seed on the keyed tape, so it is pinned by its two decisions: the
  // first BEGIN fails with a 40001. Before the leak was named, its teardown waited on the pool's end forever.
  it("names a connection production leaves checked out instead of hanging on it", async () => {
    const result = await runSeed({
      seed: 89,
      profile: "typical",
      tape: { kind: "replay", decisions: [{ key: "fault.db:begin#1", value: 1 }, { key: "fault.db:begin.kind#1", value: 3 }] },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
    });
    // The kind is an index into the call's offered faults: pinned here, so a catalogue change fails loudly.
    expect(result.faults.map((f) => `${f.label}:${f.fault}`)).toEqual(["begin:db-query-failed"]);
    expect(result.violations.map((v) => v.key)).toEqual(["I1:leaked-connection:begin"]);
  }, 90_000);

  // B3 (baseline §3), minimized from chaos seed 6: a crash, a crash right after the task is set
  // InProgress (its orphan), then a 40001 on the startup reconciler's dev_sessions read.
  it("leaves an orphan the reconciler failed to requeue InProgress while the process lives", async () => {
    const result = await runSeed({
      seed: 6,
      profile: "chaos",
      tape: {
        kind: "replay",
        decisions: [
          { key: "fault.git:ls-tree#2", value: 1 },
          { key: 'fault.db:update "work_items" set "status" = $1, "blocked_reason" = $2#5', value: 1 },
          { key: 'fault.db:update "work_items" set "status" = $1, "blocked_reason" = $2.kind#1', value: 1 },
          { key: 'fault.db:select count(*) from "dev_sessions" where ("dev_sessions"."t#3', value: 1 },
          { key: 'fault.db:select count(*) from "dev_sessions" where ("dev_sessions"."t.kind#1', value: 3 },
        ],
      },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
    });
    // Kinds are indexes into each call's offered faults: pinned, so a catalogue change fails loudly.
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", "db:crash-after", "db:db-query-failed"]);
    expect(result.log.some((line) => line.includes("failed to requeue crash-orphaned InProgress item"))).toBe(true);
    expect(result.violations.map((v) => v.key).sort()).toEqual(["I1:open", "I7:orphan:Define and commit the project environment:2", "I8:InProgress", "I8:Pending"]);
  }, 90_000);

  // B4 (baseline §3), seed 14's tape minimized on a9f781ce: two simulated git index.lock failures
  // fail the substrate gate's cell start. Before W6 the environment task was parked at Blocked
  // (environment_unavailable) for an operator: I1, I2 and I8. Now the fault is requeued uncharged
  // and the next dispatch completes it.
  it("requeues a task whose cell could not start, never parks it for a person", async () => {
    const result = await runSeed({
      seed: 14,
      profile: "typical",
      tape: {
        kind: "replay",
        decisions: [
          { key: "fault.git:add#6", value: 1 },
          { key: "fault.git:add.kind#1", value: 2 },
          { key: "fault.git:commit-tree#4", value: 1 },
          { key: "fault.git:commit-tree.kind#1", value: 2 },
        ],
      },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
    });
    expect(result.faults.length).toBe(2);
    expect(result.trace).toContain("cycle 1: 1 task(s) [interrupted]");
    expect(result.violations.map((v) => v.key)).toEqual([]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  it("catches a merge recorded under a commit main does not hold", async () => {
    const clean = await seeded(10);
    expect(failed(clean)).toEqual([]);
    const planted = await seeded(10, "skip-merge-record");
    expect(failed(planted)).toContain("I7");
  }, 90_000);
});

describe("minimize", () => {
  it("reduces a failing tape to the decisions the failure needs", async () => {
    const tape = Array.from({ length: 12 }, (_, i) => ({ key: `site#${i}`, value: 1 }));
    const needs = new Set(["site#3", "site#9"]);
    const reduced = await minimize(tape, async (decisions) => [...needs].every((key) => decisions.some((d) => d.key === key)), 100);
    expect(reduced.decisions.map((d) => d.key).sort()).toEqual(["site#3", "site#9"]);
    expect(reduced.budgetExhausted).toBe(false);
  });
});
