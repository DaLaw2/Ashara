import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { BudgetExceeded, PreCallRefusal, ProviderError } from "@ashara/finance";
import type { CapabilityLevel, ContextualLlm } from "@ashara/finance";
import { ROUTING_RULES, SchemaValidationError, SecondOpinionUnavailable } from "@ashara/finance";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment, notExercised } from "@ashara/shared/testing";
import { TenderIntake } from "./intake.js";
import { visionWritable } from "./vision.js";
import type { IntakeStore } from "./intake.js";
import { OBSERVATION_RULE } from "./vision-language/guarantee.js";
import { ASSUMPTION_KIND_RULE } from "./vision-language/vision-assumption.js";

type Tender = Awaited<ReturnType<IntakeStore["openTenders"]>>[number];
type Write = Parameters<IntakeStore["recordIntake"]>[0];
type Sent = Parameters<ReturnType<ContextualLlm["forCall"]>["generateStructured"]>[0];
type ProjectBlockCause = Parameters<IntakeStore["blockProject"]>[1];

function tenderOf(id: string, body: string, project: number, attempts = 0, lastError: string | null = null): Tender {
  return {
    id,
    projectId: parseProjectId(`00000000-0000-4000-8000-${String(project).padStart(12, "0")}`, "test"),
    body,
    intakeAttempts: attempts,
    intakeLastError: lastError,
  };
}

/** A store over `tenders` whose every write throws unless the test gives it. */
function storeOf(tenders: readonly Tender[], given: Partial<IntakeStore> = {}): IntakeStore {
  return {
    openTenders: async () => tenders,
    currentVisionVersion: async () => null,
    recordIntake: notExercised("recordIntake"),
    consumeTender: notExercised("consumeTender"),
    recordFailedAttempt: notExercised("recordFailedAttempt"),
    blockProject: notExercised("blockProject"),
    ...given,
  };
}

/** A store that records the one intake write it is given. */
function recordingStore(tender: Tender): { readonly store: IntakeStore; readonly writes: Write[] } {
  const writes: Write[] = [];
  const store = storeOf([tender], {
    recordIntake: async (write) => {
      writes.push(write);
      return { kind: "recorded", questionIds: write.questions.map((_, i) => `q${i}`) };
    },
  });
  return { store, writes };
}

/**
 * A model that answers the n-th first reading with `reply(n)`, and a second reading, from another
 * family, with no question; each answer validated as a provider validates it, a reply the schema
 * refuses a SchemaValidationError.
 */
function answering(reply: (call: number) => unknown, prompts: string[] = []): ContextualLlm {
  let call = 0;
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        prompts.push(request.prompt);
        const second = request.secondOpinion !== undefined;
        const parsed = request.schema.safeParse(second ? { questions: [] } : reply(call++));
        if (!parsed.success) throw new SchemaValidationError([z.prettifyError(parsed.error)], "stub-model");
        return { data: parsed.data, model: second ? "other-model" : "stub-model", provider: second ? "other" : "stub", grade: "Strong" };
      },
    }),
  };
}

const RATIONALE = "The tender implies it.";

/** How every message posted for a contract Ashara declines begins its decline. */
const DECLINE = "Ashara cannot verify any guarantee of this contract as written";
/** What no message posted while a contract is declined may say: each claims work under way or not waiting. */
const UNDER_WAY = ["Work does not wait", "work proceeds", "Work proceeds", "Work has started", "nothing waits"];

/** An assumption as a first reading drafts it. */
function drafted(id: string, statement: string, kind: string, underpins: readonly string[] = ["G1"]) {
  return { id, statement, rationale: RATIONALE, kind, underpins };
}

/** The contract a first reading of `tender` drafts: one interface entry and one guarantee, each quoting it. */
function contractOf(tender: string) {
  const source = { kind: "tender", quote: tender };
  return {
    interface: [{ id: "I1", text: "The page a visitor uses.", source }],
    guarantees: [
      { id: "G1", statement: "A visitor gets what the tender asks for.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["The page does not do it."], source },
    ],
    exclusions: [],
  };
}

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
    const store = storeOf([tenderOf("tender-1", "A booking page.", 1)]);
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
          capabilities.push(String(request.capability));
          throw new SchemaValidationError(["scripted failure"], null);
        },
      }),
    };
    const store = storeOf([tenderOf("tender-ladder", "A booking page.", 4)], { recordFailedAttempt: async () => 1 });

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcome?.kind).toBe("failed");
    expect(capabilities).toEqual(["Strong", "Strong", "Frontier", "Frontier"]);
  });
});

