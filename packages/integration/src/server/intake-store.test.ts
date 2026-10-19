import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, LlmCallRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { stepContainment } from "@ashara/delivery";
import { TenderIntake, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import type { IntakeStore } from "@ashara/engagement";
import { BudgetExceeded, GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { recordingLogger, systemClock, type ProjectId } from "@ashara/shared";
import type { StepContainment } from "@ashara/shared";
import { createIntakeStore } from "@ashara/server/intake-store";

// Against the shared dev database: every row here belongs to a project this
// suite creates under a unique name, and afterAll deletes exactly those rows.
// The intake store is narrowed to this suite's projects so no other tender in
// the database is taken in. No real LLM call is made: the provider factory
// returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
// Caps far above anything a stubbed call can cost: these tests are about the calls, not the cap.
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const NONCE = randomUUID().slice(0, 8);
const NAME_PREFIX = `liaison-intake-test-${NONCE}`;

let db: ReturnType<typeof createDb>;
let gateway: GuardedModelAccess;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    thinkingOffCapabilityLevel: capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [], priceTiers: [], datedPrices: [],
  };
}

function stubModel(doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4(doGenerate);
  stub.model = mock;
  return mock;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    usage: {
      inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: 200, reasoning: undefined },
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
  };
}

function intakeResponse(questionCount: number) {
  return {
    summary: "A booking page for the client's two pottery studios.",
    inScope: ["Class booking for both studios"],
    outOfScope: ["Payments"],
    assumptions: [
      { statement: "Each class has a fixed capacity set by the studio.", rationale: "The tender mentions full classes.", kind: "client-visible" },
      { statement: "Bookings need no account.", rationale: "The tender says walk-in customers book.", kind: "internal-design" },
    ],
    questions: Array.from({ length: questionCount }, (_, i) => ({
      text: `Question ${i + 1} about the pottery studios?`,
      whyItMatters: `It changes booking rule ${i + 1}.`,
      assumption: { statement: `Booking rule ${i + 1} is the studio's usual one.`, rationale: `The tender implies rule ${i + 1}.`, kind: "client-visible" },
    })),
  };
}

function ourStore(): IntakeStore {
  const store = createIntakeStore(db);
  return {
    ...store,
    openTenders: async () => (await store.openTenders()).filter((t) => ourProjects.has(t.projectId)),
  };
}

/** The cycle's containment, as the composition root supplies it; a spend-cap refusal escapes. */
function containment(): StepContainment {
  return stepContainment(db, systemClock, (error) => error instanceof BudgetExceeded, recordingLogger());
}

function intake(): TenderIntake {
  return new TenderIntake({ containment: containment(), llm: gateway, store: ourStore() });
}

/** A gateway recording through Finance's real ledger, with the spend cap's ledger port and caps given. */
function gatewayWithLedger(spendCap: {
  readonly ledger: ConstructorParameters<typeof SpendCap>[0]["ledger"];
  readonly caps: ConstructorParameters<typeof SpendCap>[0]["caps"];
}): GuardedModelAccess {
  return new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        {
          name: "deepseek",
          providerType: "deepseek",
          apiKey: "test-key",
          baseUrl: "https://stub.invalid/v1",
          models: [model("intake-strong", "Strong"), model("intake-frontier", "Frontier")],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: spendCap.ledger, caps: spendCap.caps }),
  ), recordingLogger());
}

async function tender(body: string): Promise<{ projectId: ProjectId; tenderId: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, body);
  ourProjects.add(created.project.id);
  return { projectId: created.project.id, tenderId: created.message.id };
}

const VisionRowSchema = z.object({
  version: z.number(),
  visionText: z.string(),
  inferences: z.array(
    z.object({ key: z.string(), statement: z.string(), rationale: z.string(), status: z.string(), kind: z.string(), disclosed: z.string() }),
  ),
  openQuestions: z.array(
    z.object({ messageId: z.string(), text: z.string(), whyItMatters: z.string(), assumptionKey: z.string() }),
  ),
});

