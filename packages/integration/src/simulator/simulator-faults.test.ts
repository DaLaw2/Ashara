import { describe, expect, it } from "vitest";
import { RARE_UNDER_OWN_PROFILES } from "./coverage.js";
import { TRANSPORT_RESPONSES } from "./faults.js";
import type { RunResult } from "./run.js";
import { BATCH_OF_TWO, directed, draw, fault, implementation, keys, statements, switchAtEvery, useSimulatorDatabase } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's faults, transport answers and adversarial stand-ins (simulator-harness.ts
 * directed): production meets each forced behaviour and passes every invariant. The plants the
 * invariants must catch are simulator-plants.test.ts.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed", () => {
  // The first BEGIN fails with a 40001. The transaction wrapper (db
  // connection.ts) releases the connection whose BEGIN failed, so no checkout outlives the process.
  it("releases the connection of a failed BEGIN, leaving none checked out", async () => {
    const result = await directed([{ kind: "fault", seam: "db", label: "begin", nth: 1, fault: "db-query-failed" }]);
    expect(result.faults.map((f) => `${f.label}:${f.fault}`)).toEqual(["begin:db-query-failed"]);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  /** A crash in the implementation's dispatch, which leaves its task InProgress for the next startup. */
  const CRASH_IN_DISPATCH: Direction = { kind: "fault", seam: "git", label: "ls-tree", nth: 2, fault: "crash-before" };

  // Task t-orphan-requeue-failure: a crash in a dispatch leaves its task InProgress (its orphan),
  // then a 40001 on the startup reconciler's dev_sessions read of that orphan. The reconciler
  // retries the requeue within its bound, so the orphan is never left InProgress.
  it("retries a failed requeue of an orphan, never leaving it InProgress while the process lives", async () => {
    const result = await directed([
      CRASH_IN_DISPATCH,
      { kind: "fault", seam: "db", label: /^select count\(\*\) from "dev_sessions"/, nth: 2, fault: "db-query-failed" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", "db:db-query-failed"]);
    expect(result.log.some((line) => line.includes("requeue the task failed on attempt 1 of 3; retrying"))).toBe(true);
    expect(keys(result)).toEqual([]);
  }, 90_000);

  // Loop L7's early stop (startup-reconciler.ts CRASH_LOOP_BOUND, ADR-084 decision 1): the task's
  // dispatch dies, and its re-dispatch dies again right after the task is set InProgress. The second
  // startup to find it InProgress gives it up as crash_loop instead of dispatching it a third time.
  it("gives up a task found InProgress at two startups in a row as a crash loop, never re-dispatching it", async () => {
    const result = await directed([
      CRASH_IN_DISPATCH,
      { kind: "fault", seam: "db", label: /^update "work_items" set "status" = \$1, "blocked_reason" = \$2/, nth: 5, fault: "crash-after" },
    ]);
    expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual(["git:crash-before", "db:crash-after"]);
    expect(result.log.some((line) => line.includes("given up (crash_loop), never re-dispatched"))).toBe(true);
    expect(keys(result), statements(result)).toEqual([]);
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

  // The fake transport answers the first model call (the tender's intake read) with each status. A
  // 4xx rejecting the request as Ashara built it is Ashara's: never counted against the read (I10),
  // contained to its tender and retried. A reset, a 429 or a 5xx is the provider's, counted against it.
  for (const [index, response] of TRANSPORT_RESPONSES.entries()) {
    it(`answers a transport ${response.status ?? "reset"} as ${response.owner === "ashara" ? "Ashara's" : "the provider's"}, charging only what is the provider's`, async () => {
      const result = await directed([fault("model", /./, "provider-error"), draw(/^fault\.model:.*\.response$/, 1, index)]);
      expect(result.faults.map((f) => `${f.fault}:${f.response?.status ?? "reset"}`)).toEqual([`provider-error:${response.status ?? "reset"}`]);
      const blamed = response.owner === "ashara" ? "(a fault on Ashara's side)" : "(the provider failed the request)";
      expect(result.log.some((line) => line.includes(blamed)), result.log.join("\n")).toBe(true);
      expect(keys(result), statements(result)).toEqual([]);
    }, 90_000);
  }

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
