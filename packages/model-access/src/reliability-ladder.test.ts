import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SchemaValidationError } from "./errors.js";
import { StructuredOutputExhausted, withStructuredLadder } from "./reliability-ladder.js";
import type { LadderAttemptEvent } from "./reliability-ladder.js";

describe("withStructuredLadder exhaustion", () => {
  test("a failure that names no model is reported as such, never as a model called 'unknown'", async () => {
    const events: LadderAttemptEvent[] = [];
    const ladder = withStructuredLadder(
      { generateStructured: () => Promise.reject(new SchemaValidationError(["no JSON in the answer"], null)) },
      { site: "decomposition", attempts: 1, onAttempt: (e) => events.push(e) },
    );

    const failure = await ladder
      .generateStructured({ capability: "Frontier", prompt: "p", schema: z.object({ a: z.string() }), maxTokens: 10 })
      .then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(StructuredOutputExhausted);
    if (!(failure instanceof StructuredOutputExhausted)) return;
    expect(failure.perModel.map((m) => m.model)).toEqual([null]);
    expect(failure.message).toContain("Frontier/no model reported x1");
    expect(events.map((e) => e.model)).toEqual([null]);
  });
});
