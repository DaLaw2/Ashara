import { describe, expect, it } from "vitest";
import type { RunResult } from "./run.js";
import { BATCH_OF_TWO, directed, draw, implementation, keys, statements, switchAtEvery, useSimulatorDatabase } from "./simulator-harness.js";
import type { TestScope } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's adversarial stand-ins (simulator-harness.ts directed): production meets each
 * forced misbehaviour and passes every invariant.
 * The directed tier's faults are split across the simulator-faults*.test.ts files so vitest runs
 * them on separate workers; the plants the invariants must catch are the simulator-plants*.test.ts
 * files.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed", () => {
  /*
   * The adversarial behaviours, each judged twice: the
   * stand-in's trace says it misbehaved, and production's own records (coverage.ts MODEL_PATHS, the
   * attempt terminals of dev_sessions) say the gateway, the attempt loop and the routers met it; and
   * the run passes every invariant.
   */
  function adversarial(ctx: TestScope, directions: readonly Direction[]): Promise<RunResult> {
    return directed(ctx, directions, { profile: "adversarial" });
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

  it("hands the second of two same-file edits its conflict with main, which it resolves", async (ctx) => {
    const result = await adversarial(ctx, SAME_FILE);
    expectReached(result, ["agent-runner handed a conflict in product/INDEX: resolves it"], ["merge:conflict-presented"], ["finished:done"]);
  }, 90_000);

  it("hands a conflict to an implementer that leaves its markers in", async (ctx) => {
    const result = await adversarial(ctx, [...SAME_FILE, implementation("agent.conflict.markers-left", 1)]);
    expectReached(result, ["agent-runner handed a conflict in product/INDEX: leaves its markers"], ["merge:conflict-presented"], []);
  }, 90_000);

  // (b) and (d) on agent turns: the first implementation attempt's first turn is cut at the output
  // limit mid tool call, the next one's is all reasoning; neither turn's calls run.
  it("ends an attempt whose turn is cut at the output limit, mid tool call or all reasoning", async (ctx) => {
    const result = await adversarial(ctx, [implementation("agent.truncated-turn", 1), implementation("agent.reasoning-exhausted", 1)]);
    expectReached(result, ["agent-runner truncated", "agent-runner reasoning-exhausted"], ["turn:truncated", "turn:reasoning-exhausted"], ["output_truncated"]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // (c) on an agent turn. The gateway refuses a turn with no message (TurnResponseInvalid), so the
  // attempt ends as transport_exhausted, not model_stopped_without_finish.
  it("ends an attempt whose turn answers nothing", async (ctx) => {
    const result = await adversarial(ctx, [implementation("agent.empty-turn", 1)]);
    expectReached(result, ["agent-runner empty"], ["turn:empty"], ["transport_exhausted"]);
    expect(result.outcome, JSON.stringify(result.outcome)).toMatchObject({ kind: "accepted" });
  }, 90_000);

  // The window guard: the provider rejects the first implementation attempt's turn as
  // longer than the model's context window. The gateway reads that from the error data, the attempt
  // ends typed context_budget_exceeded, the failure router retries it, and the task still completes.
  it("ends an attempt whose turn the provider rejects as over its context window as context_budget_exceeded", async (ctx) => {
    const result = await adversarial(ctx, [implementation("agent.context-overflow", 1)]);
    expectReached(result, ["agent-runner context-overflow"], [], ["context_budget_exceeded"]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // (e) The turn cap ends an attempt after its first edit; the task still completes.
  it("ends an attempt at its turn cap in the middle of its edits", async (ctx) => {
    const result = await adversarial(ctx, [implementation("agent.turn-cap-mid-edit", 1)]);
    expectReached(result, ["agent-runner stall-mid-edit"], [], ["turn_cap"]);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);

  // (b), (c), (d), (g) on one-shot structured calls: each is a failed ladder attempt, never an answer.
  it("retries structured calls that are cut, empty, all reasoning or of the wrong shape", async (ctx) => {
    const result = await adversarial(ctx, [
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
  it("discards a suite review's rejection whose missing clause the cited item states", async (ctx) => {
    const result = await adversarial(ctx, [draw("model.suite-review.misread", 1)]);
    expectReached(result, ["suite-review misread"], [], []);
    expect(result.outcome.kind).toBe("accepted");
  }, 90_000);
});