// A tender is never refused: one no read of which succeeds blocks its project on Ashara's side and
// stays unconsumed, so the operator's unblock has it read again.
describe("TenderIntake that cannot read a tender", () => {
  test("three failed reads block the project and leave the tender unconsumed at its count, which the halt's end sets back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw new SchemaValidationError(["scripted failure"], null);
        },
      }),
    };
    let tender = tenderOf("tender-unread", "A booking page.", 7);
    const consumed: string[] = [];
    const blocked: Array<{ readonly projectId: string; readonly cause: ProjectBlockCause }> = [];
    let projectBlocked = false;
    const store = storeOf([], {
      openTenders: async () => (projectBlocked ? [] : [tender]),
      consumeTender: async ({ id }) => {
        consumed.push(id);
        return { kind: "consumed" };
      },
      recordFailedAttempt: async (_id, error) => {
        tender = { ...tender, intakeAttempts: tender.intakeAttempts + 1, intakeLastError: error };
        return tender.intakeAttempts;
      },
      blockProject: async (projectId, cause) => {
        blocked.push({ projectId, cause });
        projectBlocked = true;
        return "blocked";
      },
    });
    const intake = new TenderIntake({ containment: memoryStepContainment(() => false), llm, store });

    const outcomes = [...(await intake.runPending()), ...(await intake.runPending()), ...(await intake.runPending())];

    expect(outcomes.map((o) => o.kind)).toEqual(["failed", "failed", "project-blocked"]);
    expect(blocked).toEqual([
      {
        projectId: tender.projectId,
        cause: { category: "model_failed", errorClass: "IntakeReadExhausted", reason: expect.stringMatching(/^IntakeReadExhausted: tender tender-unread could not be read after 3 attempts/) },
      },
    ]);
    expect(consumed).toEqual([]);
    expect(tender).toMatchObject({ intakeAttempts: 3, intakeLastError: expect.stringContaining("scripted failure") });
    // The blocked project's tender is not taken in; the halt's end sets its count back, and it is read again from no attempts.
    expect(await intake.runPending()).toEqual([]);
    projectBlocked = false;
    tender = { ...tender, intakeAttempts: 0 };
    expect((await intake.runPending()).map((o) => o.kind)).toEqual(["failed"]);
  });

  test("a tender a previous cycle left at its cap blocks the project as Ashara's to look into, never consumed or read again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const causes: ProjectBlockCause[] = [];
    const store = storeOf([tenderOf("tender-capped", "A booking page.", 8, 3, "an earlier read failed")], {
      blockProject: async (_projectId, cause) => {
        causes.push(cause);
        return "blocked";
      },
    });
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw new Error("no read expected");
        },
      }),
    };

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcome?.kind).toBe("project-blocked");
    expect(causes).toEqual([{ category: "fault", errorClass: "IntakeReadExhausted", reason: expect.stringContaining("last error: an earlier read failed") }]);
  });
});

