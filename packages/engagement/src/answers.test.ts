import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SchemaValidationError } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { ClientAnswers } from "./answers.js";
import type { AnswerStore } from "./answers.js";
import { readVisionVersion } from "./vision.js";
import type { StoredVision } from "./vision.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-000000000002", "test");
const TENDER = "A library lends items to members. A member with an overdue loan cannot borrow. Overdue loans are fined.";

const FINE = "A fine accrues for every day a loan is overdue, counted from the moment its due date passes.";
const STRICTLY_AFTER = "A loan is overdue only when the current time is strictly after its due date.";

/**
 * A recorded vision of the shape the defect was observed in: the question on the fine (A3) and an
 * assumption on when a loan is overdue (A8) that the client's answer on the fine contradicts, A8
 * underpinning the borrowing block (G2) and A3 the fine report (G1).
 */
const VISION: StoredVision = {
  projectId: PROJECT,
  version: 4,
  visionText: TENDER,
  summary: "A lending library.",
  scopeBoundaries: [],
  inferences: [
    { key: "A3", statement: FINE, rationale: "intake", status: "Inferred", kind: "client-visible", disclosed: "asked", underpins: ["G1"] },
    { key: "A8", statement: STRICTLY_AFTER, rationale: "intake", status: "Inferred", kind: "client-visible", disclosed: "reported", underpins: ["G2"] },
  ],
  openQuestions: [{ messageId: "q-fines", text: "When does a fine start?", assumptionKey: "A3" }],
  contractForm: "guarantees",
  interface: [{ id: "I1", text: "The lending API.", source: { kind: "tender", quote: "A library lends items to members." } }],
  guarantees: [
    {
      id: "G1",
      statement: "The fine report lists the fine of every overdue loan.",
      observable: { interface: ["I1"], observation: "output" },
      refutedBy: ["An overdue loan is missing from the fine report."],
      source: { kind: "tender", quote: "Overdue loans are fined." },
    },
    {
      id: "G2",
      statement: "A member with an overdue loan cannot borrow.",
      observable: { interface: ["I1"], observation: "errors" },
      refutedBy: ["A member with an overdue loan borrows an item."],
      source: { kind: "tender", quote: "A member with an overdue loan cannot borrow." },
    },
  ],
  exclusions: [],
};

const ANSWER_BODY = "A loan due on day D is overdue from day D+1, in calendar days, Europe/Amsterdam; the fine starts that day.";
const FINE_FROM_NEXT_DAY = "A fine accrues for every calendar day (Europe/Amsterdam) a loan is overdue, from the day after its due date.";
const OVERDUE_FROM_NEXT_DAY = "A loan due on day D is overdue from the start of day D+1, in calendar days, Europe/Amsterdam.";

/** The reconciliation the model returned for the answer: it changes A3, its question's, and contradicts A8. */
const RECORDED_READING = {
  verdict: "changes",
  statement: FINE_FROM_NEXT_DAY,
  kind: "client-visible",
  amends: [{ op: "amend-assumption", id: "A8", statement: OVERDUE_FROM_NEXT_DAY, direction: "neutral" }],
};

/** A model answering every answer reading with `reading`, validated as a provider validates it; counts its calls. */
function model(reading: unknown): { readonly llm: ContextualLlm; readonly calls: () => number } {
  let calls = 0;
  const llm: ContextualLlm = {
    forCall: () => ({
      generateStructured: async (request) => {
        calls++;
        const parsed = request.schema.safeParse({ reading });
        if (!parsed.success) throw new SchemaValidationError([z.prettifyError(parsed.error)], "stub-model");
        return { data: parsed.data, model: "stub-model", provider: "stub", grade: "Strong" };
      },
    }),
  };
  return { llm, calls: () => calls };
}

function recordingStore(intakeAttempts: number) {
  const answer = {
    id: "answer-1",
    projectId: PROJECT,
    body: ANSWER_BODY,
    questionId: "q-fines",
    intakeAttempts,
    intakeLastError: null,
    intakeLastFailure: null,
    planned: true,
    vision: VISION,
    paused: false,
  };
  const writes: Parameters<AnswerStore["recordAnswer"]>[0][] = [];
  const failures: string[] = [];
  const blocked: string[] = [];
  const store: AnswerStore = {
    openAnswers: async () => [answer],
    openAnswer: async () => answer,
    recordAnswer: async (write) => {
      writes.push(write);
      return { kind: "recorded" };
    },
    recordFailedAttempt: async (_id, error) => {
      failures.push(error);
      return intakeAttempts + failures.length;
    },
    blockProject: async (projectId) => {
      blocked.push(projectId);
      return "blocked";
    },
  };
  return { store, writes, failures, blocked };
}

