import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import { diffExpected } from "./expected-failures.js";
import { minimize } from "./minimize.js";
import { profileOfSeed } from "./profile.js";
import { runSeed } from "./run.js";
import type { Mutation, RunOptions, RunResult } from "./run.js";

/**
 * The fast tier (design §4.13): fixed seeds on today's code, each judged against
 * expected-failures.ts. A seed listed there must fail exactly the violation keys listed; any
 * other seed must pass every invariant. The soak tier is `just simulate`. Every run is a batch of
 * two (production's MAX_BATCH_SIZE default); seed 30 is judged in the checkout-lock test below.
 */
const FAST_SEEDS = [1, 2, 4, 10, 14, 41] as const;
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

function seeded(seed: number, mutation?: Mutation, scenario: Pick<RunOptions, "projects" | "capUsd" | "cellOutage"> = {}): Promise<RunResult> {
  return runSeed({
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "seeded", seed },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...(mutation === undefined ? {} : { mutation }),
    ...scenario,
  });
}

function keys(result: RunResult): string[] {
  return result.violations.map((v) => v.key).sort();
}

function failed(result: RunResult): string[] {
  return [...new Set(result.violations.map((v) => v.invariant))].sort();
}

describe("lifecycle simulator, fast tier", () => {
  for (const seed of FAST_SEEDS) {
    it(`seed ${seed} fails exactly its listed violations`, async () => {
      const result = await seeded(seed);
      expect(diffExpected(result, {}), result.violations.map((v) => `${v.key}: ${v.statement}`).join("\n")).toEqual({ unexpected: [], missing: [] });
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
    // The batch of two interleaves on this seed, so the equality covers the interleaving too.
    expect(first.trace.filter((line) => line.startsWith("turn ")).length).toBeGreaterThan(0);
    expect(second.trace).toEqual(first.trace);
  }, 90_000);

  // A seed is a function of itself alone (owner 2026-10-15, fixed seeds and replay): run twice in
  // one process, the second after the first moved every counter a run can leave behind, its trace
  // (what it did, ids and commits canonical, its violations last) is byte-identical. Seed 6 once
  // flaked one project (I7:unrecorded); seeds 18 and 59 are two-project runs at the soak's cap.
  const twice: ReadonlyArray<readonly [number, Pick<RunOptions, "projects" | "capUsd">]> = [
    [6, {}],
    [21, {}],
    [18, { projects: 2, capUsd: 10 }],
    [59, { projects: 2, capUsd: 10 }],
  ];
  for (const [seed, scenario] of twice) {
    it(`runs seed ${seed}${scenario.projects === 2 ? " with two projects" : ""} twice to the same trace`, async () => {
      const first = await seeded(seed, undefined, scenario);
      const second = await seeded(seed, undefined, scenario);
      expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
    }, 120_000);
  }

  // B8 (baseline §3; task t-begin-failure-leaks-connection) has no seed on the keyed tape, so it is pinned by its two decisions: the
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

  // B3 (baseline §3; task t-orphan-requeue-failure), minimized from chaos seed 6: a crash, a crash right after the task is set
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

  // B5 (baseline §3, re-confirmed §7.8; task t-merge-record-crash-window), a known production failure pinned until it is fixed: the
  // process dies on the merge-record write right after the merge commit landed on main
  // (development merge.ts commitMerge, then orchestrator execution.ts writes the record); at boot the
  // startup reconciler requeues the orphan without looking on main (startup-reconciler.ts
  // requeueOrphan), so the merged work is dispatched again and main holds a merge no record names.
  // The two-project triage of §7.7 (seeds 31 46 56 57 78) is this defect. A fix fails this test:
  // then it asserts the clean outcome instead.
  it("names a merge on main whose record a crash lost (B5, known failure)", async () => {
    const label = 'fault.db:update "work_items" set "merge_commit" = $1, "merge_kind" = ';
    const result = await runSeed({
      seed: 10,
      profile: "typical",
      tape: { kind: "replay", decisions: [{ key: `${label}#1`, value: 1 }, { key: `${label}.kind#1`, value: 0 }] },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
    });
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["db:crash-before"]);
    expect(result.log.some((line) => line.includes("[startup-reconciler] requeued"))).toBe(true);
    expect(keys(result)).toEqual(["I7:unrecorded:Define and commit the project environment"]);
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

  // ADR-074 d82 W3: seed 30 runs two implementations in one batch, and one finalize waits on the
  // other's checkout. Skipping that wait lets the second finalize's recovery abort the first's
  // staged merge, which I7's merge-queue clause names.
  it("catches two finalizes overlapping on one checkout when the checkout lock is skipped", async () => {
    const clean = await seeded(30);
    expect(diffExpected(clean, {}), clean.violations.map((v) => `${v.key}: ${v.statement}`).join("\n")).toEqual({ unexpected: [], missing: [] });
    expect([...clean.coverage.concurrency]).toContain("contended:target-checkout");
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
    const planted = await seeded(30, "no-checkout-lock");
    expect(planted.violations.map((v) => v.key)).toContain("I7:checkout-overlap:merge --abort");
  }, 90_000);

  // ADR-074 d84 b. With one project the admission queue's absence admits nothing more (baseline
  // §7.6), so here two projects share one deployment cap of $10: skipping the queue lets one task's
  // admission pass the deployment's check while the other's stands between its check and its
  // in-flight estimate (observed: still caught with the in-flight read moved before the spend read,
  // B9's fix, so it is the queue's race and not B9's).
  it("catches two admissions passing the deployment's cap on one headroom when the admission queue is skipped", async () => {
    const shared = { projects: 2, capUsd: 10 } as const;
    const clean = await seeded(50, undefined, shared);
    expect(keys(clean), clean.violations.map((v) => `${v.key}: ${v.statement}`).join("\n")).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
    const planted = await seeded(50, "no-admission-queue", shared);
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // B9 (baseline §7.7), fixed in Finance: an admission sums the in-flight estimates before it reads
  // the recorded spend. Planted back (ledger-read-first), the other task's call is recorded and
  // released between the spend read and the in-flight sum and counts in neither. The window needs
  // the tape to hand the turn on at the read's return and back only after the other task's release:
  // observed in seeds 1-80 at cap $10 on seed 23 alone, at cap $6 on seed 7 alone. Seed 7 at $6 since
  // the stand-in plan's lines name their sources (ADR-074 addendum 2 d89 A): ledger-read-first over
  // seeds 1-80 at $10 then caught it on none, and at $6 on seed 7 alone, which fails I5:over-committed
  // alone and passes clean (observed, scan of 2026-10-14). Why the change moved the window: unverified.
  // Seed 96 at $6 since a retry asks git whether its branch conflicts with main (w12b D2): every host
  // git call is a seam the interleaver turns at, and seed 7 then no longer met the window (observed,
  // scan of 2026-10-15: ledger-read-first over seeds 1-80 at $6 and 1-60 at $10 caught it on none
  // alone; over 81-119 at $6, seed 96 fails I5:over-committed alone and passes clean).
  it("catches an admission that counts a just-recorded call in neither the spend nor the in-flight sum", async () => {
    // The race needs two admissions to meet near the cap, so it hangs on the calls' estimated prices:
    // the check author's brief and tools grew (W11 D4) and seed 23 at $10 no longer met it.
    const shared = { projects: 2, capUsd: 6 } as const;
    const clean = await seeded(96, undefined, shared);
    expect(keys(clean), clean.violations.map((v) => `${v.key}: ${v.statement}`).join("\n")).toEqual([]);
    const planted = await seeded(96, "ledger-read-first", shared);
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // ADR-074 d84 b, I8 on no progress: the host cannot start a cell all run. Production requeues the
  // environment task uncharged three times, halts the project on the fourth fault, the probe resumes
  // it, and the fifth gives the task up, so the plan is repaired until it halts undeliverable. With
  // the count pinned at the halt, the project halts and resumes forever: busy, every cycle a new
  // halt episode, and nothing reached that was not reached before.
  it("catches a halt and resumption that repeat with no progress", async () => {
    const outage = { cellOutage: true } as const;
    const clean = await seeded(10, undefined, outage);
    expect(keys(clean)).toEqual([]);
    expect(clean.outcome.kind).toBe("halted");
    const planted = await seeded(10, "infrastructure-fault-pinned", outage);
    expect(planted.trace.filter((line) => line.endsWith("1 task(s) [interrupted]")).length).toBeGreaterThan(4);
    expect(keys(planted)).toEqual(["I1:open", "I8:Pending"]);
    expect(planted.outcome.kind).toBe("open");
  }, 90_000);

  // ADR-074 d84 b, W7: the stand-ins drive seed 10 to Accepted on one passed sweep of main; the
  // delivered report is judged against the goal tasks' merge records and the task and check
  // records, so a report that drops a goal's close, misstates what no stored check covers, leaves
  // out an asked-for item no acceptance line cites, or is posted with no record of it (and so
  // posted again) is named.
  it("accepts a project on a passed sweep and catches a delivered report that misstates its records", async () => {
    const clean = await seeded(10);
    expect(clean.outcome.kind).toBe("accepted");
    expect(keys(clean)).toEqual([]);
    expect([...clean.coverage.projectStatuses]).toContain("accepted");
    expect([...clean.coverage.sweeps]).toEqual(["ran:passed"]);
    expect(keys(await seeded(10, "delivered-report-omits-goal"))).toEqual(["I4:delivered-close"]);
    expect(keys(await seeded(10, "delivered-report-misstates-unchecked"))).toEqual(["I4:delivered-unchecked"]);
    // W11c D3: the stand-ins' assumption is cited by no acceptance line, so the report lists it; dropped, it is named.
    expect(keys(await seeded(10, "delivered-report-omits-uncovered"))).toEqual(["I4:delivered-coverage"]);
    expect(keys(await seeded(10, "delivered-report-unrecorded"))).toContain("I4:unrecorded-report");
  }, 120_000);

  // W6/W7: a halt's report quotes the cause recorded on its episode. Seed 10 under a cell outage
  // halts on infrastructure and then undeliverable (plan_repair); seed 1 halts at the spend cap.
  it("catches a halt report that states a fixed cause instead of the recorded one", async () => {
    const outage = await seeded(10, "halt-report-fixed-cause", { cellOutage: true });
    expect(keys(outage)).toEqual(["I4:halt-cause:infrastructure", "I4:halt-cause:plan_repair"]);
    const spend = await seeded(1, "halt-report-fixed-cause");
    expect(spend.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(keys(spend)).toEqual(["I4:halt-cause:budget_cap"]);
  }, 120_000);

  // The stop report names exactly the merges recorded. A tape of two decisions: the client stops
  // the project at cycle 5, after three tasks merged (seed 10's ids, no fault).
  it("catches a stop report that leaves out a merge on record", async () => {
    const stop = (mutation?: Mutation): Promise<RunResult> =>
      runSeed({
        seed: 10,
        profile: "typical",
        tape: { kind: "replay", decisions: [{ key: "client.stop#1", value: 1 }, { key: "client.stop-cycle#1", value: 3 }] },
        databaseUrl,
        template,
        maxCycles: MAX_CYCLES,
        timeoutMs: SEED_TIMEOUT_MS,
        ...(mutation === undefined ? {} : { mutation }),
      });
    const clean = await stop();
    expect(clean.outcome.kind).toBe("stopped");
    expect(clean.trace).toContain("client stop at cycle 5");
    expect(keys(clean)).toEqual([]);
    expect(keys(await stop("stop-report-omits-merge"))).toEqual(["I4:stop-merges"]);
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