describe("TenderIntake per-project failure", () => {
  test("a tender at its cap with no recorded error blocks its project and the next tender is still taken in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lying = tenderOf("tender-lying", "A booking page.", 2, 3);
    const next = tenderOf("tender-next", "A booking page.", 3);
    const blocked: Array<{ projectId: string; category: string; errorClass: string; reason: string }> = [];
    const store = storeOf([lying, next], {
      currentVisionVersion: async (projectId) => (projectId === next.projectId ? 1 : null),
      consumeTender: async () => ({ kind: "consumed" }),
      blockProject: async (projectId, cause) => {
        blocked.push({ projectId, ...cause });
        return "blocked";
      },
    });
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
  const TENDER = "A booking page.";
  const response = (question: Record<string, unknown>) => ({ summary: TENDER, ...contractOf(TENDER), questions: [question], assumptions: [] });

  test("a question that does not carry the assumption adopted until it is answered is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const question = { text: "Which studio?", whyItMatters: "It sets the rules." };
    const assumption = drafted("A1", "The larger studio.", "client-visible");
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(request.schema.safeParse(response(question)).success, request.schema.safeParse(response({ ...question, assumption })).success);
          throw new Error("stop after the schema check");
        },
      }),
    };

    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store: storeOf([tenderOf("tender-2", TENDER, 2)]) }).runPending();

    expect(verdicts.slice(0, 2)).toEqual([false, true]);
  });

  // A reply the vision would refuse is asked again with why, never accepted: a guarantee
  // nothing could show broken, a quote the client never wrote, an assumption a client could observe that
  // underpins nothing.
  test.each([
    {
      name: "a guarantee without refutedBy",
      broken: (valid: ReturnType<typeof contractOf>) => ({ ...valid, guarantees: valid.guarantees.map(({ refutedBy: _refutedBy, ...g }) => g) }),
      error: "refutedBy",
    },
    {
      name: "a guarantee quoting words the tender does not contain",
      broken: (valid: ReturnType<typeof contractOf>) => ({ ...valid, guarantees: valid.guarantees.map((g) => ({ ...g, source: { kind: "tender", quote: "A payment page." } })) }),
      error: 'quotes "A payment page.", which the tender does not contain',
    },
  ])("a scripted reply with $name is re-asked, never accepted", async ({ broken, error }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = { summary: TENDER, ...contractOf(TENDER), questions: [], assumptions: [drafted("A1", "Classes are shown by day.", "client-visible")] };
    const prompts: string[] = [];
    const llm = answering((call) => (call === 0 ? { ...valid, ...broken(contractOf(TENDER)) } : valid), prompts);
    const { store, writes } = recordingStore(tenderOf("tender-reask", TENDER, 9));

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcome?.kind).toBe("recorded");
    expect(prompts[1]).toContain("Your previous response was REJECTED");
    expect(prompts[1]).toContain(error);
    expect(writes[0]?.vision([]).contract.guarantees.map((g) => g.refutedBy)).toEqual([["The page does not do it."]]);
  });

  test("a client-visible assumption that underpins no guarantee and no exclusion cites is re-asked, never accepted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply = (underpins: readonly string[]) => ({ summary: TENDER, ...contractOf(TENDER), questions: [], assumptions: [drafted("A1", "Classes are shown by day.", "client-visible", underpins)] });
    const prompts: string[] = [];
    const llm = answering((call) => reply(call === 0 ? [] : ["G1"]), prompts);
    const { store, writes } = recordingStore(tenderOf("tender-underpins", TENDER, 10));

    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(prompts[1]).toContain("client-visible assumption A1 underpins no guarantee and no exclusion cites it");
    expect(writes[0]?.vision([]).inferences.map((a) => a.underpins)).toEqual([["G1"]]);
  });
});

describe("TenderIntake assumption label", () => {
  const LABEL = "Until you answer, we proceed on this assumption:";

  test("a statement that repeats the label's lead-in is posted and recorded once, without it", async () => {
    const raw = {
      summary: "A command-line tool.",
      ...contractOf("A tool."),
      questions: [
        {
          text: "Which Windows version?",
          whyItMatters: "The build must start there.",
          assumption: drafted("A1", "Until you answer, we build one standalone executable.", "client-visible"),
        },
        {
          text: "Which encoding?",
          whyItMatters: "Names must read correctly.",
          assumption: drafted("A2", `${LABEL} the files are UTF-8.`, "client-visible"),
        },
      ],
      assumptions: [drafted("A3", "Until you answered nothing changes.", "internal-design", [])],
    };
    const { store, writes } = recordingStore(tenderOf("tender-3", "A tool.", 3));

    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm: answering(() => raw), store }).runPending();

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
    const response = (statement: string) => ({ summary: "A tool.", ...contractOf("A tool."), questions: [], assumptions: [drafted("A1", statement, "client-visible")] });
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(request.schema.safeParse(response(LABEL)).success);
          throw new Error("stop after the schema check");
        },
      }),
    };

    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store: storeOf([tenderOf("tender-4", "A tool.", 4)]) }).runPending();

    expect(verdicts[0]).toBe(false);
  });
});

