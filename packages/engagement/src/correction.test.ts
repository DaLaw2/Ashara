import { describe, expect, test } from "vitest";
import { UnderpinnedGuaranteeUnknown, affectedKeys } from "./correction.js";
import { readVisionVersion } from "./vision.js";
import type { VisionVersion } from "./vision.js";

const TENDER = "Build a command that prints a greeting, a farewell and a date, and exits with status 0.";

function guarantee(id: string, statement: string, quote: string) {
  return {
    id,
    statement,
    observable: { interface: ["I1"], observation: "output" },
    refutedBy: [`${statement} does not hold.`],
    source: { kind: "tender", quote },
  };
}

/** A guarantees-form version: A8 underpins G13, G14 and G15; G16 rests on no assumption. */
function version(number: number, statement: string): VisionVersion {
  return readVisionVersion({
    projectId: "00000000-0000-4000-8000-000000000001",
    version: number,
    visionText: TENDER,
    summary: "A greeting command.",
    scopeBoundaries: [],
    inferences: [{ key: "A8", statement, status: "Inferred", kind: "client-visible", disclosed: "asked", underpins: ["G13", "G14", "G15"] }],
    openQuestions: [],
    contractForm: "guarantees",
    interface: [{ id: "I1", text: "The command.", source: { kind: "tender", quote: "Build a command" } }],
    guarantees: [
      guarantee("G13", "The command prints a greeting.", "prints a greeting"),
      guarantee("G14", "The command prints a farewell.", "a farewell"),
      guarantee("G15", "The command prints a date.", "a date"),
      guarantee("G16", "The command exits with status 0.", "exits with status 0"),
    ],
    exclusions: [],
  });
}

describe("the keys a revision affects", () => {
  test("an amended assumption reaches every guarantee resting on it, and no other", () => {
    const keys = affectedKeys([{ target: "assumption", key: "A8" }], version(1, "The greeting is in English."), version(2, "The greeting is in French."));

    expect([...keys].sort()).toEqual(["A8", "G13", "G14", "G15"]);
  });

  test("an assumption that underpins a guarantee the version does not hold is refused, not read as resting on nothing", () => {
    const appliedTo = version(1, "The greeting is in English.");
    const broken: VisionVersion = { ...appliedTo, assumptions: appliedTo.assumptions.map((a) => ({ ...a, underpins: ["G13", "G99"] })) };

    expect(() => affectedKeys([{ target: "assumption", key: "A8" }], broken, version(2, "The greeting is in French."))).toThrow(UnderpinnedGuaranteeUnknown);
  });
});