async function visions(projectId: ProjectId): Promise<z.infer<typeof VisionRowSchema>[]> {
  const result = await db.execute(sql`
    SELECT version, vision_text AS "visionText", inferences, open_questions AS "openQuestions"
    FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`);
  return z.array(VisionRowSchema).parse(result.rows);
}

async function messagesOf(projectId: ProjectId) {
  return new ClientMessageRepository(db).listByProject(projectId);
}

const ReadingRowSchema = z.object({
  confirmation: z.string(),
  firstQuestions: z.number(),
  secondStrength: z.string().nullable(),
  secondModel: z.string().nullable(),
  secondQuestions: z.number().nullable(),
  passedOver: z.array(z.object({ strength: z.string(), outcome: z.string(), reason: z.string() })),
  judgedTier: z.string().nullable(),
  judgeTier: z.string().nullable(),
});

/** The project's intake_readings row. */
async function readingOf(projectId: ProjectId): Promise<z.infer<typeof ReadingRowSchema>> {
  const result = await db.execute(sql`
    SELECT confirmation, first_questions AS "firstQuestions", second_strength AS "secondStrength", second_model AS "secondModel",
           second_questions AS "secondQuestions", passed_over AS "passedOver", judged_tier AS "judgedTier", judge_tier AS "judgeTier"
    FROM intake_readings WHERE project_id = ${projectId}`);
  const [row, ...more] = z.array(ReadingRowSchema).parse(result.rows);
  if (row === undefined || more.length > 0) throw new Error(`expected one intake_readings row of ${projectId}, got ${result.rows.length}`);
  return row;
}