describe("a client's answer is reconciled with every record it contradicts, in one revision", () => {
  test("an answer that contradicts its question's assumption and another one amends both in one client-change revision", async () => {
    const { store, writes } = recordingStore(0);
    const outcomes = await new ClientAnswers({ llm: model(RECORDED_READING).llm, store, containment: memoryStepContainment(() => false) }).runPending();

    expect(outcomes).toMatchObject([{ kind: "stated", assumptionKey: "A3", verdict: "changes", visionVersion: 5, replanRequested: true }]);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    const revision = write?.vision?.revision;
    expect(revision?.cause).toBe("client-change");
    expect(revision?.ops.map((op) => [op.target, op.action, op.key, op.statement])).toEqual([
      ["assumption", "amend", "A3", FINE_FROM_NEXT_DAY],
      ["assumption", "amend", "A8", OVERDUE_FROM_NEXT_DAY],
    ]);

    const append = write?.vision?.append;
    if (append === undefined) throw new Error("the answer appended no vision version");
    const next = readVisionVersion({ ...VISION, version: 5, inferences: append.inferences, openQuestions: append.openQuestions });
    expect(next.assumptions.map((a) => [a.id, a.statement, a.status, a.clientAnswer?.messageId])).toEqual([
      ["A3", FINE_FROM_NEXT_DAY, "Stated", "answer-1"],
      ["A8", OVERDUE_FROM_NEXT_DAY, "Stated", "answer-1"],
    ]);
    expect(next.openQuestions).toEqual([]);
    expect(write?.replanReport).toContain(`The plan assumed: ${FINE}`);
    expect(write?.replanReport).toContain(`The plan assumed: ${STRICTLY_AFTER}`);
    expect(write?.replanReport).toContain(`Work now proceeds on: ${OVERDUE_FROM_NEXT_DAY}`);
  });

  test("a guarantee the answer contradicts is restated whole in the same revision", async () => {
    const amendG2 = {
      op: "amend-guarantee",
      id: "G2",
      statement: "A member with a loan overdue since a previous calendar day cannot borrow.",
      interface: ["I1"],
      observation: "errors",
      refutedBy: ["A member with an overdue loan borrows an item.", "A member is refused on the due day itself."],
      direction: "widens",
    };
    const { store, writes } = recordingStore(0);
    await new ClientAnswers({
      llm: model({ ...RECORDED_READING, amends: [...RECORDED_READING.amends, amendG2] }).llm,
      store,
      containment: memoryStepContainment(() => false),
    }).runPending();

    const [write] = writes;
    expect(write?.vision?.revision.ops.map((op) => [op.target, op.key])).toEqual([
      ["assumption", "A3"],
      ["assumption", "A8"],
      ["guarantee", "G2"],
    ]);
    expect(write?.vision?.revision.direction).toBe("widens");
    const contract = write?.vision?.append.contract;
    expect(contract?.kind === "revised" ? contract.records.guarantees.find((g) => g.id === "G2")?.statement : null).toBe(amendG2.statement);
  });

  test("a reading that does not reconcile the answer with the other records is retried, then held: nothing is written and the project is blocked", async () => {
    const { amends: _omitted, ...unreconciled } = RECORDED_READING;
    const { store, writes, failures, blocked } = recordingStore(2);
    const { llm, calls } = model(unreconciled);
    const outcomes = await new ClientAnswers({ llm, store, containment: memoryStepContainment(() => false) }).runPending();

    expect(calls()).toBeGreaterThan(1);
    expect(writes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(blocked).toEqual([PROJECT]);
    expect(outcomes).toMatchObject([{ kind: "project-blocked", answerId: "answer-1" }]);
  });

  test("a reconciliation naming a record the vision does not hold is retried and never applied in part", async () => {
    const { store, writes, failures } = recordingStore(0);
    const { llm, calls } = model({ ...RECORDED_READING, amends: [...RECORDED_READING.amends, { op: "amend-assumption", id: "A99", statement: "Unknown.", direction: "neutral" }] });
    const outcomes = await new ClientAnswers({ llm, store, containment: memoryStepContainment(() => false) }).runPending();

    expect(calls()).toBeGreaterThan(1);
    expect(writes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("A99");
    expect(outcomes).toMatchObject([{ kind: "failed", attempt: 1 }]);
  });
});
