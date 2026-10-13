import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ClientMessageRepository,
  ClientRepository,
  createDb,
  createProjectWithTender,
  DEFAULT_DATABASE_URL,
  LlmCallRepository,
} from "@ashara/db";
import { TenderIntake } from "@ashara/engagement";
import type { IntakeStore } from "@ashara/engagement";
import { LlmCallLedger } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import type { ProjectId } from "@ashara/shared";
import { createIntakeStore } from "./intake-store.js";

// Against the shared dev database: every row here belongs to a project this
// suite creates under a unique name, and afterAll deletes exactly those rows.
// The intake store is narrowed to this suite's projects so no other tender in
// the database is taken in. No real LLM call is made: the provider factory
// returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);
const NAME_PREFIX = `liaison-intake-test-${NONCE}`;

let db: ReturnType<typeof createDb>;
let gateway: LLMGateway;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
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
    scopeBoundaries: ["In: class booking for both studios", "Out: payments"],
    assumptions: [
      { statement: "Each class has a fixed capacity set by the studio.", rationale: "The tender mentions full classes." },
      { statement: "Bookings need no account.", rationale: "The tender says walk-in customers book." },
    ],
    questions: Array.from({ length: questionCount }, (_, i) => ({
      text: `Question ${i + 1} about the pottery studios?`,
      whyItMatters: `It changes booking rule ${i + 1}.`,
      assumption: { statement: `Booking rule ${i + 1} is the studio's usual one.`, rationale: `The tender implies rule ${i + 1}.` },
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

function intake(): TenderIntake {
  return new TenderIntake({ llm: gateway, store: ourStore() });
}

async function tender(body: string): Promise<{ projectId: ProjectId; tenderId: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, body);
  ourProjects.add(created.project.id);
  return { projectId: created.project.id, tenderId: created.message.id };
}

const VisionRowSchema = z.object({
  version: z.number(),
  visionText: z.string(),
  inferences: z.array(z.object({ key: z.string(), statement: z.string(), rationale: z.string(), status: z.string() })),
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
        apiKey: "test-key",
        baseUrl: "https://stub.invalid/v1",
        models: [model("intake-strong", "Strong"), model("intake-frontier", "Frontier")],
        enabled: true,
      },
    ],
    defaultProvider: "deepseek",
  };
  gateway = buildGateway({
    config,
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(new LlmCallRepository(db)) },
    clock: () => new Date(),
  });
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

    expect(outcomes).toEqual([{ kind: "recorded", tenderId, projectId, questions: 3 }]);
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

    expect(await callSitesOf(projectId)).toEqual(["liaison-intake"]);
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
        throw new Error("stub provider unavailable");
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
    expect(await callSitesOf(projectId)).toEqual(["liaison-intake"]);
  });
});
