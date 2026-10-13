import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { buildGateway } from "@ashara/llm-gateway";
import type { GatewayConfig, LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { UnpricedModel } from "./errors.js";
import { LlmCallLedger } from "./llm-call-ledger.js";

// Against the shared dev database: every row here belongs to a project this
// suite creates under a unique name, and afterAll deletes exactly those rows.
// No real LLM call is made: the provider factories return a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => stub.model }));

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
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    priceWindows: [],
    ...overrides,
  };
}

// A Wednesday. 02:30 UTC is inside DeepSeek's 01:00-04:00 peak; 12:00 UTC is off-peak.
const PEAK = new Date("2026-10-14T02:30:00Z");
const OFF_PEAK = new Date("2026-10-14T12:00:00Z");

function gateway(
  providerName: "anthropic" | "deepseek" | "openai",
  modelConfig: ModelConfig,
  clock: () => Date = () => PEAK,
): LLMGateway {
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
    recording: { kind: "recorded", recorder: new LlmCallLedger(calls, clock) },
  });
}

function stubModel(doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4(doGenerate);
  stub.model = mock;
  return mock;
}

/** `raw` is the provider's wire-format usage, which the AI SDK passes through as `usage.raw`. */
function textResult(
  text: string,
  usage: { input: number | undefined; output: number | undefined },
  raw?: Record<string, number | Record<string, number>>,
) {
  return {
    content: [{ type: "text" as const, text }],
    usage: {
      inputTokens: { total: usage.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
      raw,
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
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
  createdAt: z.coerce.date(),
  outcome: z.string(),
  errorKind: z.string().nullable(),
});

async function rowsOfThisProject(): Promise<z.infer<typeof LlmCallRowSchema>[]> {
  const result = await db.execute(sql`
    SELECT project_id AS "projectId", task_id AS "taskId", call_site AS "callSite", provider, model,
           input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           cache_read_tokens AS "cacheReadTokens", cache_write_tokens AS "cacheWriteTokens",
           cost_usd::float8 AS "costUsd", created_at AS "createdAt", outcome, error_kind AS "errorKind"
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
  const client = await new ClientRepository(db).create(`llm-calls-test-${NONCE}`);
  projectId = (await new ProjectRepository(db).create(`llm-calls-test-${NONCE}`, client.id)).id;
});

afterAll(async () => {
  await clearRows();
  await db.execute(sql`DELETE FROM projects WHERE name = ${`llm-calls-test-${NONCE}`}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${`llm-calls-test-${NONCE}`}`);
  await db.$client.end();
});

describe("one llm_calls row per provider call", () => {
  test("a successful call writes one row with the project, model, tokens and calculated cost", async () => {
    await clearRows();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1200, output: 80 }, {
        input_tokens: 200,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
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
    // 200 plain input at 3, 900 cache read at 0.30, 100 cache write at 3.75, 80 output at 15.
    expect(row.costUsd).toBeCloseTo((200 * 3 + 900 * 0.3 + 100 * 3.75 + 80 * 15) / 1_000_000, 6);
    expect(row.createdAt.toISOString()).toBe(PEAK.toISOString());
  });

  test("a call's cost uses the rate of the window its instant falls in", async () => {
    const deepseek = model({
      id: "deepseek-windowed",
      inputCostPer1M: 0.3,
      outputCostPer1M: 1.2,
      cacheReadCostPer1M: 0.006,
      cacheWriteCostPer1M: null,
      priceWindows: [{
        isoWeekday: 3,
        utcStartMinute: 600,
        utcEndMinute: 1440,
        rates: { inputCostPer1M: 0.15, outputCostPer1M: 0.6, cacheReadCostPer1M: 0.003, cacheWriteCostPer1M: null },
      }],
    });
    const costAt = async (instant: Date): Promise<number | null> => {
      await clearRows();
      stubModel({
        doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 100 }, {
          prompt_cache_hit_tokens: 400,
          prompt_cache_miss_tokens: 600,
        }),
      });
      await gateway("deepseek", deepseek, () => instant)
        .forCall({ projectId, taskId: null, callSite: "decomposition" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });
      const [row] = await rowsOfThisProject();
      return row?.costUsd ?? null;
    };

    expect(await costAt(PEAK)).toBeCloseTo((600 * 0.3 + 400 * 0.006 + 100 * 1.2) / 1_000_000, 9);
    expect(await costAt(OFF_PEAK)).toBeCloseTo((600 * 0.15 + 400 * 0.003 + 100 * 0.6) / 1_000_000, 9);
  });

  test("reported cache tokens of a class the model has no rate for give a NULL cost, logged at warn", async () => {
    await clearRows();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 40 }, {
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
      }),
    });

    await gateway("deepseek", model({ id: "no-cache-rate", cacheReadCostPer1M: null, cacheWriteCostPer1M: null }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBe(700);
    expect(row?.costUsd).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[LlmCallLedger\] cost unmeasured: provider=deepseek, model=no-cache-rate, .*no rate=\[cacheReadTokens\].*cost_usd is NULL/,
      ),
    );
  });

  test("DeepSeek cache hits are measured from its raw usage", async () => {
    await clearRows();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 40 }, {
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
      }),
    });

    await gateway("deepseek", model({ id: "deepseek-priced", cacheWriteCostPer1M: null }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBe(700);
    expect(row?.cacheWriteTokens).toBeNull();
    expect(row?.costUsd).toBeCloseTo((300 * 3 + 700 * 0.3 + 40 * 15) / 1_000_000, 9);
  });

  test("an OpenAI Responses call with cached input is measured at the cache-read rate", async () => {
    await clearRows();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 40 }, {
        input_tokens: 1000,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 600 },
      }),
    });

    await gateway("openai", model({ id: "openai-priced", inputCostPer1M: 2, outputCostPer1M: 8, cacheReadCostPer1M: 0.5, cacheWriteCostPer1M: null }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBe(600);
    expect(row?.costUsd).toBeCloseTo((400 * 2 + 600 * 0.5 + 40 * 8) / 1_000_000, 9);
  });

  test("a call that does not report a cache class the model bills is NULL, logged at warn", async () => {
    await clearRows();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 40 }, { prompt_tokens: 1000 }) });

    await gateway("openai", model({ id: "openai-unreported", cacheWriteCostPer1M: null }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[LLMGateway\] cost unmeasured: .*counts=\[cacheReadTokens\]/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[LlmCallLedger\] cost unmeasured: .*counts=\[cacheReadTokens\]/));
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
