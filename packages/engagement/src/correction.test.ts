import { describe, expect, test } from "vitest";
import { affectedKeys } from "./correction.js";
import { Vision } from "./vision.js";

const TENDER = "Build a command that prints a greeting, a farewell and a date, and exits with status 0.";

function guarantee(id: string, statement: string, source: { readonly kind: "tender"; readonly quote: string } | { readonly kind: "assumption"; readonly id: string }) {
  return {
    id,
    statement,
    observable: { interface: ["I1"], observation: "output" },
    refutedBy: [`${statement} does not hold.`],
    source,
  };
}

/** A guarantees-form version: A8 underpins G13, G14 and G15; G17 cites A8 as its source; G16 rests on no assumption. */
function version(number: number, statement: string): Vision {
  return Vision.read({
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
      guarantee("G13", "The command prints a greeting.", { kind: "tender", quote: "prints a greeting" }),
      guarantee("G14", "The command prints a farewell.", { kind: "tender", quote: "a farewell" }),
      guarantee("G15", "The command prints a date.", { kind: "tender", quote: "a date" }),
      guarantee("G16", "The command exits with status 0.", { kind: "tender", quote: "exits with status 0" }),
      guarantee("G17", "Every message reads the same on every run.", { kind: "assumption", id: "A8" }),
    ],
    exclusions: [],
  });
}

describe("the keys a revision affects", () => {
  test("an amended assumption reaches every guarantee resting on it, underpinned or citing it as its source, and no other", () => {
    const keys = affectedKeys([{ target: "assumption", action: "amend", key: "A8" }], version(1, "The greeting is in English."), version(2, "The greeting is in French."));

    expect([...keys].sort()).toEqual(["A8", "G13", "G14", "G15", "G17"]);
  });

  test("an assumption confirmed as it reads affects nothing, beside an amendment that affects its own keys", () => {
    const keys = affectedKeys(
      [
        { target: "assumption", action: "confirm", key: "A8" },
        { target: "guarantee", action: "amend", key: "G16" },
      ],
      version(1, "The greeting is in English."),
      version(2, "The greeting is in English."),
    );

    expect(keys).toEqual(["G16"]);
  });
});
