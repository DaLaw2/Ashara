import { describe, expect, test, vi } from "vitest";
import { BudgetExceeded, PreCallRefusal, ProviderError } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
import { SchemaValidationError } from "@ashara/finance";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { TenderIntake } from "./intake.js";
import type { IntakeStore } from "./intake.js";
import { ASSUMPTION_KIND_RULE } from "./vision-language/vision-assumption.js";

describe("TenderIntake failure accounting", () => {
  test("an error nothing names, a thrown circular non-Error, is Ashara's: recorded on the tender with a backoff, never counted against it", async () => {
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
      recordFailedAttempt: async () => {
        throw new Error("recordFailedAttempt must not be reached: the client's tender is not at fault");
      },
      closeFailedTender: async () => {},
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };
    const containment = memoryStepContainment(() => false);

    const [outcome] = await new TenderIntake({ containment, llm, store }).runPending();

    expect(outcome).toMatchObject({ kind: "step-faulted", step: "liaison-intake", subjectId: "tender-1", faults: 1, retryAfterSeconds: 60 });
    expect(containment.recorded.get("liaison-intake/tender-1")).toMatchObject({
      faults: 1,
      error: expect.stringContaining('non-Error thrown: {"reason":"provider exploded","self":"[circular]"}'),
    });
    // Waiting out its backoff, the tender is not read again on the next cycle.
    expect(await new TenderIntake({ containment, llm, store }).runPending()).toEqual([]);
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

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

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

    const outcomes = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcomes.map((o) => `${o.kind === "step-faulted" ? o.subjectId : o.tenderId}:${o.kind}`)).toEqual(["tender-lying:project-blocked", "tender-next:vision-exists"]);
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
      inScope: ["booking"],
      outOfScope: [],
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

    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(verdicts.slice(0, 2)).toEqual([false, true]);
  });
});

describe("TenderIntake assumption label", () => {
  const LABEL = "Until you answer, we proceed on this assumption:";

  test("a statement that repeats the label's lead-in is posted and recorded once, without it", async () => {
    const raw = {
      summary: "A command-line tool.",
      inScope: ["merging the exports"],
      outOfScope: [],
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
      forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse(raw), model: "stub-model", provider: "stub" }) }),
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

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

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
      inScope: ["a tool"],
      outOfScope: [],
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

    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(verdicts[0]).toBe(false);
  });
});

describe("TenderIntake assumptions report (ADR-074 addendum 2 d89 C)", () => {
  const raw = (assumptions: readonly Record<string, unknown>[]) => ({
    summary: "A key-value store.",
    inScope: ["put, get, list"],
    outOfScope: [],
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
      forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse(response), model: "stub-model", provider: "stub" }) }),
    };
    const writes: Parameters<IntakeStore["recordIntake"]>[0][] = [];
    const store = storeOf("tender-r", async (write) => {
      writes.push(write);
      return { kind: "recorded", questionIds: write.questions.map((_, i) => `q${i}`) };
    });
    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();
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

  // The vision records which side of the scope each line is on, so no report reads it from the wording.
  test("the vision records each scope line with its side, in scope first", async () => {
    const write = await intakeOf({ ...raw([]), inScope: ["put and get"], outOfScope: ["any network service"] });
    expect(write.vision(["q0"]).scopeBoundaries).toEqual([
      { text: "put and get", side: "in" },
      { text: "any network service", side: "out" },
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
    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();
    expect(verdicts[0]).toBe(false);
  });
});

