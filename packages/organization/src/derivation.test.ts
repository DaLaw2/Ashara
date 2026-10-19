import { describe, expect, it, vi } from "vitest";
import type { ContextualLlm } from "@ashara/finance";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { RosterDerivation } from "./derivation.js";
import type { RosterStore } from "./derivation.js";
import type { Roster } from "./roster.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-000000000031", "test");

const VALID = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the studio owner.", capabilities: ["client-comms"] },
    { name: "Platform engineer", responsibility: "Defines the build.", capabilities: ["write-environment"] },
    { name: "Booking developer", responsibility: "Builds the booking page.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the acceptance checks.", capabilities: ["author-checks"] },
  ],
};

// One developer who also writes the checks that judge them.
const SELF_JUDGING = {
  roles: [
    VALID.roles[0],
    VALID.roles[1],
    { name: "Developer", responsibility: "Builds and checks.", capabilities: ["write-source", "author-checks"] },
  ],
};

/** A model that answers each call with the next response, recording every prompt. */
function scripted(...responses: unknown[]) {
  const prompts: string[] = [];
  const llm: ContextualLlm = {
    forCall: () => ({
      async generateStructured(request) {
        prompts.push(request.prompt);
        const next = responses.length > 1 ? responses.shift() : responses[0];
        return { data: request.schema.parse(next), model: "stub", provider: "stub", grade: "Strong" };
      },
    }),
  };
  return { llm, prompts };
}

function memoryStore() {
  const recorded: Roster[] = [];
  const store: RosterStore = {
    projectsAwaitingRoster: async () =>
      recorded.length > 0
        ? []
        : [
            {
              projectId: PROJECT,
              vision: {
                projectId: PROJECT,
                version: 1,
                visionText: "Booking page for my two pottery studios.",
                summary: "Booking page.",
                scopeBoundaries: [],
                inferences: [{ statement: "Bookings need no account.", status: "Inferred" }],
                openQuestions: [],
                contractForm: "scope-lines",
                interface: [],
                guarantees: [],
                exclusions: [],
              },
            },
          ],
    recordRoster: async (roster) => {
      recorded.push(roster);
      return "recorded";
    },
  };
  return { store, recorded };
}

describe("RosterDerivation", () => {
  it("records a valid roster as revision 1 of vision v1, with fresh role ids", async () => {
    const { llm, prompts } = scripted(VALID);
    const { store, recorded } = memoryStore();

    const outcomes = await new RosterDerivation({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes).toEqual([
      { kind: "recorded", projectId: PROJECT, revision: 1, roles: VALID.roles.map((r) => r.name) },
    ]);
    expect(recorded[0]?.visionVersion).toBe(1);
    expect(new Set(recorded[0]?.roles.map((r) => r.id)).size).toBe(4);
    expect(prompts[0]).toContain("Bookings need no account. (Inferred)");
  });

  it("re-asks a roster that breaks a rule, naming the violation, and records the corrected one", async () => {
    const { llm, prompts } = scripted(SELF_JUDGING, VALID);
    const { store, recorded } = memoryStore();

    const outcomes = await new RosterDerivation({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["recorded"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`Role "Developer" holds both "write-source" and "author-checks"`);
    expect(recorded[0]?.roles.map((r) => r.name)).toEqual(VALID.roles.map((r) => r.name));
  });

  it("refuses the roster with the violations when every attempt breaks a rule, records none and blocks nothing itself", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { llm, prompts } = scripted(SELF_JUDGING);
    const { store, recorded } = memoryStore();

    const outcomes = await new RosterDerivation({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["refused"]);
    expect(prompts).toHaveLength(6);
    expect(recorded).toEqual([]);
    const refused = outcomes[0];
    if (refused?.kind !== "refused") throw new Error("expected a refused roster");
    expect(refused.refusal.errorClass).toBe("RosterDerivationExhausted");
    expect(refused.refusal.reason).toContain(`Role "Developer" holds both "write-source" and "author-checks"`);
  });
});
