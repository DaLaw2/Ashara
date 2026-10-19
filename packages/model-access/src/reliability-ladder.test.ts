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

  test("a judging request is asked as one on every attempt: its escalation keeps the judged tier at the escalation site", async () => {
    const sent: unknown[] = [];
    const ladder = withStructuredLadder(
      {
        generateStructured: (request) => {
          sent.push({ judges: request.judges, capability: request.capability, site: request.site });
          return Promise.reject(new SchemaValidationError(["not the answer"], "judge"));
        },
      },
      { site: "suite-review", attempts: 1 },
    );

    const failure = await ladder
      .generateStructured({ judges: "Strong", prompt: "p", schema: z.object({ a: z.string() }), maxTokens: 10 })
      .then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(StructuredOutputExhausted);
    expect(sent).toEqual([
      { judges: "Strong", capability: undefined, site: "suite-review" },
      { judges: "Strong", capability: undefined, site: "escalation" },
    ]);
  });
});
