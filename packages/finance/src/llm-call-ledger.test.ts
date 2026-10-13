import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, DEFAULT_DATABASE_URL, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { buildGateway, calculateCost } from "@ashara/llm-gateway";
import type { GatewayConfig, LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { UnpricedModel } from "./errors.js";
import { LlmCallLedger } from "./llm-call-ledger.js";

// Against the shared dev database: every row here belongs to a project this
// suite creates under a unique name, and afterAll deletes exactly those rows.
// No real LLM call is made: the provider factories return a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

type Db = ReturnType<typeof createDb>;
let db: Db;
let calls: LlmCallRepository;
let projectId: Awaited<ReturnType<ProjectRepository["create"]>>["id"];

const GreetingSchema = z.object({ greeting: z.string() });

function model(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    id: "test-model",
    apiModelId: "test-model-api",
    provider: "anthropic",
    capabilityLevel: "Strong",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 100_000,
    supportsCaching: true,
    ...overrides,
  };
}

function gateway(providerName: "anthropic" | "deepseek", modelConfig: ModelConfig): LLMGateway {
  const config: GatewayConfig = {
    providers: [
      {
        name: providerName,
        apiKey: "test-key",
        baseUrl: "https://stub.invalid/v1",
        models: [{ ...modelConfig, provider: providerName }],
        enabled: true,
      },
    ],
    defaultProvider: providerName,
  };
  return buildGateway({
    config,
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(calls) },
  });
}

function stubModel(doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4(doGenerate);
  stub.model = mock;
  return mock;
}

function textResult(
  text: string,
  usage: { input: number | undefined; output: number | undefined },
  providerMetadata?: Record<string, Record<string, number>>,
) {
  return {
    content: [{ type: "text" as const, text }],
    usage: {
      inputTokens: { total: usage.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
    providerMetadata,
  };
}

const LlmCallRowSchema = z.object({
  projectId: z.string(),
  taskId: z.string().nullable(),
  callSite: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  outcome: z.string(),
  errorKind: z.string().nullable(),
});

async function rowsOfThisProject(): Promise<z.infer<typeof LlmCallRowSchema>[]> {
  const result = await db.execute(sql`
    SELECT project_id AS "projectId", task_id AS "taskId", call_site AS "callSite", provider, model,
           input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           cache_read_tokens AS "cacheReadTokens", cache_write_tokens AS "cacheWriteTokens",
           cost_usd::float8 AS "costUsd", outcome, error_kind AS "errorKind"
    FROM llm_calls WHERE project_id = ${projectId}
    ORDER BY created_at, id`);
  return z.array(LlmCallRowSchema).parse(result.rows);
}

async function clearRows(): Promise<void> {
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  calls = new LlmCallRepository(db);
  projectId = (await new ProjectRepository(db).create(`llm-calls-test-${NONCE}`)).id;
});

afterAll(async () => {
  await clearRows();
  await db.execute(sql`DELETE FROM projects WHERE name = ${`llm-calls-test-${NONCE}`}`);
  await db.$client.end();
});

describe("one llm_calls row per provider call", () => {
  test("a successful call writes one row with the project, model, tokens and calculated cost", async () => {
    await clearRows();
    stubModel({
      doGenerate: {
        ...textResult('{"greeting":"hi"}', { input: 1200, output: 80 }),
        providerMetadata: {
          anthropic: { usage: { input_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
        },
      },
    });
    const priced = model({ id: "priced-model" });

    const result = await gateway("anthropic", priced)
      .forCall({ projectId, taskId: null, callSite: "stack-derivation" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    expect(result.data).toEqual({ greeting: "hi" });
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.projectId).toBe(projectId);
    expect(row.taskId).toBeNull();
    expect(row.callSite).toBe("stack-derivation");
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("priced-model");
    expect(row.inputTokens).toBe(1200);
    expect(row.outputTokens).toBe(80);
    expect(row.cacheReadTokens).toBe(900);
    expect(row.cacheWriteTokens).toBe(100);
    expect(row.outcome).toBe("ok");
    expect(row.errorKind).toBeNull();
    const expected = calculateCost(1200, 80, 900, 100, priced).totalCost;
    expect(row.costUsd).toBeCloseTo(expected, 6);
  });

  test("DeepSeek cache hits are measured from its provider metadata", async () => {
    await clearRows();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 40 }, {
        deepseek: { promptCacheHitTokens: 700, promptCacheMissTokens: 300 },
      }),
    });

    await gateway("deepseek", model({ id: "deepseek-priced" }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBe(700);
    expect(row?.cacheWriteTokens).toBe(0);
    expect(row?.costUsd).not.toBeNull();
  });

  test("a provider error writes one 'error' row per provider request and no success row", async () => {
    await clearRows();
    const mock = stubModel({
      doGenerate: async () => {
        throw new Error("stub provider unavailable");
      },
    });

    await expect(
      gateway("anthropic", model({}))
        .forCall({ projectId, taskId: null, callSite: "alignment" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema }),
    ).rejects.toThrow(/stub provider unavailable/);

    const rows = await rowsOfThisProject();
    // generateObject, then the same-model text fallback: two provider requests.
    expect(mock.doGenerateCalls.length).toBe(2);
    expect(rows).toHaveLength(mock.doGenerateCalls.length);
    for (const row of rows) {
      expect(row.outcome).toBe("error");
      expect(row.errorKind).toBe("Error");
      expect(row.inputTokens).toBeNull();
      expect(row.costUsd).toBeNull();
    }
  });

  test("unreported usage is written as NULL tokens and NULL cost, never 0", async () => {
    await clearRows();
    stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: undefined, output: undefined }) });

    await gateway("anthropic", model({}))
      .forCall({ projectId, taskId: null, callSite: "alignment" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.outcome).toBe("ok");
    expect(row?.inputTokens).toBeNull();
    expect(row?.outputTokens).toBeNull();
    expect(row?.cacheReadTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
  });
});

describe("refusals", () => {
  test("an unpriced model throws UnpricedModel before any request and writes no row", async () => {
    await clearRows();
    const mock = stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: 1, output: 1 }) });

    const call = gateway("anthropic", model({ id: "free-model", inputCostPer1M: 0, outputCostPer1M: 0 }))
      .forCall({ projectId, taskId: null, callSite: "alignment" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    await expect(call).rejects.toBeInstanceOf(UnpricedModel);
    await expect(call).rejects.toThrow(/free-model.*unpriced.*model_configs/s);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await rowsOfThisProject()).toHaveLength(0);
  });

  test("a recording gateway refuses a call with no project", async () => {
    const mock = stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: 1, output: 1 }) });
    const recorded = gateway("anthropic", model({}));

    await expect(
      recorded.generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema }),
    ).rejects.toThrow(/without a call context/);
    const contextWithoutProject = { taskId: null, callSite: "alignment" } as const;
    // @ts-expect-error LlmCallContext requires projectId: a call with no project does not typecheck
    recorded.forCall(contextWithoutProject);
    expect(mock.doGenerateCalls).toHaveLength(0);
  });
});
