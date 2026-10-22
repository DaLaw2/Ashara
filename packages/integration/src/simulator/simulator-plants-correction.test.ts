import { describe, expect, it } from "vitest";
import { directed, draw, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on a client's correction: each mutation
 * an invariant must catch, beside the clean run of the same tape, which passes. The directed tier's
 * plants are split across the simulator-plants*.test.ts files so vitest runs them on separate workers.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed: a client's correction", () => {
  // The client corrects the guarantee a task not yet started cites, after the first goal task merged:
  // only that task and the work waiting on it are held and planned again, and the project is still
  // accepted. A correction that holds the whole plan holds tasks citing only what it left as it was.
  const CORRECTED = [draw("universe.extra-behaviours", 1, 1), draw("universe.extra-tasks", 1, 2), draw("client.correction", 1)];
  it("holds and plans again only the work a client's correction touches", async (ctx) => {
    const clean = await directed(ctx, CORRECTED);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(clean.records.some((r) => r.event === "delivery.revision-written" && r.fields?.["cause"] === "client-change"), clean.trace.join("\n")).toBe(true);
  }, 90_000);

  // Every message the client sends (the tender, the correction) has its receipt by the end of the
  // next clean cycle; a listing that owes none leaves each one unanswered.
  it("catches a message left without its receipt", async (ctx) => {
    const run = await directed(ctx, CORRECTED, { mutation: "receipt-skipped" });
    const planted = keys(run);
    expect(planted.some((key) => key.startsWith("I4:receipt-late:")), planted.join(", ")).toBe(true);
  }, 90_000);

  it("catches a correction that holds the whole plan", async (ctx) => {
    const run = await directed(ctx, CORRECTED, { mutation: "correction-holds-whole-plan" });
    const planted = keys(run);
    expect(planted.some((key) => key.startsWith("I2:held-unaffected:")), planted.join(", ")).toBe(true);
  }, 90_000);

  // The client's answer amends only assumptions, the one its question asked about underpinning the
  // messages guarantee, which only the merged first task cites: the correction reaches that guarantee
  // (I2's unreached clause), so its revision plans it again, and the project is still accepted.
  it("holds the work citing a guarantee resting on an assumption an answer amends", async (ctx) => {
    const clean = await directed(ctx, [draw("client.late-change", 1)]);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.trace.some((line) => line.startsWith("client answer changes an assumption")), clean.trace.join("\n")).toBe(true);
    const restated = clean.records.some((r) => r.event === "quality.task-started" && String(r.fields?.["title"]).startsWith("Deliver what the corrected contract states"));
    expect(restated, clean.trace.join("\n")).toBe(true);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
  }, 90_000);

  // The revision for the correction fails twice (its environment judgment is unreadable at each of an
  // attempt's four calls), so the correction awaits it across a cycle, and the task it holds comes
  // back to Pending meanwhile: the gate holds it again, and the project is still accepted. A hold that
  // reads each task only as it stood when the correction was recorded dispatches it.
  const RETURNED = [
    ...CORRECTED,
    draw("correction.held-returns", 1),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((nth) => draw("model.replan.environment.invalid", nth)),
  ];
  it("holds a task that comes back to Pending while its correction awaits the revision", async (ctx) => {
    const clean = await directed(ctx, RETURNED);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.trace.some((line) => line.startsWith("held task ")), clean.trace.join("\n")).toBe(true);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
  }, 90_000);

  it("catches a hold that misses a task back at Pending", async (ctx) => {
    const run = await directed(ctx, RETURNED, { mutation: "correction-hold-misses-returned" });
    const planted = keys(run);
    expect(planted.some((key) => key.startsWith("I2:dispatched-held:")), `${planted.join(", ")}\n${run.trace.join("\n")}`).toBe(true);
  }, 90_000);
});
