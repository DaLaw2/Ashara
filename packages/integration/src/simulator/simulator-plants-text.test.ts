import { describe, expect, it } from "vitest";
import { directed, draw, implementation, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on intake and on what a composed
 * text states: each mutation an invariant must catch, most beside the clean run of the same tape,
 * which passes.
 * Each test makes one directed run, or two where one judgment needs both, so a test's time is a
 * run's and fits its timeout under the whole suite's load. The directed tier's plants are split
 * across the simulator-plants*.test.ts files so vitest runs them on separate workers.
 */
useSimulatorDatabase();

/**
 * What I6 names when a check set of the stand-ins is stored with its last decided item undecided
 * (check-set-skips-item): the guarantee naming no behaviour, the last the scripted intake drafts for
 * the directed tier's two behaviours.
 */
const SKIPPED_ITEM = ["I6:unchecked-item:G3"];

describe("lifecycle simulator, directed", () => {
  // I3's intake clause: the lazy intake persona's reading asks the client nothing. The simulator's
  // catalog holds one model family, so the second reading is another model of it, asked what is
  // ambiguous or assumed; it raises the question the tender leaves open, which is the one the client
  // is sent, and the project is delivered. With the second reading dropped (the reading that asked
  // nothing taken as the tender being unambiguous, recorded as another family's agreement no model
  // gave), I3 names the reading no second reading was asked of.
  const LAZY_INTAKE = [draw("persona.intake.on", 1), draw("persona.intake", 1), draw("persona.intake.fires", "every")];
  it("puts a lazy intake's reading to a second reading whose question the client is sent", async (ctx) => {
    const clean = await directed(ctx, LAZY_INTAKE);
    expect(clean.trace.some((line) => line.includes("intake=lazy")), clean.trace.slice(0, 5).join("\n")).toBe(true);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(keys(clean), statements(clean)).toEqual([]);
  }, 90_000);

  it("catches an intake that drops a lazy reading's second reading", async (ctx) => {
    const planted = await directed(ctx, LAZY_INTAKE, { mutation: "intake-second-reading-dropped" });
    expect(keys(planted), statements(planted)).toEqual(["I3:lazy-intake"]);
  }, 90_000);

  // A second reading that never answers whole at any strength (every attempt is invalid output) leaves
  // the reading unconfirmed: recorded, told to the client and in the delivered report, never holding
  // the tender, and the project is still delivered.
  it("delivers on an unconfirmed reading when the second reading fails at every strength", async (ctx) => {
    const failing = [...LAZY_INTAKE, draw("model.liaison-intake.second.invalid", "every")];
    const result = await directed(ctx, failing);
    expect(result.outcome.kind, statements(result)).toBe("accepted");
    expect(keys(result), statements(result)).toEqual([]);
    expect(result.log.some((line) => line.includes("no second reading answered at any strength"))).toBe(true);
  }, 90_000);

  // I9 (text against fact): what a composer states is what the store held when it composed it. Every
  // brief carries the stand-ins' asked assumption with its standing, and the question states it. The
  // delivered report states the standing of the assumption under a guarantee no stored check
  // decides, so its plant stores a check set with that guarantee undecided, which I6 names too.
  it("catches a brief that states an assumption's standing its record does not hold", async (ctx) => {
    const briefs = keys(await directed(ctx, [], { mutation: "brief-misstates-standing" }));
    expect(briefs).toContain("I9:brief-assumptions:Define and commit the project environment");
    expect(briefs.every((key) => key.startsWith("I9:brief-assumptions:"))).toBe(true);
  }, 90_000);

  it("catches a delivered report that states an item's standing its record does not hold", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-misstates-standing" }))).toEqual([...SKIPPED_ITEM, "I9:delivered-standing:A1"]);
  }, 90_000);

  it("catches a question that states an assumption its record does not hold", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "question-misstates-assumption" }))).toEqual(["I9:question:A1"]);
  }, 90_000);

  // The delivered report quotes the public interface file main holds, cut when it is too long. The
  // scaffold writes a short one (benign), none (1) or a long one (2); with none, acceptance refuses
  // main, the repair plans the file, and the report quotes it once written.
  const scaffold = (form: number): Direction => draw("agent.scaffold.public-interface", "every", form, "scaffold");
  it("delivers a report quoting main's public interface file cut when it is too long", async (ctx) => {
    const oversized = await directed(ctx, [scaffold(2)]);
    expect(oversized.outcome.kind).toBe("accepted");
    expect(keys(oversized)).toEqual([]);
  }, 90_000);

  it("catches a delivered report whose how-to-run section is not main's public interface file", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
  }, 90_000);

  it("catches a delivered report that misquotes the public interface file a repair wrote", async (ctx) => {
    expect(keys(await directed(ctx, [scaffold(1)], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
  }, 90_000);

  // Every implementer leaves the scaffold's public interface file as it was: acceptance refuses main
  // while it is the scaffold's, the repair plans its update, and the project is accepted only once
  // main's file describes the product, so no delivered report quotes the placeholder.
  it("refuses acceptance while main's public interface file is the scaffold's, and accepts it once updated", async (ctx) => {
    const stale = await directed(ctx, [implementation("agent.interface-left-stale", "every")]);
    expect(stale.outcome.kind).toBe("accepted");
    expect(keys(stale)).toEqual([]);
    const sweeps = stale.trace.filter((line) => line.startsWith("acceptance sweep "));
    expect(sweeps[0]).toBe("acceptance sweep ran:failed");
    expect(sweeps.at(-1)).toBe("acceptance sweep ran:passed");
  }, 90_000);
});
