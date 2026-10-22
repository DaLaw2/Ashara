import { describe, expect, it } from "vitest";
import { directed, draw, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier on a contract Ashara can verify no guarantee of: the seed shape whose tender is
 * drafted with every guarantee observed in stored data is declined at proposal. Every intake message
 * says so, the client's confirmation of it as written starts no work, and its restatement releases the
 * work to acceptance. Beside the clean run, a plant that reads the declined contract as one Ashara can
 * verify starts work before the restatement, which I6's declined-work clause must catch.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed: a contract Ashara can verify no guarantee of", () => {
  const UNVERIFIABLE = [draw("universe.unverifiable-tender", 1)];

  it("is declined at proposal, stays declined through the client's confirmation, and is released by its restatement", async (ctx) => {
    const clean = await directed(ctx, UNVERIFIABLE);
    expect(keys(clean), statements(clean)).toEqual([]);
    const trace = clean.trace.join("\n");
    expect(clean.trace.some((line) => line.startsWith("universe ") && line.includes(" unverifiable")), trace).toBe(true);
    const confirmedAt = clean.trace.findIndex((line) => line.startsWith("client confirms the declined contract as written"));
    const restatedAt = clean.trace.findIndex((line) => line.startsWith("client restates the declined contract"));
    expect(confirmedAt, trace).toBeGreaterThan(-1);
    expect(restatedAt, trace).toBeGreaterThan(confirmedAt);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
  }, 90_000);

  it("catches work started on the declined contract before its restatement", async (ctx) => {
    const run = await directed(ctx, UNVERIFIABLE, { mutation: "declined-contract-planned" });
    const planted = keys(run);
    expect(planted, `${planted.join(", ")}\n${run.trace.join("\n")}`).toContain("I6:declined-work");
  }, 90_000);
});
