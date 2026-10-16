import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { RARE_UNDER_OWN_PROFILES } from "./coverage.js";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import { diffExpected } from "./expected-failures.js";
import type { FaultKind, SeamKind } from "./faults.js";
import { minimize } from "./minimize.js";
import { profileOfSeed } from "./profile.js";
import type { Profile } from "./profile.js";
import { runSeed } from "./run.js";
import type { RunOptions, RunResult } from "./run.js";
import type { Direction } from "./tape.js";

/**
 * The fast tier (design §4.13): fixed seeds on today's code, each judged against
 * expected-failures.ts. A seed listed there must fail exactly the violation keys listed; any
 * other seed must pass every invariant. The soak tier is `just simulate`. Every run is a batch of
 * two (production's MAX_BATCH_SIZE default). A test that needs one behaviour forces it on a directed
 * tape (the directed tier below), never by a seed found to reach it.
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

function seeded(seed: number, scenario: Pick<RunOptions, "projects" | "capUsd"> = {}): Promise<RunResult> {
  return runSeed({
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "seeded", seed },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...scenario,
  });
}

/** What I6 names when a check set of the stand-ins is stored with its last decided item undecided (check-set-skips-item). */
const SKIPPED_ITEM = ["I6:unchecked-item:A1"];

function keys(result: RunResult): string[] {
  return result.violations.map((v) => v.key).sort();
}

function failed(result: RunResult): string[] {
  return [...new Set(result.violations.map((v) => v.invariant))].sort();
}

function statements(result: RunResult): string {
  return result.violations.map((v) => `${v.key}: ${v.statement}`).join("\n");
}

