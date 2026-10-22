import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SchemaValidationError } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { ClientChanges } from "./client-change.js";
import type { ClientChangeOutcome, ClientChangeStore, CorrectionWrite, OpenChange } from "./client-change.js";
import type { ChangeImpact } from "./correction.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-000000000001", "test");
const TENDER = "Build a command that prints a greeting and exits with status 0.";

/** Vision v1 in the guarantees form: G1 and G2 observed at I1, no assumption, no exclusion. */
const VISION = {
  projectId: PROJECT,
  version: 1,
  visionText: TENDER,
  summary: "A greeting command.",
  scopeBoundaries: [],
  inferences: [],
  openQuestions: [],
  contractForm: "guarantees",
  interface: [{ id: "I1", text: "The command.", source: { kind: "tender", quote: "Build a command" } }],
  guarantees: [
    {
      id: "G1",
      statement: "The command prints a greeting.",
      observable: { interface: ["I1"], observation: "output" },
      refutedBy: ["The command prints no greeting.", "The greeting is empty."],
      source: { kind: "tender", quote: "prints a greeting" },
    },
    {
      id: "G2",
      statement: "The command exits with status 0.",
      observable: { interface: ["I1"], observation: "exit-status" },
      refutedBy: ["The command exits with a status other than 0."],
      source: { kind: "tender", quote: "exits with status 0" },
    },
  ],
  exclusions: [],
};

const CHANGE: OpenChange = {
  id: "change-1",
  projectId: PROJECT,
  body: "",
  intakeAttempts: 0,
  intakeLastError: null,
  intakeLastFailure: null,
  vision: VISION,
  usedKeys: ["I1", "G1", "G2"],
  proposals: [],  paused: false,
};

/** The merged task delivering G1, as the project's current plan holds it. */
const G1_MERGED: ChangeImpact = {
  tasks: [{ id: "task-1", title: "Print the greeting", status: "merged", cites: ["G1"] }],
  completedTaskRequests: [10, 20],
  budgetLeftRequests: 500,
};

/** A model answering every correction reading with `correction`, validated as a provider validates it. */
function reading(correction: unknown): ContextualLlm {
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        const parsed = request.schema.safeParse({ correction });
        if (!parsed.success) throw new SchemaValidationError([z.prettifyError(parsed.error)], "stub-model");
        return { data: parsed.data, model: "stub-model", provider: "stub", grade: "Strong" };
      },
    }),
  };
}

function recordingStore(change: OpenChange, impact: ChangeImpact): { readonly store: ClientChangeStore; readonly writes: CorrectionWrite[] } {
  const writes: CorrectionWrite[] = [];
  const store: ClientChangeStore = {
    openChanges: async () => [change],
    openChange: async () => change,
    impact: async () => impact,
    recordCorrection: async (write) => {
      writes.push(write);
      return { kind: "recorded" };
    },
    recordFailedAttempt: async () => 1,
    blockProject: async () => "blocked",
  };
  return { store, writes };
}

async function readOnce(body: string, correction: unknown, impact: ChangeImpact) {
  const { store, writes } = recordingStore({ ...CHANGE, body }, impact);
  const outcomes = await new ClientChanges({ shutdownSignal: new AbortController().signal, llm: reading(correction), store, containment: memoryStepContainment(() => false) }).runPending();
  const [write] = writes;
  if (write === undefined) throw new Error(`nothing was written; outcomes: ${JSON.stringify(outcomes)}`);
  return { outcomes, write };
}

describe("a client's change is read into typed operations and never refused", () => {
  test("withdrawing a guarantee a merged task delivers is a narrows revision held with a pushback, status proposed, and no version written", async () => {
    const { outcomes, write } = await readOnce("Drop the greeting.", { ops: [{ op: "withdraw-guarantee", id: "G1", direction: "narrows" }], confirms: [] }, G1_MERGED);

    expect(write.revision?.status).toBe("proposed");
    expect(write.revision?.record).toMatchObject({
      author: "client",
      sourceMessageId: "change-1",
      approver: null,
      direction: "narrows",
      pushback: { reasons: [{ kind: "merged-guarantee", guarantees: ["G1"] }] },
    });
    expect(write.note).toContain("Print the greeting (merged)");
    expect(write.note).toContain("This change will be made as you sent it once you confirm; nothing else waits.");
    expect(outcomes).toMatchObject([{ kind: "recorded", revision: { status: "proposed", direction: "narrows" } }]);
  });

  test("an amendment the model labels widens that drops a refuting observation is stored narrows", async () => {
    const amend = {
      op: "amend-guarantee",
      id: "G1",
      statement: "The command prints a greeting.",
      interface: ["I1"],
      observation: "output",
      refutedBy: ["The command prints no greeting."],
      direction: "widens",
    };
    const { write } = await readOnce("Any greeting will do, even an empty one.", { ops: [amend], confirms: [] }, { ...G1_MERGED, tasks: [] });

    expect(write.revision?.status).toBe("applied");
    expect(write.revision?.record.direction).toBe("narrows");
    expect(write.revision?.record.ops).toMatchObject([{ target: "guarantee", action: "amend", key: "G1", direction: "narrows", labelled: "widens" }]);
  });

  test("no outcome a change can have is a refusal", () => {
    type Refusing = Extract<ClientChangeOutcome["kind"], "refused" | "rejected" | "deferred" | "not-applied">;
    const none: [Refusing] extends [never] ? true : false = true;
    expect(none).toBe(true);
  });
});