async function callSitesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT call_site AS "callSite" FROM llm_calls WHERE project_id = ${projectId}`);
  return z.array(z.object({ callSite: z.string() })).parse(result.rows).map((r) => r.callSite);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  const config: Parameters<typeof buildGateway>[0]["config"] = {
    providers: [
      {
        name: "deepseek",
        providerType: "deepseek",
        apiKey: "test-key",
        baseUrl: "https://stub.invalid/v1",
        models: [model("intake-strong", "Strong"), model("intake-frontier", "Frontier"), model("intake-frontier-b", "Frontier")],
        enabled: true,
      },
    ],
    defaultProvider: "deepseek",
    contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
  };
  gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config,
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: new LlmCallRepository(db), caps: TEST_SPEND_CAPS }),
  ), recordingLogger());
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Each test takes in only its own tenders; an earlier test's open one stays out.
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("Liaison tender intake", () => {
  test("a tender becomes vision v1 with Inferred assumptions, posted questions and a consumed tender", async () => {
    stubModel({ doGenerate: jsonResult(intakeResponse(3)) });
    const { projectId, tenderId } = await tender("Booking page for my two pottery studios.");

    const outcomes = await intake().runPending();

    expect(outcomes).toEqual([{ kind: "recorded", tenderId, projectId, questions: 3, confirmation: "not-needed" }]);
    const [vision, ...others] = await visions(projectId);
    expect(others).toHaveLength(0);
    expect(vision?.version).toBe(1);
    expect(vision?.visionText).toBe("Booking page for my two pottery studios.");
    // Three questions' assumptions plus the two unasked ones, all Inferred.
    expect(vision?.inferences.map((a) => a.status)).toEqual(Array(5).fill("Inferred"));
    expect(new Set(vision?.inferences.map((a) => a.key)).size).toBe(5);

    const messages = await messagesOf(projectId);
    const questions = messages.filter((m) => m.direction === "outbound" && m.kind === "question");
    expect(questions).toHaveLength(3);
    expect(questions.every((q) => q.inReplyTo === tenderId)).toBe(true);
    expect(vision?.openQuestions.map((q) => q.messageId)).toEqual(questions.map((q) => q.id));
    expect(messages.find((m) => m.id === tenderId)?.consumedAt).toBeInstanceOf(Date);

    // Each open question names its assumption, and the client reads it in the question.
    for (const [i, open] of (vision?.openQuestions ?? []).entries()) {
      const adopted = vision?.inferences.find((a) => a.key === open.assumptionKey);
      expect(adopted?.statement).toBe(`Booking rule ${i + 1} is the studio's usual one.`);
      expect(questions[i]?.body).toContain(`Question ${i + 1} about the pottery studios?`);
      expect(questions[i]?.body).toContain(`we proceed on this assumption: ${adopted?.statement}`);
    }

    // The two unasked assumptions reach the client in one report, posted with the questions.
    const reports = messages.filter((m) => m.direction === "outbound" && m.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.inReplyTo).toBe(tenderId);
    expect(reports[0]?.body).toContain("we proceed on them unless you object");
    expect(reports[0]?.body).toContain("Each class has a fixed capacity set by the studio.");
    expect(reports[0]?.body).toContain("Bookings need no account.");
    expect(reports[0]?.body).not.toContain("Booking rule 1");
    expect(vision?.inferences.map((a) => a.disclosed)).toEqual(["asked", "asked", "asked", "reported", "reported"]);
    expect(vision?.inferences.map((a) => a.kind)).toEqual([
      "client-visible",
      "client-visible",
      "client-visible",
      "client-visible",
      "internal-design",
    ]);

    expect(await callSitesOf(projectId)).toEqual(["liaison-intake"]);
    // A reading that asked questions needs no second reading, and is recorded so.
    expect(await readingOf(projectId)).toEqual({
      confirmation: "not-needed", firstQuestions: 3, secondStrength: null, secondModel: null, secondQuestions: null, passedOver: [], judgedTier: "Frontier", judgeTier: null,
    });
  });

  // A reading of a tender that asks nothing is a claim. The catalog holds
  // one provider whose models are priced alike, so the first reading goes to intake-frontier (the
  // id breaks the tie) and the second, which may not be graded below it, to intake-frontier-b, from
  // the ambiguity angle, through the real gateway and ledger; the question it raises is the one posted, and the reading is recorded with
  // its strength and told to the client, in the intake's one transaction.
  const SECOND_READING_MARKER = "Find the questions the client must be asked instead";
  function readingWith(second: unknown) {
    return async (options: { readonly prompt: unknown }) =>
      jsonResult(JSON.stringify(options.prompt).includes(SECOND_READING_MARKER) ? second : intakeResponse(0));
  }

  test("a reading that asks nothing is put to another model of the family graded at or above it, whose question is posted and whose strength is recorded and told", async () => {
    stubModel({ doGenerate: readingWith({ questions: intakeResponse(1).questions }) });
    const { projectId, tenderId } = await tender("Booking page for one studio.");

    expect(await intake().runPending()).toEqual([{ kind: "recorded", tenderId, projectId, questions: 1, confirmation: "questions-raised" }]);
    const reading = await readingOf(projectId);
    // The first reading was a Frontier model's: the Strong one of the family may not judge it.
    expect(reading).toMatchObject({
      confirmation: "questions-raised", firstQuestions: 0, secondStrength: "same-family-other-model", secondModel: "intake-frontier-b", secondQuestions: 1,
      judgedTier: "Frontier", judgeTier: "Frontier",
    });
    expect(reading.passedOver).toEqual([{ strength: "other-family", outcome: "unavailable", reason: expect.stringContaining("SecondOpinionUnavailable") }]);
    const messages = await messagesOf(projectId);
    expect(messages.filter((m) => m.kind === "question").map((q) => q.body.split("\n")[0])).toEqual(["Question 1 about the pottery studios?"]);
    const told = messages.filter((m) => m.kind === "report" && m.body.startsWith("Our first reading of your tender found nothing"));
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain("by another model of the same family as the first reading");
    expect(await callSitesOf(projectId)).toEqual(["liaison-intake", "liaison-intake"]);
  });

  test("a second reading that fails at every strength records the reading unconfirmed and tells the client, never holding the tender", async () => {
    stubModel({ doGenerate: readingWith({ not: "a reading" }) });
    const { projectId, tenderId } = await tender("Booking page for a third studio.");

    expect(await intake().runPending()).toEqual([{ kind: "recorded", tenderId, projectId, questions: 0, confirmation: "unconfirmed" }]);
    const reading = await readingOf(projectId);
    expect(reading.confirmation).toBe("unconfirmed");
    expect(reading.passedOver.map((p) => [p.strength, p.outcome])).toEqual([
      ["other-family", "unavailable"],
      ["same-family-other-model", "failed"],
      ["same-model", "unavailable"],
    ]);
    const messages = await messagesOf(projectId);
    expect(messages.find((m) => m.id === tenderId)?.consumedAt).toBeInstanceOf(Date);
    expect(messages.some((m) => m.kind === "report" && m.body.includes("so that reading is unconfirmed"))).toBe(true);
  });

  test("five questions posted in one transaction come back in the order the Liaison ranked them", async () => {
    stubModel({ doGenerate: jsonResult(intakeResponse(5)) });
    const { projectId } = await tender("Booking page with a waiting list.");

    await intake().runPending();

    const questions = (await messagesOf(projectId)).filter((m) => m.kind === "question");
    expect(new Set(questions.map((q) => q.createdAt.getTime())).size).toBe(1);
    expect(questions.map((q) => q.position)).toEqual([1, 2, 3, 4, 5]);
    expect(questions.map((q) => q.body.split("\n")[0])).toEqual(
      [1, 2, 3, 4, 5].map((n) => `Question ${n} about the pottery studios?`),
    );
  });

  test("seven questions are rejected, not capped: nothing is written and the attempt is counted", async () => {
    stubModel({ doGenerate: jsonResult(intakeResponse(7)) });
    const { projectId, tenderId } = await tender("Inventory tool for a bakery.");

    const [outcome] = await intake().runPending();

    expect(outcome?.kind).toBe("failed");
    expect(outcome?.kind === "failed" ? outcome.error : "").toMatch(/StructuredOutputExhausted/);
    expect(await visions(projectId)).toHaveLength(0);
    const messages = await messagesOf(projectId);
    expect(messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
    const tenderRow = messages.find((m) => m.id === tenderId);
    expect(tenderRow?.consumedAt).toBeNull();
    expect(tenderRow?.intakeAttempts).toBe(1);
    expect(tenderRow?.intakeLastError).toMatch(/StructuredOutputExhausted/);
    const sites = await callSitesOf(projectId);
    expect(sites.length).toBeGreaterThan(0);
    expect(new Set(sites)).toEqual(new Set(["liaison-intake"]));
  });

  test("three provider failures post one report, consume the tender and write no vision", async () => {
    stubModel({
      doGenerate: async () => {
        throw new APICallError({ message: "stub provider unavailable", url: "https://stub.invalid/v1", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      },
    });
    const { projectId, tenderId } = await tender("Timesheet app for a cleaning company.");
    const liaison = intake();

    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (const outcome of await liaison.runPending()) kinds.push(outcome.kind);
    }
    expect(kinds).toEqual(["failed", "failed", "abandoned"]);
    expect(await liaison.runPending()).toEqual([]);

    expect(await visions(projectId)).toHaveLength(0);
    const messages = await messagesOf(projectId);
    const outbound = messages.filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.kind).toBe("report");
    expect(outbound[0]?.body).toMatch(/could not process your tender after 3 attempts/);
    expect(outbound[0]?.body).not.toMatch(/stub provider unavailable/);
    expect(outbound[0]?.body).not.toMatch(/caused by|Error:/);
    const tenderRow = messages.find((m) => m.id === tenderId);
    expect(tenderRow?.consumedAt).toBeInstanceOf(Date);
    expect(tenderRow?.intakeAttempts).toBe(3);
    expect(tenderRow?.intakeLastError).toMatch(/stub provider unavailable/);
  });

  // Ashara's own faults never use up the client's tender. One tender's fault is that tender's:
  // recorded in step_faults with a backoff, never thrown into the cycle for every project.
  const RowFaultSchema = z.object({ faults: z.number(), lastError: z.string(), waiting: z.boolean() });

  async function faultOf(tenderId: string): Promise<z.infer<typeof RowFaultSchema> | null> {
    const result = await db.execute(sql`
      SELECT faults, last_error AS "lastError", (retry_at > now()) AS waiting
      FROM step_faults WHERE step = 'liaison-intake' AND subject_id = ${tenderId}`);
    return z.array(RowFaultSchema).parse(result.rows)[0] ?? null;
  }

  async function endBackoff(tenderId: string): Promise<void> {
    await db.execute(sql`UPDATE step_faults SET retry_at = now() - interval '1 second' WHERE step = 'liaison-intake' AND subject_id = ${tenderId}`);
  }

  test("a store that fails to record one tender's intake is that tender's fault: recorded with a backoff, the other tender taken in", async () => {
    stubModel({ doGenerate: jsonResult(intakeResponse(1)) });
    const broken = await tender("Menu board for a cafe.");
    const healthy = await tender("Opening hours page for a cafe.");
    const store = ourStore();
    const failing: IntakeStore = {
      ...store,
      recordIntake: async (write) => {
        if (write.tender.id === broken.tenderId) throw new Error("scripted store failure");
        return store.recordIntake(write);
      },
    };
    const liaison = new TenderIntake({ containment: containment(), llm: gateway, store: failing });

    const outcomes = await liaison.runPending();

    expect(outcomes.map((outcome) => [outcome.kind, outcome.kind === "step-faulted" ? outcome.subjectId : outcome.tenderId])).toEqual([
      ["step-faulted", broken.tenderId],
      ["recorded", healthy.tenderId],
    ]);
    const tenderRow = (await messagesOf(broken.projectId)).find((m) => m.id === broken.tenderId);
    expect(tenderRow?.consumedAt).toBeNull();
    expect(tenderRow?.intakeAttempts).toBe(0);
    expect(tenderRow?.intakeLastError).toBeNull();
    expect(await faultOf(broken.tenderId)).toEqual({ faults: 1, lastError: expect.stringContaining("scripted store failure"), waiting: true });
    expect(await visions(broken.projectId)).toHaveLength(0);
    // Not read again until its backoff has passed; then read again, and recorded.
    expect(await liaison.runPending()).toEqual([]);
    await endBackoff(broken.tenderId);
    expect((await intake().runPending()).map((outcome) => outcome.kind)).toEqual(["recorded"]);
    expect(await faultOf(broken.tenderId)).toBeNull();
  });

  test("a spend-cap refusal throws through as BudgetExceeded: no attempt is counted and the tender is not consumed", async () => {
    const mock = stubModel({ doGenerate: jsonResult(intakeResponse(1)) });
    const { projectId, tenderId } = await tender("Shift planner for a bakery.");
    const capped = gatewayWithLedger({
      ledger: new LlmCallRepository(db),
      caps: { deploymentUsd: 1_000_000, perProjectUsd: 0.000001 },
    });

    await expect(new TenderIntake({ containment: containment(), llm: capped, store: ourStore() }).runPending()).rejects.toMatchObject({
      name: "BudgetExceeded",
      scope: { kind: "project", projectId },
    });

    expect(mock.doGenerateCalls).toHaveLength(0);
    const tenderRow = (await messagesOf(projectId)).find((m) => m.id === tenderId);
    expect(tenderRow?.consumedAt).toBeNull();
    expect(tenderRow?.intakeAttempts).toBe(0);
    expect(tenderRow?.intakeLastError).toBeNull();
    expect(await faultOf(tenderId)).toBeNull();
    expect((await messagesOf(projectId)).filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  test("a ledger that breaks while admitting the call is a fault on Ashara's side: each read records one, nothing counted against the tender", async () => {
    const mock = stubModel({ doGenerate: jsonResult(intakeResponse(1)) });
    const { projectId, tenderId } = await tender("Stock list for a bike shop.");
    const repository = new LlmCallRepository(db);
    const broken = gatewayWithLedger({
      ledger: {
        spend: async () => {
          throw new Error("scripted ledger read failure");
        },
        admit: (row) => repository.admit(row),
        work: (scope) => repository.work(scope),
        workBySite: (scope) => repository.workBySite(scope),
      },
      caps: TEST_SPEND_CAPS,
    });
    const liaison = new TenderIntake({ containment: containment(), llm: broken, store: ourStore() });

    for (let i = 1; i <= 3; i++) {
      expect(await liaison.runPending()).toEqual([
        expect.objectContaining({ kind: "step-faulted", subjectId: tenderId, faults: i, retryAfterSeconds: 60 * 2 ** (i - 1), error: expect.stringContaining("LlmCallNotAdmitted") }),
      ]);
      await endBackoff(tenderId);
    }

    expect(mock.doGenerateCalls).toHaveLength(0);
    const messages = await messagesOf(projectId);
    const tenderRow = messages.find((m) => m.id === tenderId);
    expect(tenderRow?.consumedAt).toBeNull();
    expect(tenderRow?.intakeAttempts).toBe(0);
    expect(tenderRow?.intakeLastError).toBeNull();
    expect(messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  test("a provider rejecting Ashara's credentials or the request Ashara built is Ashara's fault: recorded on the tender, never counted against it", async () => {
    for (const [statusCode, message] of [
      [401, "Authentication Fails (invalid api key)"],
      [413, "Request Entity Too Large"],
      [422, "Unprocessable Entity: max_tokens out of range"],
    ] as const) {
      stubModel({
        doGenerate: async () => {
          throw new APICallError({ message, url: "https://stub.invalid/v1/chat/completions", requestBodyValues: {}, statusCode });
        },
      });
      const { projectId, tenderId } = await tender(`Loyalty card for a tea shop (${statusCode}).`);
      ourProjects.clear();
      ourProjects.add(projectId);

      expect(await intake().runPending()).toEqual([expect.objectContaining({ kind: "step-faulted", subjectId: tenderId, faults: 1, error: expect.stringContaining(message) })]);

      const tenderRow = (await messagesOf(projectId)).find((m) => m.id === tenderId);
      expect(tenderRow?.consumedAt).toBeNull();
      expect(tenderRow?.intakeAttempts).toBe(0);
      expect(tenderRow?.intakeLastError).toBeNull();
    }
  });

  test("a fault in Ashara's own handling of the request is recorded on the tender: no attempt is counted and the tender stays open", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubModel({
      doGenerate: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'content')");
      },
    });
    const { projectId, tenderId } = await tender("Price list for a bike shop.");

    expect(await intake().runPending()).toEqual([expect.objectContaining({ kind: "step-faulted", subjectId: tenderId, error: expect.stringContaining("Cannot read properties") })]);

    const tenderRow = (await messagesOf(projectId)).find((m) => m.id === tenderId);
    expect(tenderRow?.consumedAt).toBeNull();
    expect(tenderRow?.intakeAttempts).toBe(0);
    expect(await faultOf(tenderId)).toMatchObject({ faults: 1, waiting: true });
  });

  test("intake on a project that already has a vision writes nothing new", async () => {
    stubModel({ doGenerate: jsonResult(intakeResponse(1)) });
    const { projectId } = await tender("Recipe site for a family.");
    await intake().runPending();
    expect(await intake().runPending()).toEqual([]);

    const second = await new ClientMessageRepository(db).insertInbound({
      projectId,
      kind: "tender",
      body: "Recipe site for a family, again.",
      inReplyTo: null,
    });
    const mock = stubModel({ doGenerate: jsonResult(intakeResponse(2)) });

    const outcomes = await intake().runPending();

    expect(outcomes).toEqual([{ kind: "vision-exists", tenderId: second.id, projectId, visionVersion: 1 }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await visions(projectId)).toHaveLength(1);
    const messages = await messagesOf(projectId);
    expect(messages.filter((m) => m.kind === "question")).toHaveLength(1);
    // The assumptions report is posted once, with the first intake, and never again.
    expect(messages.filter((m) => m.kind === "report")).toHaveLength(1);
    expect(await callSitesOf(projectId)).toEqual(["liaison-intake"]);
  });
});
