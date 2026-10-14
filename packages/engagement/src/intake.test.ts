import { describe, expect, test, vi } from "vitest";
import { SchemaValidationError } from "@ashara/llm-gateway";
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
      projectId: parseProjectId("00000000-0000-4000-8000-000000000001", "test"),
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
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };

    const [outcome] = await new TenderIntake({ llm, store }).runPending();

    expect(outcome?.kind).toBe("failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain('non-Error thrown: {"reason":"provider exploded","self":"[circular]"}');
  });

  test("a model that never validates is asked 2 times per tier on 2 tiers before the tender attempt fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const capabilities: string[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          capabilities.push(request.capability);
          throw new SchemaValidationError(["scripted failure"], null);
        },
      }),
    };
    const store: IntakeStore = {
      openTenders: async () => [
        {
          id: "tender-ladder",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000004", "test"),
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
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };

    const [outcome] = await new TenderIntake({ llm, store }).runPending();

    expect(outcome?.kind).toBe("failed");
    expect(capabilities).toEqual(["Strong", "Strong", "Frontier", "Frontier"]);
  });
});

describe("TenderIntake per-project failure", () => {
  test("a tender at its cap with no recorded error blocks its project and the next tender is still taken in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lying = {
      id: "tender-lying",
      projectId: parseProjectId("00000000-0000-4000-8000-000000000002", "test"),
      body: "A booking page.",
      intakeAttempts: 3,
      intakeLastError: null,
    };
    const next = { ...lying, id: "tender-next", projectId: parseProjectId("00000000-0000-4000-8000-000000000003", "test"), intakeAttempts: 0 };
    const blocked: Array<{ projectId: string; category: string; errorClass: string; reason: string }> = [];
    const store: IntakeStore = {
      openTenders: async () => [lying, next],
      currentVisionVersion: async (projectId) => (projectId === next.projectId ? 1 : null),
      recordIntake: async () => {
        throw new Error("recordIntake must not be reached");
      },
      consumeTender: async () => {},
      recordFailedAttempt: async () => {
        throw new Error("recordFailedAttempt must not be reached");
      },
      closeFailedTender: async () => {
        throw new Error("closeFailedTender must not be reached");
      },
      blockProject: async (projectId, cause) => {
        blocked.push({ projectId, ...cause });
        return "blocked";
      },
    };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw new Error("no call expected");
        },
      }),
    };

    const outcomes = await new TenderIntake({ llm, store }).runPending();

    expect(outcomes.map((o) => `${o.tenderId}:${o.kind}`)).toEqual(["tender-lying:project-blocked", "tender-next:vision-exists"]);
    expect(blocked).toEqual([
      { projectId: lying.projectId, category: "fault", errorClass: "IntakeFailureUnrecorded", reason: expect.stringMatching(/^IntakeFailureUnrecorded: /) },
    ]);
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
    const assumption = { statement: "The larger studio.", rationale: "The tender names it first.", kind: "client-visible" };
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
          projectId: parseProjectId("00000000-0000-4000-8000-000000000002", "test"),
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
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
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
          assumption: { statement: "Until you answer, we build one standalone executable.", rationale: "No installer.", kind: "client-visible" },
        },
        {
          text: "Which encoding?",
          whyItMatters: "Names must read correctly.",
          assumption: { statement: `${LABEL} the files are UTF-8.`, rationale: "The common default.", kind: "client-visible" },
        },
      ],
      assumptions: [{ statement: "Until you answered nothing changes.", rationale: "Kept as written.", kind: "internal-design" }],
    };
    const llm: ContextualLlm = {
      forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse(raw) }) }),
    };
    const writes: Parameters<IntakeStore["recordIntake"]>[0][] = [];
    const store: IntakeStore = {
      openTenders: async () => [
        {
          id: "tender-3",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000003", "test"),
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
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
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
      assumptions: [{ statement, rationale: "None given.", kind: "client-visible" }],
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
          projectId: parseProjectId("00000000-0000-4000-8000-000000000004", "test"),
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
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };

    await new TenderIntake({ llm, store }).runPending();

    expect(verdicts[0]).toBe(false);
  });
});

describe("TenderIntake assumptions report (ADR-074 addendum 2 d89 C)", () => {
  const raw = (assumptions: readonly Record<string, unknown>[]) => ({
    summary: "A key-value store.",
    scopeBoundaries: ["In: put, get, list"],
    questions: [
      {
        text: "May values hold spaces?",
        whyItMatters: "It decides how a value is read.",
        assumption: { statement: "Values are one word.", rationale: "The tender's examples.", kind: "client-visible" },
      },
    ],
    assumptions,
  });

  function storeOf(id: string, recordIntake: IntakeStore["recordIntake"]): IntakeStore {
    return {
      openTenders: async () => [
        { id, projectId: parseProjectId("00000000-0000-4000-8000-000000000005", "test"), body: "A store.", intakeAttempts: 0, intakeLastError: null },
      ],
      currentVisionVersion: async () => null,
      recordIntake,
      consumeTender: async () => {},
      recordFailedAttempt: async () => 1,
      closeFailedTender: async () => {},
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };
  }

  async function intakeOf(response: unknown) {
    const llm: ContextualLlm = {
      forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse(response) }) }),
    };
    const writes: Parameters<IntakeStore["recordIntake"]>[0][] = [];
    const store = storeOf("tender-r", async (write) => {
      writes.push(write);
      return { kind: "recorded", questionIds: write.questions.map((_, i) => `q${i}`) };
    });
    await new TenderIntake({ llm, store }).runPending();
    const [write, ...more] = writes;
    if (write === undefined || more.length > 0) throw new Error(`expected one intake write, got ${writes.length}`);
    return write;
  }

  test("one report lists the unasked assumptions, behaviour apart from design, and none a question carries", async () => {
    const write = await intakeOf(
      raw([
        { statement: "list prints keys sorted.", rationale: "Predictable output.", kind: "client-visible" },
        { statement: "The log file is wal.log.", rationale: "A plain name.", kind: "internal-design" },
      ]),
    );
    const report = write.assumptionsReport ?? "";
    expect(report).toContain("we proceed on them unless you object");
    expect(report).toContain("What the product will do:\n- A2: list prints keys sorted.");
    expect(report).toContain("How we will build it");
    expect(report).toContain("- A3: The log file is wal.log.");
    expect(report).not.toContain("Values are one word.");
    expect(write.vision(["q0"]).inferences.map((a) => [a.key, a.kind, a.disclosed])).toEqual([
      ["A1", "client-visible", "asked"],
      ["A2", "client-visible", "reported"],
      ["A3", "internal-design", "reported"],
    ]);
  });

  test("no report when every assumption is a question's", async () => {
    expect((await intakeOf(raw([]))).assumptionsReport).toBeNull();
  });

  test("an assumption with no kind is rejected, never stored unclassified", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(request.schema.safeParse(raw([{ statement: "Sorted.", rationale: "Predictable." }])).success);
          throw new Error("stop after the schema check");
        },
      }),
    };
    const store = storeOf("tender-k", async () => {
      throw new Error("recordIntake must not be reached");
    });
    await new TenderIntake({ llm, store }).runPending();
    expect(verdicts[0]).toBe(false);
  });
});