// One contract draft goes out with vision v1: the interface, every guarantee with its basis, the
// assumptions each names the guarantees it underpins, the exclusions and the Basis of Design.
describe("TenderIntake contract draft", () => {
  const TENDER = "A key-value store with put, get and list. It needs no network service.";
  const source = (quote: string) => ({ kind: "tender", quote });
  const reply = {
    summary: "A key-value store.",
    interface: [
      { id: "I1", text: "put KEY VALUE stores the value.", source: source("put") },
      { id: "I2", text: "list prints every key, one per line.", source: { kind: "assumption", id: "A3" } },
    ],
    guarantees: [
      { id: "G1", statement: "get prints the value put stored.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["get prints another value."], source: source("put, get") },
      { id: "G2", statement: "list prints the keys sorted.", observable: { interface: ["I2"], observation: "undecided" }, refutedBy: ["list prints keys out of order."], source: source("list") },
      { id: "G3", statement: "A value may hold spaces.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["A spaced value is cut."], source: { kind: "assumption", id: "A1" } },
    ],
    questions: [
      {
        text: "May values hold spaces?",
        whyItMatters: "It decides how a value is read.",
        assumption: drafted("A1", "Values may hold spaces.", "client-visible", ["G3"]),
      },
    ],
    assumptions: [
      drafted("A2", "list prints keys sorted.", "client-visible", ["G2"]),
      drafted("A3", "The commands are put, get and list.", "client-visible", ["G1"]),
      drafted("A4", "The log file is wal.log.", "internal-design", []),
      drafted("A5", "Keys are case-sensitive.", "client-visible", []),
    ],
    exclusions: [
      { id: "X1", text: "Any network service.", source: source("It needs no network service.") },
      { id: "X2", text: "Case-insensitive keys.", source: { kind: "assumption", id: "A5" } },
    ],
  };

  async function intakeOf(response: unknown) {
    const { store, writes } = recordingStore(tenderOf("tender-r", TENDER, 5));
    await new TenderIntake({ containment: memoryStepContainment(() => false), llm: answering(() => response), store }).runPending();
    const [write, ...more] = writes;
    if (write === undefined || more.length > 0) throw new Error(`expected one intake write, got ${writes.length}`);
    return write;
  }

  test("the contract draft lists every guarantee with its basis, at risk until the assumption it rests on is confirmed", async () => {
    const draft = (await intakeOf(reply)).contractDraft;
    expect(draft).toContain("- G1: get prints the value put stored. (basis: an assumption you have not confirmed; at risk until you confirm A3)");
    // Its undecided observation is kept undecided, never stored-data and never marked not verifiable: the client is told
    // before work starts that Ashara does not count it, and asked where they would see it.
    expect(draft).toContain(
      "- G2: list prints the keys sorted. (basis: an assumption you have not confirmed; at risk until you confirm A2; " +
        "Ashara could not tell where you would see it hold or break, so it does not count it as one it can verify and it cannot be shown to hold; " +
        "tell us where you would see it and Ashara can check it)",
    );
    expect(draft).not.toMatch(/- G2: [^\n]*not verifiable by Ashara/);
    expect(draft).toContain("Ashara can verify 2 of the 3 guarantees of this contract with the checks it can run today.");
    expect(draft).not.toMatch(/- G[13]: [^\n]*not verifiable by Ashara/);
    expect(draft).toContain("- G3: A value may hold spaces. (basis: an assumption you have not confirmed; at risk until you confirm A1)");
    for (const g of reply.guarantees) expect(draft).toContain(`- ${g.id}: ${g.statement} (basis: `);
    expect(draft).toContain("- I1: put KEY VALUE stores the value.\n- I2: list prints every key, one per line.");
    expect(draft).toContain("- A1: Values may hold spaces. (underpins G3; asked in a question)");
    expect(draft).toContain("- A5: Keys are case-sensitive. (the ground of exclusion X2)");
    expect(draft).toContain("- X1: Any network service.\n- X2: Case-insensitive keys.");
    expect(draft).toContain("Basis of Design, our own design choices, which your acceptance does not depend on:\n- A4: The log file is wal.log.");
    expect(draft).toContain("Work has started on this list; correct any line at any time; nothing waits for your reply.");
    expect(draft).not.toContain("Ashara cannot verify any guarantee");
  });

  test("a contract Ashara can verify no guarantee of is declined: the draft and every question say so, and none reads as work under way", async () => {
    const unverifiable = { ...reply, guarantees: reply.guarantees.map((g) => ({ ...g, observable: { ...g.observable, observation: g.id === "G1" ? "stored-data" : "undecided" } })) };
    const write = await intakeOf(unverifiable);
    expect(write.contractDraft).toMatch(/^This is the contract drafted from your tender, and Ashara declines it as written\. Ashara cannot verify any guarantee of this contract as written/);
    expect(write.contractDraft).toContain("Ashara can verify 0 of the 3 guarantees of this contract with the checks it can run today.");
    expect(write.contractDraft).toContain("confirming it as written does not start it.");
    expect(write.questions).toHaveLength(1);
    for (const message of [write.contractDraft, ...write.questions]) {
      expect(message).toContain(DECLINE);
      for (const proceeds of UNDER_WAY) expect(message).not.toContain(proceeds);
    }
  });

  test("a guarantee resting on no assumption reads as what the tender states", async () => {
    const draft = (await intakeOf({ summary: "A key-value store.", ...contractOf(TENDER), questions: [], assumptions: [] })).contractDraft;
    expect(draft).toContain("- G1: A visitor gets what the tender asks for. (basis: what your tender states)");
    expect(draft).toContain("What is left out: nothing is excluded on record.");
  });

  test("vision v1 records the contract as drafted, an undecided observation kept as given and marked undecided, never stored-data, and every assumption under its own key", async () => {
    const vision = (await intakeOf(reply)).vision(["q0"]);
    const written = visionWritable("p", { visionText: vision.visionText, scopeBoundaries: [], inferences: vision.inferences, openQuestions: [], contract: { form: "guarantees", ...vision.contract } }, "first");
    expect(written.guarantees.map((g) => [g.id, g.observable.observation, g.verification])).toEqual([
      ["G1", "output", "by-ashara"],
      ["G2", "undecided", "undecided"],
      ["G3", "output", "by-ashara"],
    ]);
    expect(vision.contract.interface.map((entry) => entry.id)).toEqual(["I1", "I2"]);
    // The drafter's classification reaches the writer as given; the writer records the doubt.
    expect(vision.contract.guarantees.map((g) => [g.id, g.observable.observation])).toEqual([
      ["G1", "output"],
      ["G2", "undecided"],
      ["G3", "output"],
    ]);
    expect(vision.contract.exclusions.map((x) => x.id)).toEqual(["X1", "X2"]);
    expect(vision.inferences.map((a) => [a.key, a.kind, a.disclosed, a.underpins])).toEqual([
      ["A1", "client-visible", "asked", ["G3"]],
      ["A2", "client-visible", "reported", ["G2"]],
      ["A3", "client-visible", "reported", ["G1"]],
      ["A4", "internal-design", "reported", []],
      ["A5", "client-visible", "reported", []],
    ]);
    expect(vision.openQuestions).toEqual([{ messageId: "q0", text: "May values hold spaces?", whyItMatters: "It decides how a value is read.", assumptionKey: "A1" }]);
  });

  test("an assumption with no kind is rejected, never stored unclassified", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdicts: boolean[] = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          verdicts.push(request.schema.safeParse({ ...reply, assumptions: [{ id: "A2", statement: "Sorted.", rationale: "Predictable.", underpins: ["G2"] }] }).success);
          throw new Error("stop after the schema check");
        },
      }),
    };
    await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store: storeOf([tenderOf("tender-k", TENDER, 5)]) }).runPending();
    expect(verdicts[0]).toBe(false);
  });
});

