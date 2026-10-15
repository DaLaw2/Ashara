import { describe, expect, test } from "vitest";
import { PreCallRefusal } from "@ashara/finance";
import type { Outcome } from "./outcome.js";
import { attemptSummary, outcomeRecord } from "./session-attempt.js";

const base = {
  turnsUsed: 3,
  cost: { measured: true as const, totalUsd: 0.25, turns: 3 },
  lastToolCall: { turn: 3, toolName: "run_command", input: "{}" },
  promptDigest: "0".repeat(64),
  detail: "why it ended",
};

type FailedKind = Exclude<Outcome["kind"], "finished">;

function terminal(kind: FailedKind): Outcome {
  switch (kind) {
    case "turn_cap":
      return { ...base, kind, maxTurns: 3 };
    case "wall_clock":
      return { ...base, kind, wallClockMs: 1000, elapsedMs: 1001 };
    case "model_stopped_without_finish":
      return { ...base, kind, finishReason: "stop", rawFinishReason: "end_turn", finalText: "bye" };
    case "output_truncated":
      return { ...base, kind, turn: 3, provider: "fake", model: "m", finishReason: "truncated", rawFinishReason: "max_tokens", outputTokens: 4096, droppedToolCalls: 1 };
    case "transport_exhausted":
      return { ...base, kind, error: new Error("provider down") };
    case "cancelled":
      return { ...base, kind, reason: new Error("shutdown") };
    case "environment_failure":
      return { ...base, kind, source: "cell", error: new Error("podman exec failed") };
    case "refused":
      return { ...base, kind, error: new PreCallRefusal("budget_cap: refused") };
    case "disputed":
      return { ...base, kind, checkName: "greets", ofTask: null, reason: "the check cannot pass", evidence: null };
  }
}

// Delivery reads the Outcome itself; these are only how it is worded and recorded in an envelope.
describe("attemptSummary and outcomeRecord", () => {
  test("finished(done) is its summary; finished(blocked) carries the reason", () => {
    expect(attemptSummary({ ...base, kind: "finished", status: "done", summary: "did it", blockedReason: null, statement: null })).toBe("did it");
    expect(attemptSummary({ ...base, kind: "finished", status: "blocked", summary: "stuck", blockedReason: "needs a key", statement: null })).toBe(
      "stuck (blocked: needs a key)",
    );
  });

  test.each(["turn_cap", "wall_clock", "model_stopped_without_finish", "output_truncated", "transport_exhausted", "cancelled", "environment_failure", "refused", "disputed"] as const)(
    "%s is named with its detail, never worded as a finish",
    (kind) => {
      expect(attemptSummary(terminal(kind))).toBe(`attempt ended as ${kind}: why it ended`);
    },
  );

  test("an error or cancellation reason is recorded with its message, never as an empty object", () => {
    const record = outcomeRecord(terminal("transport_exhausted"));
    expect(record).toMatchObject({ kind: "transport_exhausted", turnsUsed: 3, error: expect.objectContaining({ message: "provider down" }) });
    expect(outcomeRecord(terminal("cancelled"))).toMatchObject({ kind: "cancelled", error: expect.objectContaining({ message: "shutdown" }) });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
