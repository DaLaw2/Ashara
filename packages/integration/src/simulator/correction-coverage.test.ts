import { describe, expect, it } from "vitest";
import { storedCorrectionPairs } from "./correction-coverage.js";
import type { Universe } from "./product.js";
import { readCorrection } from "./stand-ins/liaison.js";
import { ASSUMPTIONS_HEADING, INTERFACE_HEADING } from "./stand-ins/recognised-wording.js";

/** One vision_revisions.ops entry as Engagement stores it. */
const stored = (target: string, action: string): Record<string, unknown> => ({
  target,
  action,
  key: null,
  direction: "narrows",
  labelled: "narrows",
  read: null,
  statement: null,
});

describe("the correction coverage records", () => {
  it("records the kind the stored revision holds, not the kind drawn", () => {
    const pairs = storedCorrectionPairs({ arrival: "halted", kind: "change-interface" }, [stored("exclusion", "add")]);
    expect(pairs).toEqual(["halted:add-exclusion"]);
    expect(pairs).not.toContain("halted:change-interface");
  });

  it("records each stored operation's kind", () => {
    const ops = [stored("guarantee", "amend"), stored("assumption", "amend"), stored("interface", "amend")];
    expect(storedCorrectionPairs({ arrival: "after-merge", kind: "add-guarantee" }, ops)).toEqual([
      "after-merge:rewrite-guarantee",
      "after-merge:change-assumption",
      "after-merge:change-interface",
    ]);
  });

  it("refuses a stored operation no correction kind is, and a revision that stores none", () => {
    const draw = { arrival: "before-review", kind: "add-exclusion" } as const;
    expect(() => storedCorrectionPairs(draw, [stored("interface", "withdraw")])).toThrow(/interface:withdraw/);
    expect(() => storedCorrectionPairs(draw, [])).toThrow();
  });
});

describe("the Liaison stand-in's reading of a correction", () => {
  const universe: Universe = {
    behaviours: ["b1"],
    outOfVision: "b9",
    tasks: [{ ref: "t1", behaviours: ["b1"] }],
    independent: false,
    unverifiable: false,
  };
  const guarantee = {
    id: "G1",
    statement: "b1 prints its value.",
    observable: { interface: ["I1"], observation: "output" },
    refutedBy: ["b1 prints nothing."],
  };
  const ground = (prompt: string, cites: readonly string[] = []) => ({
    guarantees: [guarantee],
    prompt,
    universe,
    cites: () => Promise.resolve([cites]),
  });

  it("marks a kind with nothing on record to act on as a fallback naming the kind asked", async () => {
    const assumption = await readCorrection("change-assumption", ground("No sections."));
    expect(assumption).toMatchObject({ kind: "fallback", asked: "change-assumption" });
    const withdraw = await readCorrection("withdraw-guarantee", ground("No sections."));
    expect(withdraw).toMatchObject({ kind: "fallback", asked: "withdraw-guarantee" });
    const rewrite = await readCorrection("rewrite-guarantee", ground("No sections."));
    expect(rewrite).toMatchObject({ kind: "fallback", asked: "rewrite-guarantee" });
  });

  it("reads the exclusion asked for itself, and a kind with its target on record, as no fallback", async () => {
    expect(await readCorrection("add-exclusion", ground("No sections."))).toMatchObject({ kind: "read" });
    const prompt = `${ASSUMPTIONS_HEADING}\n- A1: The product runs locally.\n${INTERFACE_HEADING}\n- I1: the command line`;
    expect(await readCorrection("change-assumption", ground(prompt))).toMatchObject({ kind: "read" });
    expect(await readCorrection("rewrite-guarantee", ground(prompt, ["G1"]))).toMatchObject({ kind: "read" });
  });
});