describe("lifecycle simulator, fast tier", () => {
  for (const seed of FAST_SEEDS) {
    it(`seed ${seed} fails exactly its listed violations`, async () => {
      const result = await seeded(seed);
      expect(diffExpected(result, {}), statements(result)).toEqual({ unexpected: [], missing: [] });
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
  // (what it did, ids and commits canonical, its violations last) is byte-identical. Seeds 6 and 21
  // run one project; seeds 18 and 59 are two-project runs at the soak's cap.
  const twice: ReadonlyArray<readonly [number, Pick<RunOptions, "projects" | "capUsd">]> = [
    [6, {}],
    [21, {}],
    [18, { projects: 2, capUsd: 10 }],
    [59, { projects: 2, capUsd: 10 }],
  ];
  for (const [seed, scenario] of twice) {
    it(`runs seed ${seed}${scenario.projects === 2 ? " with two projects" : ""} twice to the same trace`, async () => {
      const first = await seeded(seed, scenario);
      const second = await seeded(seed, scenario);
      expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
    }, 120_000);
  }
});

/**
 * The directed tier (t-simulator-directed-plants): each fault, plant and misbehaviour a test judges
 * is forced by name on a directed tape (tape.ts Direction), every other draw benign, rather than
 * reached by a seed found by scanning. A seed is re-rolled by any change that adds a seam call on
 * its path; a direction is not, and one the run never takes fails the run (run.ts DirectionsNotTaken) instead of letting the
 * test judge a run that never met its behaviour. The forced behaviour flows through the same code
 * as a seeded one: the same seams, stand-ins and interleaver; only the choice is named.
 */
describe("lifecycle simulator, directed", () => {
  type Scenario = Pick<RunOptions, "mutation" | "projects" | "capUsd" | "cellOutage"> & { readonly profile?: Profile };

  function directed(directions: readonly Direction[], scenario: Scenario = {}): Promise<RunResult> {
    return runSeed({
      seed: 1,
      profile: "typical",
      tape: { kind: "directed", directions },
      databaseUrl,
      template,
      maxCycles: MAX_CYCLES,
      timeoutMs: SEED_TIMEOUT_MS,
      ...scenario,
    });
  }

  const draw = (site: string | RegExp, nth: number | "every", value = 1, scope?: string): Direction => ({
    kind: "draw",
    site,
    nth,
    value,
    ...(scope === undefined ? {} : { scope }),
  });
  /** The plan is two tasks that depend on none of each other, so their implementations run as one batch. */
  const BATCH_OF_TWO: readonly Direction[] = [draw("universe.extra-tasks", 1), draw("universe.independent-tasks", 1)];
  /** The running task hands the turn to the other at every matching seam call where it can (interleave.ts). */
  const switchAtEvery = (site: RegExp): Direction => draw(site, "every");
  /** An implementation attempt's draw, counted over implementation attempts only. */
  const implementation = (site: string, nth: number | "every"): Direction => draw(site, nth, 1, "implementation");

  // The first BEGIN fails with a 40001. The transaction wrapper (db
  // connection.ts) releases the connection whose BEGIN failed, so no checkout outlives the process.
  it("releases the connection of a failed BEGIN, leaving none checked out", async () => {
    const result = await directed([{ kind: "fault", seam: "db", label: "begin", nth: 1, fault: "db-query-failed" }]);
    expect(result.faults.map((f) => `${f.label}:${f.fault}`)).toEqual(["begin:db-query-failed"]);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // Task t-orphan-requeue-failure: a crash, a crash right after the task is set
  // InProgress (its orphan), then a 40001 on the startup reconciler's dev_sessions read. The
  // reconciler retries the requeue within its bound, so the orphan is never left InProgress.
  it("retries a failed requeue of an orphan, never leaving it InProgress while the process lives", async () => {
    const result = await directed([
      { kind: "fault", seam: "git", label: "ls-tree", nth: 2, fault: "crash-before" },
      { kind: "fault", seam: "db", label: /^update "work_items" set "status" = \$1, "blocked_reason" = \$2/, nth: 5, fault: "crash-after" },
      { kind: "fault", seam: "db", label: /^select count\(\*\) from "dev_sessions"/, nth: 3, fault: "db-query-failed" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", "db:crash-after", "db:db-query-failed"]);
    expect(result.log.some((line) => line.includes("requeue the task failed on attempt 1 of 3; retrying"))).toBe(true);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // Task t-merge-record-crash-window: the process dies on the
  // merge-record write right after the merge commit landed on main (Quality merge.ts
  // commitMerge, then orchestrator execution.ts writes the record). The startup reconciler reads
  // main before it requeues an orphan, and records the merge it finds instead of dispatching the
  // merged work again.
  it("records a merge on main whose record a crash lost, never re-dispatching it", async () => {
    const result = await directed([{ kind: "fault", seam: "db", label: /^update "work_items" set "merge_commit" = \$1/, nth: 1, fault: "crash-before" }]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["db:crash-before"]);
    expect(result.log.some((line) => line.includes("was merged on main as") && line.includes("merge recorded, Completed, not re-dispatched"))).toBe(true);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // Two simulated git index.lock failures fail the substrate gate's cell start. The fault is
  // requeued uncharged and the next dispatch completes it, never parking the task for an operator
  // (story s-loop-never-stop-m1 W6).
  it("requeues a task whose cell could not start, never parks it for a person", async () => {
    const result = await directed([
      { kind: "fault", seam: "git", label: "add", nth: 6, fault: "git-failed" },
      { kind: "fault", seam: "git", label: "commit-tree", nth: 4, fault: "git-failed" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:git-failed", "git:git-failed"]);
    expect(result.trace).toContain("cycle 1: 1 task(s) [interrupted]");
    expect(keys(result)).toEqual([]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  /*
   * The fault kinds the seeded soak reaches too seldom to floor (coverage.ts
   * RARE_UNDER_OWN_PROFILES), each forced on the first call that can carry it: production answers
   * each without breaking an invariant. A key marked rare that no entry here forces fails the first
   * test.
   */
  const fault = (seam: SeamKind, label: string | RegExp, kind: FaultKind): Direction => ({ kind: "fault", seam, label, nth: 1, fault: kind });
  const RARE_FAULTS: readonly Direction[] = [
    fault("db", "connect", "db-unreachable"),
    fault("podman", "run", "cell-start-failed"),
    fault("podman", "exec", "cell-exec-failed"),
    fault("podman", "rm", "cell-teardown-failed"),
    fault("podman", "info", "substrate-down"),
    fault("podman", "build", "image-build-failed"),
    fault("model", /./, "crash-before"),
    fault("model", /./, "sigterm"),
    fault("model", /./, "provider-error"),
    fault("model", /./, "clock-jump"),
  ];
  const pairOf = (direction: Direction): string => (direction.kind === "fault" ? `${direction.seam}:${direction.fault}` : "");

  it("forces every fault kind the soak reaches too seldom to floor", () => {
    const rare = [...RARE_UNDER_OWN_PROFILES.keys()].filter((key) => key.startsWith("faults ")).map((key) => key.slice("faults ".length));
    expect(RARE_FAULTS.map(pairOf).sort()).toEqual(rare.sort());
  });

  for (const direction of RARE_FAULTS) {
    const pair = pairOf(direction);
    it(`carries ${pair} on the first call that can carry it`, async () => {
      const result = await directed([direction]);
      expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual([pair]);
      if (pair === "model:provider-error") {
        // A transport failure is the provider's, as production's adapter reports it: the read that
        // made the request counts it, and it never escapes the cycle as an Ashara fault.
        expect(result.trace.filter((line) => /^cycle \d+: error/.test(line))).toEqual([]);
        expect(result.log.some((line) => line.includes("(the provider failed the request)"))).toBe(true);
      }
      expect(keys(result), statements(result)).toEqual([]);
    }, 90_000);
  }

  // ADR-074 d82 W3: two implementations run in one batch and one finalize waits on the other's
  // checkout. Skipping that wait lets one finalize reset, merge into and clean the checkout while
  // the other's merge is staged there, which I7's merge-queue clause names. The turn is handed on at every host git call, so each
  // finalize is entered while the other is part way through its own. A directed run is a function
  // of its directions alone: run twice, its trace is byte-identical.
  it("catches two finalizes overlapping on one checkout when the checkout lock is skipped", async () => {
    const race = [...BATCH_OF_TWO, switchAtEvery(/^interleave:git:/)];
    const clean = await directed(race);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:target-checkout");
    const again = await directed(race);
    expect(again.trace.join("\n")).toBe(clean.trace.join("\n"));
    const planted = await directed(race, { mutation: "no-checkout-lock" });
    expect(keys(planted)).toContain("I7:checkout-overlap:reset");
  }, 120_000);

  // ADR-074 d84 b. With one project the admission queue's absence admits nothing more, so here two
  // projects share one deployment cap of $10, spent to the cap. The turn is
  // handed on after every database call returns, so an admission's spend read is followed by the
  // other task's: skipping the queue lets both pass on one headroom smaller than their two
  // estimates. The in-flight read precedes the spend read, so what this catches is the queue's race,
  // not a race between those two reads.
  it("catches two admissions passing the deployment's cap on one headroom when the admission queue is skipped", async () => {
    const race = [...BATCH_OF_TWO, switchAtEvery(/^interleave:db:.*:returned$/)];
    const shared = { projects: 2, capUsd: 10 } as const;
    const clean = await directed(race, shared);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
    const planted = await directed(race, { ...shared, mutation: "no-admission-queue" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // Migration 053: an admitted call's estimate is its llm_calls row, pending until the call is
  // recorded, and the spend read counts it. Planted (pending-uncounted), the read leaves the pending
  // rows out, as an in-memory in-flight set is left out by the next process. The turn is handed on
  // at every model call, after its admission and before its record: the other task's admission is
  // made while the call is in flight, up to the two projects' shared cap of $6.
  it("catches an admission that leaves out the calls admitted and not yet recorded", async () => {
    const inFlight = [...BATCH_OF_TWO, switchAtEvery(/^interleave:model:/)];
    const shared = { projects: 2, capUsd: 6 } as const;
    const clean = await directed(inFlight, shared);
    expect(keys(clean), statements(clean)).toEqual([]);
    const planted = await directed(inFlight, { ...shared, mutation: "pending-uncounted" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // ADR-074 d84 b, I8 on no progress: the host cannot start a cell all run. Production requeues the
  // environment task uncharged three times, halts the project on the fourth fault, the probe resumes
  // it, and the fifth gives the task up, so the plan is repaired until it halts undeliverable. With
  // the count pinned at the halt, the project halts and resumes forever: busy, every cycle a new
  // halt episode, and nothing reached that was not reached before.
  it("catches a halt and resumption that repeat with no progress", async () => {
    const outage = { cellOutage: true } as const;
    const clean = await directed([], outage);
    expect(keys(clean)).toEqual([]);
    expect(clean.outcome.kind).toBe("halted");
    const planted = await directed([], { ...outage, mutation: "infrastructure-fault-pinned" });
    expect(planted.trace.filter((line) => line.endsWith("1 task(s) [interrupted]")).length).toBeGreaterThan(4);
    expect(keys(planted)).toEqual(["I1:open", "I8:Pending"]);
    expect(planted.outcome.kind).toBe("open");
  }, 90_000);

  // ADR-074 d84 b, W7: with no adversary the stand-ins drive the project to Accepted on one passed
  // sweep of main; the delivered report is judged against the goal tasks' merge records and the task
  // and check records, so a report that drops a goal's close, misstates what no stored check covers,
  // leaves out an asked-for item no acceptance line cites, or is posted with no record of it (and so
  // posted again) is named.
  it("accepts a project on a passed sweep and catches a delivered report that misstates its records", async () => {
    const clean = await directed([]);
    expect(clean.outcome.kind).toBe("accepted");
    expect(keys(clean)).toEqual([]);
    expect([...clean.coverage.projectStatuses]).toContain("accepted");
    expect([...clean.coverage.sweeps]).toEqual(["ran:passed"]);
    expect(keys(await directed([], { mutation: "delivered-report-omits-goal" }))).toEqual(["I4:delivered-close"]);
    expect(keys(await directed([], { mutation: "delivered-report-misstates-unchecked" }))).toEqual(["I4:delivered-unchecked"]);
    // Every in-scope line and the asked assumption (classed undecided, so client-visible) must be decided by a stored
    // check (d89 E, ADR-083). A check set stored with one cited item decided by none of its checks leaves it unchecked,
    // though an acceptance line still cites it: I6 names it.
    expect(keys(await directed([], { mutation: "check-set-skips-item" }))).toEqual(SKIPPED_ITEM);
    // The delivered report must list that item as decided by no stored check.
    expect(keys(await directed([], { mutation: "delivered-report-omits-uncovered" }))).toEqual(["I4:delivered-coverage", ...SKIPPED_ITEM]);
    // The stand-ins' internal-design assumption is named as not verified by Ashara; dropped, it is named (ADR-083).
    expect(keys(await directed([], { mutation: "delivered-report-omits-unverified" }))).toEqual(["I4:delivered-coverage"]);
    expect(keys(await directed([], { mutation: "delivered-report-unrecorded" }))).toContain("I4:unrecorded-report");
  }, 120_000);

  // I9 (text against fact): what a composer states is what the store held when it composed it. Every
  // brief carries the stand-ins' asked assumption with its standing, and the question states it. The
  // delivered report states the standing of an asked-for item no stored check decides, so its plant
  // stores a check set with that item undecided, which I6 names too.
  it("catches a brief, a question and a delivered report that state what their records do not hold", async () => {
    const briefs = keys(await directed([], { mutation: "brief-misstates-standing" }));
    expect(briefs).toContain("I9:brief-assumptions:Define and commit the project environment");
    expect(briefs.every((key) => key.startsWith("I9:brief-assumptions:"))).toBe(true);
    expect(keys(await directed([], { mutation: "delivered-report-misstates-standing" }))).toEqual([...SKIPPED_ITEM, "I9:delivered-standing:A1"]);
    expect(keys(await directed([], { mutation: "question-misstates-assumption" }))).toEqual(["I9:question:A1"]);
  }, 120_000);

  // The delivered report quotes the public interface file main holds, cut when it is too long. The
  // scaffold writes a short one (benign), none (1) or a long one (2); with none, acceptance refuses
  // main, the repair plans the file, and the report quotes it once written.
  it("catches a delivered report whose how-to-run section is not main's public interface file", async () => {
    const scaffold = (form: number): Direction => draw("agent.scaffold.public-interface", "every", form, "scaffold");
    const oversized = await directed([scaffold(2)]);
    expect(oversized.outcome.kind).toBe("accepted");
    expect(keys(oversized)).toEqual([]);
    expect(keys(await directed([], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
    expect(keys(await directed([scaffold(1)], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
  }, 180_000);

  // Every implementer leaves the scaffold's public interface file as it was: acceptance refuses main
  // while it is the scaffold's, the repair plans its update, and the project is accepted only once
  // main's file describes the product, so no delivered report quotes the placeholder.
  it("refuses acceptance while main's public interface file is the scaffold's, and accepts it once updated", async () => {
    const stale = await directed([implementation("agent.interface-left-stale", "every")]);
    expect(stale.outcome.kind).toBe("accepted");
    expect(keys(stale)).toEqual([]);
    const sweeps = stale.trace.filter((line) => line.startsWith("acceptance sweep "));
    expect(sweeps[0]).toBe("acceptance sweep ran:failed");
    expect(sweeps.at(-1)).toBe("acceptance sweep ran:passed");
  }, 180_000);

  // W6/W7: a halt's report quotes the cause recorded on its episode. Under a cell outage the project
  // halts on infrastructure and then undeliverable (plan_repair); at the low cap it halts at once.
  it("catches a halt report that states a fixed cause instead of the recorded one", async () => {
    const outage = await directed([], { cellOutage: true, mutation: "halt-report-fixed-cause" });
    expect(keys(outage)).toEqual(["I4:halt-cause:infrastructure", "I4:halt-cause:plan_repair"]);
    const spend = await directed([draw("finance.low-budget", 1)], { mutation: "halt-report-fixed-cause" });
    expect(spend.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(keys(spend)).toEqual(["I4:halt-cause:budget_cap"]);
  }, 120_000);

  // The stop report names exactly the merges recorded: the client stops the project at cycle 5
  // (2 plus the stop-cycle draw), after three tasks merged.
  it("catches a stop report that leaves out a merge on record", async () => {
    const stop = [draw("client.stop", 1), draw("client.stop-cycle", 1, 3)];
    const clean = await directed(stop);
    expect(clean.outcome.kind).toBe("stopped");
    expect(clean.trace).toContain("client stop at cycle 5");
    expect(keys(clean)).toEqual([]);
    expect(keys(await directed(stop, { mutation: "stop-report-omits-merge" }))).toEqual(["I4:stop-merges"]);
  }, 90_000);

  // A plant whose query production never sends planted nothing: the run says so instead of
  // reporting the mutation as not caught. At a cap of $0.02 nothing merges, so no merge record is written.
  it("throws for a plant that rewrote no query", async () => {
    await expect(directed([], { capUsd: 0.02, mutation: "skip-merge-record" })).rejects.toThrow(/plant of mutation skip-merge-record rewrote no query/);
  }, 90_000);

  it("catches a merge recorded under a commit main does not hold", async () => {
    const clean = await directed([]);
    expect(failed(clean)).toEqual([]);
    const planted = await directed([], { mutation: "skip-merge-record" });
    expect(failed(planted)).toContain("I7");
  }, 90_000);

  /*
   * The adversarial behaviours (docs/investigations/test-retro-2026-10-15/, pattern 2; ADR-081), each judged twice: the
   * stand-in's trace says it misbehaved, and production's own records (coverage.ts MODEL_PATHS, the
   * attempt terminals of dev_sessions) say the gateway, the attempt loop and the routers met it; and
   * the run passes every invariant.
   */
  function adversarial(directions: readonly Direction[]): Promise<RunResult> {
    return directed(directions, { profile: "adversarial" });
  }

  function expectReached(result: RunResult, injected: readonly string[], models: readonly string[], attempts: readonly string[]): void {
    expect(keys(result), statements(result)).toEqual([]);
    for (const line of injected) expect(result.trace).toContain(`model ${line}`);
    expect([...result.coverage.models]).toEqual(expect.arrayContaining([...models]));
    expect([...result.coverage.attempts]).toEqual(expect.arrayContaining([...attempts]));
  }

  // (a) Both tasks of a batch write product/INDEX, each branched before the other merged;
  // the second's retry is handed its conflict with main.
  const SAME_FILE = [...BATCH_OF_TWO, switchAtEvery(/^interleave:git:/), implementation("agent.shared-file", "every")];

  it("hands the second of two same-file edits its conflict with main, which it resolves", async () => {
    const result = await adversarial(SAME_FILE);
    expectReached(result, ["agent-runner handed a conflict in product/INDEX: resolves it"], ["merge:conflict-presented"], ["finished:done"]);
  }, 90_000);

  it("hands a conflict to an implementer that leaves its markers in", async () => {
    const result = await adversarial([...SAME_FILE, implementation("agent.conflict.markers-left", 1)]);
    expectReached(result, ["agent-runner handed a conflict in product/INDEX: leaves its markers"], ["merge:conflict-presented"], []);
  }, 90_000);

  // (b) and (d) on agent turns: the first implementation attempt's first turn is cut at the output
  // limit mid tool call, the next one's is all reasoning; neither turn's calls run.
  it("ends an attempt whose turn is cut at the output limit, mid tool call or all reasoning", async () => {
    const result = await adversarial([implementation("agent.truncated-turn", 1), implementation("agent.reasoning-exhausted", 1)]);
    expectReached(result, ["agent-runner truncated", "agent-runner reasoning-exhausted"], ["turn:truncated", "turn:reasoning-exhausted"], ["output_truncated"]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // (c) on an agent turn. The gateway refuses a turn with no message (TurnResponseInvalid), so the
  // attempt ends as transport_exhausted, not model_stopped_without_finish.
  it("ends an attempt whose turn answers nothing", async () => {
    const result = await adversarial([implementation("agent.empty-turn", 1)]);
    expectReached(result, ["agent-runner empty"], ["turn:empty"], ["transport_exhausted"]);
    expect(result.outcome, JSON.stringify(result.outcome)).toMatchObject({ kind: "accepted" });
  }, 90_000);

  // (e) The turn cap ends an attempt after its first edit; the task still completes.
  it("ends an attempt at its turn cap in the middle of its edits", async () => {
    const result = await adversarial([implementation("agent.turn-cap-mid-edit", 1)]);
    expectReached(result, ["agent-runner stall-mid-edit"], [], ["turn_cap"]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // (b), (c), (d), (g) on one-shot structured calls: each is a failed ladder attempt, never an answer.
  it("retries structured calls that are cut, empty, all reasoning or of the wrong shape", async () => {
    const result = await adversarial([
      draw("model.liaison-intake.empty", 1),
      draw("model.roster.invalid", 1),
      draw("model.decomposition.tasks.truncated", 1),
      draw("model.suite-review.reasoning-exhausted", 1),
    ]);
    expectReached(
      result,
      ["liaison-intake empty", "roster invalid-output", "decomposition.tasks truncated", "suite-review reasoning-exhausted"],
      ["structured:empty", "structured:invalid", "structured:truncated", "structured:reasoning-exhausted"],
      [],
    );
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // A review that rejects a correct check as outside the vision, quoting as missing the
  // very text its cited item states; Z0 finds the clause in that text, discards the rejection and
  // asks again, so nothing reopens the check (I3's review clause).
  it("discards a suite review's rejection whose missing clause the cited item states", async () => {
    const result = await adversarial([draw("model.suite-review.misread", 1)]);
    expectReached(result, ["suite-review misread"], [], []);
    expect(result.outcome.kind).toBe("accepted");
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
