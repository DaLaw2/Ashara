import { describe, expect, test, vi } from "vitest";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { parseProjectId } from "@ashara/shared";
import { TenderIntake } from "./intake.js";
import type { IntakeStore } from "./intake.js";

describe("TenderIntake failure accounting", () => {
  test("a thrown circular non-Error is still counted as a failed attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = { reason: "provider exploded" };
    circular["self"] = circular;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw circular;
        },
      }),
    };
    const recorded: string[] = [];
    const tender = {
      id: "tender-1",
      projectId: parseProjectId("00000000-0000-4000-8000-000000000001"),
      body: "A booking page.",
      intakeAttempts: 0,
      intakeLastError: null,
    };
    const store: IntakeStore = {
      openTenders: async () => [tender],
      currentVisionVersion: async () => null,
      recordIntake: async () => {
        throw new Error("recordIntake must not be reached");
      },
      consumeTender: async () => {},
      recordFailedAttempt: async (_tenderId, error) => {
        recorded.push(error);
        return recorded.length;
      },
      closeFailedTender: async () => {},
    };

    const [outcome] = await new TenderIntake({ llm, store }).runPending();

    expect(outcome?.kind).toBe("failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/non-Error thrown: Object \(not serializable: .*circular/i);
  });
});

describe("TenderIntake response schema", () => {
  test("a question that does not carry the assumption adopted until it is answered is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = (question: Record<string, unknown>) => ({
      summary: "A booking page.",
      scopeBoundaries: ["In: booking"],
      questions: [question],
      assumptions: [],
    });
    const question = { text: "Which studio?", whyItMatters: "It sets the rules." };
    const assumption = { statement: "The larger studio.", rationale: "The tender names it first." };
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(
            request.schema.safeParse(response(question)).success,
            request.schema.safeParse(response({ ...question, assumption })).success,
          );
          throw new Error("stop after the schema check");
        },
      }),
    };
    const store: IntakeStore = {
      openTenders: async () => [
        {
          id: "tender-2",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000002"),
          body: "A booking page.",
          intakeAttempts: 0,
          intakeLastError: null,
        },
      ],
      currentVisionVersion: async () => null,
      recordIntake: async () => {
        throw new Error("recordIntake must not be reached");
      },
      consumeTender: async () => {},
      recordFailedAttempt: async () => 1,
      closeFailedTender: async () => {},
    };

    await new TenderIntake({ llm, store }).runPending();

    expect(verdicts.slice(0, 2)).toEqual([false, true]);
  });
});

describe("TenderIntake assumption label", () => {
  const LABEL = "Until you answer, we proceed on this assumption:";

  test("a statement that repeats the label's lead-in is posted and recorded once, without it", async () => {
    const raw = {
      summary: "A command-line tool.",
      scopeBoundaries: ["In: merging the exports"],
      questions: [
        {
          text: "Which Windows version?",
          whyItMatters: "The build must start there.",
          assumption: { statement: "Until you answer, we build one standalone executable.", rationale: "No installer." },
        },
        {
          text: "Which encoding?",
          whyItMatters: "Names must read correctly.",
          assumption: { statement: `${LABEL} the files are UTF-8.`, rationale: "The common default." },
        },
      ],
      assumptions: [{ statement: "Until you answered nothing changes.", rationale: "Kept as written." }],
    };
    const llm: ContextualLlm = {
      forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse(raw) }) }),
    };
    const writes: Parameters<IntakeStore["recordIntake"]>[0][] = [];
    const store: IntakeStore = {
      openTenders: async () => [
        {
          id: "tender-3",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000003"),
          body: "A tool.",
          intakeAttempts: 0,
          intakeLastError: null,
        },
      ],
      currentVisionVersion: async () => null,
      recordIntake: async (write) => {
        writes.push(write);
        return { kind: "recorded", questionIds: write.questions.map((_, i) => `q${i}`) };
      },
      consumeTender: async () => {},
      recordFailedAttempt: async () => 1,
      closeFailedTender: async () => {},
    };

    const [outcome] = await new TenderIntake({ llm, store }).runPending();

    expect(outcome?.kind).toBe("recorded");
    const [write] = writes;
    expect(write?.questions.map((body) => body.match(/until you answer/gi)?.length)).toEqual([1, 1]);
    expect(write?.questions[0]).toContain(`${LABEL} We build one standalone executable.`);
    expect(write?.questions[1]).toContain(`${LABEL} The files are UTF-8.`);
    expect(write?.vision(["q0", "q1"]).inferences.map((a) => a.statement)).toEqual([
      "We build one standalone executable.",
      "The files are UTF-8.",
      "Until you answered nothing changes.",
    ]);
  });

  test("a statement that is only the label is rejected, never stored empty", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = (statement: string) => ({
      summary: "A tool.",
      scopeBoundaries: ["In: a tool"],
      questions: [],
      assumptions: [{ statement, rationale: "None given." }],
    });
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(request.schema.safeParse(response(LABEL)).success);
          throw new Error("stop after the schema check");
        },
      }),
    };
    const store: IntakeStore = {
      openTenders: async () => [
        {
          id: "tender-4",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000004"),
          body: "A tool.",
          intakeAttempts: 0,
          intakeLastError: null,
        },
      ],
      currentVisionVersion: async () => null,
      recordIntake: async () => {
        throw new Error("recordIntake must not be reached");
      },
      consumeTender: async () => {},
      recordFailedAttempt: async () => 1,
      closeFailedTender: async () => {},
    };

    await new TenderIntake({ llm, store }).runPending();

    expect(verdicts[0]).toBe(false);
  });
});