describe("TenderIntake failure classes", () => {
  const valid = {
    summary: "A booking page.",
    ...contractOf("A booking page."),
    questions: [{ text: "Which studio?", whyItMatters: "It sets the rules.", assumption: drafted("A1", "The larger studio.", "client-visible") }],
    assumptions: [],
  };

  function storeWith(recordIntake: IntakeStore["recordIntake"], counted: string[], blocked: string[]): IntakeStore {
    return storeOf([tenderOf("tender-c", "A booking page.", 6, 2, "an earlier read failed")], {
      recordIntake,
      recordFailedAttempt: async (_id, error) => {
        counted.push(error);
        return 3;
      },
      blockProject: async (_projectId, cause) => {
        blocked.push(cause.errorClass);
        return "blocked";
      },
    });
  }

  test("questions the store posts wrongly block the project after one read, never counted as a read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    const llm = answering(() => {
      reads++;
      return valid;
    });
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

// An assumption whose breach a client could observe gets a check, and doubt classifies
// toward one. Which kind a real model picks is not testable offline: these tests fix what Ashara
// does with each answer and what every classifying prompt tells the model, never the model's choice.
describe("TenderIntake assumption kinds fail safe", () => {
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
      ...contractOf(TENDER),
      questions: [],
      assumptions: [drafted("A1", REPLAY, kinds.replay), drafted("A2", FORMAT, kinds.format, [])],
    };
    // The reading asks nothing, so another family's second reading confirms it.
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          prompts.push(request.prompt);
          if (request.secondOpinion !== undefined) return { data: request.schema.parse({ questions: [] }), model: "other-model", provider: "other", grade: "Strong" };
          return { data: request.schema.parse(response), model: "stub-model", provider: "stub", grade: "Strong" };
        },
      }),
    };
    const { store, writes } = recordingStore(tenderOf("tender-kv", TENDER, 83));
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
    // An assumption beside another recovery assumption is no internal design for that reason alone.
    expect(prompt).toContain("is not internal design even when another assumption states something close to it");
    expect(prompt).not.toContain("through another assumption");
  });

  // What reading back through the interface shows, after a restart or an environment setting included,
  // is the observable class; "stored-data" is what nothing read through the interface shows.
  test("the intake prompt classifies a guarantee's observation by what the interface shows, never stored-data for what reading back shows", async () => {
    const { prompt } = await intakeOf({ replay: "client-visible", format: "internal-design" });
    expect(prompt).toContain(OBSERVATION_RULE.join("\n"));
    expect(prompt).not.toContain("the data the client stores with it), or");
  });
});