describe("TenderIntake failure classes (t-intake-failure-classes)", () => {
  const valid = {
    summary: "A booking page.",
    inScope: ["booking"],
    outOfScope: [],
    questions: [
      {
        text: "Which studio?",
        whyItMatters: "It sets the rules.",
        assumption: { statement: "The larger studio.", rationale: "Named first.", kind: "client-visible" },
      },
    ],
    assumptions: [],
  };

  function storeWith(recordIntake: IntakeStore["recordIntake"], counted: string[], blocked: string[]): IntakeStore {
    return {
      openTenders: async () => [
        {
          id: "tender-c",
          projectId: parseProjectId("00000000-0000-4000-8000-000000000006", "test"),
          body: "A booking page.",
          intakeAttempts: 2,
          intakeLastError: "an earlier read failed",
        },
      ],
      currentVisionVersion: async () => null,
      recordIntake,
      consumeTender: async () => {
        throw new Error("consumeTender must not be reached");
      },
      recordFailedAttempt: async (_id, error) => {
        counted.push(error);
        return 3;
      },
      closeFailedTender: async () => {
        throw new Error("closeFailedTender must not be reached");
      },
      blockProject: async (_projectId, cause) => {
        blocked.push(cause.errorClass);
        return "blocked";
      },
    };
  }

  test("questions the store posts wrongly block the project after one read, never counted as a read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          reads++;
          return { data: request.schema.parse(valid), model: "stub-model", provider: "stub" };
        },
      }),
    };
    const counted: string[] = [];
    const blocked: string[] = [];
    const store = storeWith(async (write) => {
      write.vision([]);
      throw new Error("unreachable: the vision callback throws first");
    }, counted, blocked);

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcome?.kind).toBe("project-blocked");
    expect(blocked).toEqual(["QuestionIdsMismatch"]);
    expect(counted).toEqual([]);
    expect(reads).toBe(1);
  });

  test("a spend-cap refusal throws through with its class, for the core loop to halt at the cap, and counts nothing", async () => {
    const refusal = new BudgetExceeded({
      scope: { kind: "deployment" },
      provider: "stub",
      model: "stub-model",
      capUsd: 1,
      spentUsd: 1,
      inFlightUsd: 0,
      estimatedCostUsd: 0.1,
    });
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw refusal;
        },
      }),
    };
    const counted: string[] = [];
    const store = storeWith(async () => {
      throw new Error("recordIntake must not be reached");
    }, counted, []);

    const containment = memoryStepContainment((error) => error instanceof BudgetExceeded);
    await expect(new TenderIntake({ containment, llm, store }).runPending()).rejects.toBe(refusal);
    expect(containment.recorded.size).toBe(0);
    expect(counted).toEqual([]);
  });

  test("any other refusal, or a provider rejecting the request Ashara sent, is that tender's fault on Ashara's side: recorded, retried, the other tenders go on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    class ScriptedRefusal extends PreCallRefusal {}
    const thrown = [new ScriptedRefusal("unpriced model: scripted"), new ProviderError("stub", "request rejected (413)", "ashara")];
    for (const error of thrown) {
      const llm: ContextualLlm = {
        forCall: () => ({
          generateStructured: async () => {
            throw error;
          },
        }),
      };
      const counted: string[] = [];
      const store = storeWith(async () => {
        throw new Error("recordIntake must not be reached");
      }, counted, []);
      const containment = memoryStepContainment(() => false);

      const [outcome] = await new TenderIntake({ containment, llm, store }).runPending();

      expect(outcome).toMatchObject({ kind: "step-faulted", faults: 1, retryAfterSeconds: 60, error: expect.stringContaining(error.message) });
      expect(counted).toEqual([]);
    }
  });
});

// ADR-083: an assumption whose breach a client could observe gets a check, and doubt classifies
// toward one. Which kind a real model picks is not testable offline: these tests fix what Ashara
// does with each answer and what every classifying prompt tells the model, never the model's choice.
describe("TenderIntake assumption kinds fail safe (ADR-083)", () => {
  // A tender for a command-line key-value store, and assumptions an intake of it wrote, as fixture.
  const TENDER =
    "I would like a key-value store written in Rust that we can use from the command line. Keep data in a directory we " +
    "choose, using a write-ahead log. Recover after a crash: a partly written record at the end of the log should be " +
    "ignored, not treated as fatal corruption.";
  const REPLAY = "On open, the store replays all complete records in order and ignores a partial or invalid record only at the end of the log.";
  const FORMAT = "The write-ahead log stores length-prefixed records with a checksum, in append order.";

  async function intakeOf(kinds: { readonly replay: string; readonly format: string }) {
    const prompts: string[] = [];
    const response = {
      summary: "A command-line key-value store.",
      inScope: ["put, get, delete"],
      outOfScope: [],
      questions: [],
      assumptions: [
        { statement: REPLAY, rationale: "The tender asks for recovery after a crash.", kind: kinds.replay },
        { statement: FORMAT, rationale: "A common log format.", kind: kinds.format },
      ],
    };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          prompts.push(request.prompt);
          return { data: request.schema.parse(response), model: "stub-model", provider: "stub" };
        },
      }),
    };
    const writes: Parameters<IntakeStore["recordIntake"]>[0][] = [];
    const store: IntakeStore = {
      openTenders: async () => [
        { id: "tender-kv", projectId: parseProjectId("00000000-0000-4000-8000-000000000083", "test"), body: TENDER, intakeAttempts: 0, intakeLastError: null },
      ],
      currentVisionVersion: async () => null,
      recordIntake: async (write) => {
        writes.push(write);
        return { kind: "recorded", questionIds: [] };
      },
      consumeTender: async () => {},
      recordFailedAttempt: async () => 1,
      closeFailedTender: async () => {},
      blockProject: async () => {
        throw new Error("blockProject must not be reached");
      },
    };
    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();
    const [write] = writes;
    if (write === undefined) throw new Error("expected one intake write");
    return { prompt: prompts[0] ?? "", kinds: write.vision([]).inferences.map((a) => [a.statement, a.kind]) };
  }

  test("an assumption the model classes undecided is recorded client-visible", async () => {
    const { kinds } = await intakeOf({ replay: "undecided", format: "internal-design" });
    expect(kinds).toEqual([
      [REPLAY, "client-visible"],
      [FORMAT, "internal-design"],
    ]);
  });

  test("the intake prompt states the fail-safe rule and offers undecided", async () => {
    const { prompt } = await intakeOf({ replay: "client-visible", format: "internal-design" });
    for (const line of ASSUMPTION_KIND_RULE) expect(prompt).toContain(line);
    expect(prompt).toContain("in its exit status, or in the data the client stores with it");
    expect(prompt).toContain('"undecided": you cannot tell whether a client could observe a breach');
  });
});