// A reading that asks the client nothing is a claim that the
// tender leaves nothing open worth asking. It is put to a second reading at the strongest independence
// the catalog offers; the second reading's questions are the ones the client is sent; a reading no
// second reading answered is recorded unconfirmed and the client is told, never held.
describe("TenderIntake second reading of a reading that asks nothing", () => {
  const TENDER = "A booking page.";
  const QUESTION = {
    text: "Must a booking be cancellable online?",
    whyItMatters: "It decides whether the page has a cancel flow.",
    assumption: { statement: "Bookings are cancelled by phone.", rationale: "The tender names no cancel flow.", kind: "client-visible", underpins: ["G1"] },
  };
  const lazy = {
    summary: "A booking page.",
    ...contractOf(TENDER),
    questions: [],
    assumptions: [drafted("A1", "Times are shown in the studio's zone.", "client-visible")],
  };
  type Request = { readonly secondOpinion: NonNullable<Sent["secondOpinion"]>; readonly judges: NonNullable<Sent["judges"]> };
  type Answer = { readonly data: unknown; readonly provider: string; readonly model: string };

  /** The intake of one tender whose first reading answers `first`, by a model graded `firstGrade` as called. */
  async function intakeWith(first: unknown, second: (request: Request, call: number) => Answer, firstGrade: CapabilityLevel = "Strong") {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked: Array<{ readonly strength: string | null; readonly prompt: string }> = [];
    const sent: Array<{ readonly judges: CapabilityLevel | undefined; readonly capability: CapabilityLevel | undefined }> = [];
    let seconds = 0;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          asked.push({ strength: request.secondOpinion?.strength ?? null, prompt: request.prompt });
          if (request.secondOpinion === undefined) return { data: request.schema.parse(first), provider: "anthropic", model: "sonnet", grade: firstGrade };
          sent.push({ judges: request.judges, capability: request.capability });
          if (request.judges === undefined) throw new Error("the second reading asks a capability, not a judge");
          const answer = second({ secondOpinion: request.secondOpinion, judges: request.judges }, seconds++);
          const parsed = request.schema.safeParse(answer.data);
          if (!parsed.success) throw new SchemaValidationError([z.prettifyError(parsed.error)], answer.model);
          return { ...answer, grade: request.judges, data: parsed.data };
        },
      }),
    };
    const { store, writes } = recordingStore(tenderOf("tender-s", TENDER, 84));
    const [outcome] = await new TenderIntake({ containment: memoryStepContainment(() => false), llm, store }).runPending();
    return { outcome, asked, sent, write: writes[0] };
  }

  const unavailable = (request: Request): never => {
    throw new SecondOpinionUnavailable(request.secondOpinion, { judges: request.judges }, [], ROUTING_RULES);
  };

  test.each(["Light", "Frontier"] as const)(
    "the second reading asks for a judge of work at the first reading's grade as called (%s), never a capability",
    async (firstGrade) => {
      const { sent, write } = await intakeWith(lazy, () => ({ data: { questions: [] }, provider: "openai", model: "gpt" }), firstGrade);
      expect(sent).toEqual([{ judges: firstGrade, capability: undefined }]);
      expect(write?.reading.first.grade).toBe(firstGrade);
      const confirmation = write?.reading.confirmation;
      if (confirmation?.kind !== "confirmed") return expect.unreachable(`confirmation is ${confirmation?.kind}`);
      expect(confirmation.second.model.grade).toBe(firstGrade);
    },
  );

  test("a reading that asks questions is not put to a second reading", async () => {
    const { outcome, asked, write } = await intakeWith(
      { ...lazy, questions: [{ ...QUESTION, assumption: { ...QUESTION.assumption, id: "A2" } }] },
      () => expect.unreachable("no second reading"),
    );
    expect(asked.map((a) => a.strength)).toEqual([null]);
    expect(outcome).toMatchObject({ kind: "recorded", questions: 1, confirmation: "not-needed" });
    expect(write?.reading).toEqual({ first: { provider: "anthropic", model: "sonnet", grade: "Strong" }, firstQuestions: 1, confirmation: { kind: "not-needed" } });
    expect(write?.readingReport).toBeNull();
  });

  test("another family's second reading that asks nothing confirms the reading, and the client is told at that strength", async () => {
    const { outcome, asked, write } = await intakeWith(lazy, () => ({ data: { questions: [] }, provider: "openai", model: "gpt" }));
    expect(asked.map((a) => a.strength)).toEqual([null, "other-family"]);
    // Another family reads the tender alone, as the first did: no angle, never the first reading's questions or assumptions.
    expect(asked[1]?.prompt).not.toContain("ambiguous or assumed");
    expect(asked[1]?.prompt).not.toContain("Times are shown in the studio's zone.");
    // It is told the guarantees, so each assumption it would ask about can name what it underpins.
    expect(asked[1]?.prompt).toContain("- G1: A visitor gets what the tender asks for.");
    expect(outcome).toMatchObject({ kind: "recorded", questions: 0, confirmation: "confirmed" });
    expect(write?.reading.confirmation).toEqual({
      kind: "confirmed",
      second: { strength: "other-family", model: { provider: "openai", model: "gpt", grade: "Strong" }, questions: [] },
      passedOver: [],
    });
    expect(write?.readingReport).toContain("A second reading of it, by another model family, found nothing to ask either.");
  });

  test("the questions a second reading raises are the ones the client is sent, their assumptions keyed after the first reading's", async () => {
    const { outcome, write } = await intakeWith(lazy, () => ({ data: { questions: [QUESTION] }, provider: "openai", model: "gpt" }));
    expect(outcome).toMatchObject({ kind: "recorded", questions: 1, confirmation: "questions-raised" });
    expect(write?.questions[0]).toContain("Must a booking be cancellable online?");
    const vision = write?.vision(["q0"]);
    expect(vision?.openQuestions).toEqual([{ messageId: "q0", text: QUESTION.text, whyItMatters: QUESTION.whyItMatters, assumptionKey: "A2" }]);
    expect(vision?.inferences.map((a) => [a.key, a.statement, a.disclosed, a.underpins])).toEqual([
      ["A1", "Times are shown in the studio's zone.", "reported", ["G1"]],
      ["A2", "Bookings are cancelled by phone.", "asked", ["G1"]],
    ]);
    expect(write?.readingReport).toContain("found the question we have sent you");
  });

  test("a raised question whose client-visible assumption underpins no guarantee is asked again, never recorded", async () => {
    const orphan = { ...QUESTION, assumption: { ...QUESTION.assumption, underpins: [] } };
    const { asked, write } = await intakeWith(lazy, (_request, call) => ({ data: { questions: [call === 0 ? orphan : QUESTION] }, provider: "openai", model: "gpt" }));
    expect(asked.map((a) => a.strength)).toEqual([null, "other-family", "other-family"]);
    expect(asked[2]?.prompt).toContain("client-visible assumption A2 underpins no guarantee and no exclusion cites it");
    expect(write?.vision(["q0"]).inferences.find((a) => a.key === "A2")?.underpins).toEqual(["G1"]);
  });

  test("with no other family, another model of the family is asked from the ambiguity angle, and the passed-over strength is recorded", async () => {
    const { asked, write } = await intakeWith(lazy, (request) =>
      request.secondOpinion.strength === "other-family" ? unavailable(request) : { data: { questions: [] }, provider: "anthropic", model: "haiku" },
    );
    expect(asked.map((a) => a.strength)).toEqual([null, "other-family", "same-family-other-model"]);
    expect(asked[2]?.prompt).toContain("Work out what in it is ambiguous or assumed");
    const confirmation = write?.reading.confirmation;
    if (confirmation?.kind !== "confirmed") return expect.unreachable(`confirmation is ${confirmation?.kind}`);
    expect(confirmation.second.strength).toBe("same-family-other-model");
    expect(confirmation.passedOver).toEqual([{ strength: "other-family", outcome: "unavailable", reason: expect.stringContaining("SecondOpinionUnavailable") }]);
    expect(write?.readingReport).toContain("another model of the same family as the first reading, which shares more of its blind spots");
  });

  test("a second reading failing at every strength is bounded: recorded unconfirmed, the client told, the tender never held", async () => {
    const { outcome, write } = await intakeWith(lazy, (request) => {
      if (request.secondOpinion.strength === "other-family") return unavailable(request);
      throw new SchemaValidationError(["scripted failure"], null);
    });
    expect(outcome).toMatchObject({ kind: "recorded", questions: 0, confirmation: "unconfirmed" });
    const confirmation = write?.reading.confirmation;
    if (confirmation?.kind !== "unconfirmed") return expect.unreachable(`confirmation is ${confirmation?.kind}`);
    expect(confirmation.passedOver.map((p) => [p.strength, p.outcome])).toEqual([
      ["other-family", "unavailable"],
      ["same-family-other-model", "failed"],
      ["same-model", "failed"],
    ]);
    expect(write?.readingReport).toContain("no second reading of it could be had to confirm that, so that reading is unconfirmed. Work proceeds on it.");
  });

  // A declined contract's reading report says what the reading found and then the decline, whatever the
  // second reading did: no message posted while the contract is declined says work proceeds.
  test.each([
    ["confirmed", () => ({ data: { questions: [] }, provider: "openai", model: "gpt" })],
    ["questions-raised", () => ({ data: { questions: [QUESTION] }, provider: "openai", model: "gpt" })],
    [
      "unconfirmed",
      (request: Request) => {
        if (request.secondOpinion.strength === "other-family") return unavailable(request);
        throw new SchemaValidationError(["scripted failure"], null);
      },
    ],
  ] as const)("on a contract Ashara declines, a reading %s is reported with the decline, never as work under way", async (kind, second) => {
    const declined = { ...lazy, guarantees: lazy.guarantees.map((g) => ({ ...g, observable: { ...g.observable, observation: "stored-data" } })) };
    const { outcome, write } = await intakeWith(declined, second);
    expect(outcome).toMatchObject({ kind: "recorded", confirmation: kind });
    const messages = [write?.readingReport ?? "", write?.contractDraft ?? "", ...(write?.questions ?? [])];
    expect(messages[0]).not.toBe("");
    for (const message of messages) {
      expect(message).toContain(DECLINE);
      for (const proceeds of UNDER_WAY) expect(message).not.toContain(proceeds);
    }
    // The same reading on a contract Ashara can verify reads as work under way: the decline alone changes the report.
    const kept = await intakeWith(lazy, second);
    expect(kept.write?.readingReport).not.toContain(DECLINE);
  });

  test("a second reading answered by a model of another strength confirms nothing: the intake faults on Ashara's side, uncounted", async () => {
    const { outcome, write } = await intakeWith(lazy, () => ({ data: { questions: [] }, provider: "anthropic", model: "sonnet" }));
    expect(outcome).toMatchObject({ kind: "step-faulted", error: expect.stringContaining("SecondReadingMisrouted") });
    expect(write).toBeUndefined();
  });
});
