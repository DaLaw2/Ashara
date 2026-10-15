import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { BudgetExceeded, GuardedModelAccess, LlmCallLedger, measureCost, SpendCap, UnpricedModel } from "@ashara/finance";
import { buildGateway, withStructuredLadder, sdkLanguageModels } from "@ashara/model-access";
import type { LadderAttemptEvent, ModelConfig } from "@ashara/model-access";

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
    priceWindows: [], priceTiers: [],
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
  thinking?: Parameters<typeof buildGateway>[0]["config"]["thinking"],
): GuardedModelAccess {
  const config: Parameters<typeof buildGateway>[0]["config"] = {
    providers: [
      {
        name: providerName,
        providerType: providerName,
        apiKey: "test-key",
        baseUrl: "https://stub.invalid/v1",
        models: [{ ...modelConfig, provider: providerName }],
        enabled: true,
      },
    ],
    defaultProvider: providerName,
    thinking,
  };
  return new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config,
    checkedSources: ["test"],
    clock,
  }), new LlmCallLedger(
    calls,
    // Caps far above anything a stubbed call can cost: this suite is about the rows, not the cap.
    new SpendCap({ ledger: calls, projects: new ProjectRepository(db), caps: { deploymentUsd: 1e6, perProjectUsd: 1e6 } }),
  ));
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
  finishReason: z.string().nullable(),
  reasoningTokens: z.number().int().nullable(),
});

async function rowsOfThisProject(): Promise<z.infer<typeof LlmCallRowSchema>[]> {
  const result = await db.execute(sql`
    SELECT project_id AS "projectId", task_id AS "taskId", call_site AS "callSite", provider, model,
           input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           cache_read_tokens AS "cacheReadTokens", cache_write_tokens AS "cacheWriteTokens",
           cost_usd::float8 AS "costUsd", created_at AS "createdAt", outcome, error_kind AS "errorKind",
           finish_reason AS "finishReason", reasoning_tokens AS "reasoningTokens"
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
      .forCall({ projectId, taskId: null, callSite: "roster" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    expect(result.data).toEqual({ greeting: "hi" });
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.projectId).toBe(projectId);
    expect(row.taskId).toBeNull();
    expect(row.callSite).toBe("roster");
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
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });
      const [row] = await rowsOfThisProject();
      return row?.costUsd ?? null;
    };

    expect(await costAt(PEAK)).toBeCloseTo((600 * 0.3 + 400 * 0.006 + 100 * 1.2) / 1_000_000, 9);
    expect(await costAt(OFF_PEAK)).toBeCloseTo((600 * 0.15 + 400 * 0.003 + 100 * 0.6) / 1_000_000, 9);
  });

  test("the budget ledger and the row price a call at the one instant it was sent", async () => {
    await clearRows();
    stubModel({
      doGenerate: textResult('{"greeting":"hi"}', { input: 1000, output: 100 }, {
        prompt_cache_hit_tokens: 400,
        prompt_cache_miss_tokens: 600,
      }),
    });
    const deepseek = model({
      id: "deepseek-straddling",
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
    // Sent in the peak; any later read of the clock falls in the off-peak window.
    let reads = 0;
    const clock = (): Date => (reads++ === 0 ? PEAK : OFF_PEAK);

    const straddling = gateway("deepseek", deepseek, clock);
    await straddling
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    const peakCost = (600 * 0.3 + 400 * 0.006 + 100 * 1.2) / 1_000_000;
    const [row] = await rowsOfThisProject();
    expect(row?.costUsd).toBeCloseTo(peakCost, 12);
    expect(row?.createdAt.toISOString()).toBe(PEAK.toISOString());
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
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

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
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

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
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

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
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    const [row] = await rowsOfThisProject();
    expect(row?.cacheReadTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
    // Measured once, by Finance: one warn, from the ledger.
    const unmeasured = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("cost unmeasured"));
    expect(unmeasured).toEqual([expect.stringMatching(/^\[LlmCallLedger\] cost unmeasured: .*counts=\[cacheReadTokens\]/)]);
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
        .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 }),
    ).rejects.toThrow(/stub provider unavailable/);

    const rows = await rowsOfThisProject();
    // One provider request: no text fallback after generateObject, no SDK retry.
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    expect(rows[0]?.errorKind).toBe("Error");
    expect(rows[0]?.finishReason).toBe("no-response");
    expect(rows[0]?.inputTokens).toBeNull();
    expect(rows[0]?.costUsd).toBeNull();
  });

  test("unreported usage is written as NULL tokens and NULL cost, never 0", async () => {
    await clearRows();
    stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: undefined, output: undefined }) });

    await gateway("anthropic", model({}))
      .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

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
      .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    await expect(call).rejects.toBeInstanceOf(UnpricedModel);
    await expect(call).rejects.toThrow(/free-model.*unpriced.*model_configs/s);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await rowsOfThisProject()).toHaveLength(0);
  });

  test("the guarded port has no call without a project", () => {
    const mock = stubModel({ doGenerate: textResult('{"greeting":"hi"}', { input: 1, output: 1 }) });
    const guarded = gateway("anthropic", model({}));

    expect("generateStructured" in guarded).toBe(false);
    const contextWithoutProject = { taskId: null, callSite: "liaison-intake" } as const;
    // @ts-expect-error LlmCallContext requires projectId: a call with no project does not typecheck
    guarded.forCall(contextWithoutProject);
    expect(mock.doGenerateCalls).toHaveLength(0);
  });
});

describe("generateTurn: one recorded single-step call per agent turn", () => {
  const READ_FILE = {
    description: "Read a file",
    inputSchema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] },
  };

  function toolCallResult(raw?: Record<string, number>) {
    return {
      content: [{ type: "tool-call" as const, toolCallId: "tc-1", toolName: "read_file", input: '{"path":"a.txt"}' }],
      usage: {
        inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: 50, reasoning: undefined },
        raw,
      },
      finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
      warnings: [],
    };
  }

  async function turnOn(gw: GuardedModelAccess) {
    const pinned = gw.resolveModel("Strong", "agent-runner");
    return gw.forCall({ projectId, taskId: null, callSite: "agent-runner" }).generateTurn({
      model: pinned,
      system: "You are a worker.",
      messages: [{ role: "user", content: "Read a.txt" }],
      tools: { read_file: READ_FILE },
      abortSignal: new AbortController().signal,
    });
  }

  test("a turn writes exactly one ok row with measured cost and returns the tool call unexecuted", async () => {
    await clearRows();
    const mock = stubModel({
      doGenerate: toolCallResult({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }),
    });

    const result = await turnOn(gateway("anthropic", model({ id: "turn-model" })));

    expect(mock.doGenerateCalls).toHaveLength(1);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { kind: "valid", toolCallId: "tc-1", toolName: "read_file", input: { path: "a.txt" } },
    ]);
    expect(result.assistant.role).toBe("assistant");
    const expectedCost = (100 * 3 + 900 * 0.3 + 50 * 15) / 1_000_000;
    expect(result.cost.measured && result.cost.totalCost).toBeCloseTo(expectedCost, 9);
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.callSite).toBe("agent-runner");
    expect(rows[0]?.model).toBe("turn-model");
    expect(rows[0]?.costUsd).toBeCloseTo(expectedCost, 9);
    expect(rows[0]).toMatchObject({ cacheReadTokens: 900, cacheWriteTokens: 0 });
    // The system prompt and the conversation's last message carry Anthropic cache breakpoints.
    const breakpoint = { anthropic: { cacheControl: { type: "ephemeral" } } };
    expect(mock.doGenerateCalls[0]?.prompt.map((message) => message.providerOptions)).toEqual([breakpoint, breakpoint]);
  });

  test("a turn's cost is the ledger's one measurement: the figure the row records, at the catalog's rates", async () => {
    await clearRows();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    // A Wednesday peak call to a windowed model with a cache-read class: every pricing input is in play.
    const windowed = model({
      id: "turn-windowed",
      cacheWriteCostPer1M: null,
      priceWindows: [{
        isoWeekday: 3,
        utcStartMinute: 600,
        utcEndMinute: 1440,
        rates: { inputCostPer1M: 1.5, outputCostPer1M: 7.5, cacheReadCostPer1M: 0.15, cacheWriteCostPer1M: null },
      }],
    });
    stubModel({ doGenerate: toolCallResult({ input_tokens: 1000, cache_read_input_tokens: 400 }) });

    const peak = await turnOn(gateway("anthropic", windowed, () => PEAK));
    const [peakRow] = await rowsOfThisProject();
    // The formula as it stood before the move: 600 plain input at 3, 400 cache reads at 0.30, 50 output at 15.
    const peakCost = (600 * 3 + 400 * 0.3 + 50 * 15) / 1_000_000;
    expect(peak.cost).toEqual(measureCost({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: null }, windowed, PEAK));
    expect(peak.cost.measured && peak.cost.totalCost).toBeCloseTo(peakCost, 12);
    expect(peakRow?.costUsd).toBeCloseTo(peakCost, 12);

    await clearRows();
    const offPeak = await turnOn(gateway("anthropic", windowed, () => OFF_PEAK));
    const [offPeakRow] = await rowsOfThisProject();
    const offPeakCost = (600 * 1.5 + 400 * 0.15 + 50 * 7.5) / 1_000_000;
    expect(offPeak.cost.measured && offPeak.cost.totalCost).toBeCloseTo(offPeakCost, 12);
    expect(offPeakRow?.costUsd).toBeCloseTo(offPeakCost, 12);

    await clearRows();
    stubModel({ doGenerate: toolCallResult() });
    const unmeasured = await turnOn(gateway("anthropic", model({ id: "turn-unreported" })));
    const [unmeasuredRow] = await rowsOfThisProject();
    expect(unmeasured.cost).toEqual({ measured: false, missingCounts: ["cacheReadTokens", "cacheWriteTokens"], missingRates: [] });
    expect(unmeasuredRow?.costUsd).toBeNull();
    const warned = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("cost unmeasured"));
    expect(warned).toEqual([expect.stringMatching(/^\[LlmCallLedger\] cost unmeasured: provider=anthropic, model=turn-unreported/)]);
  });

  test("a call to an undeclared tool comes back as an invalid call for the loop to answer, in one ok row", async () => {
    await clearRows();
    const call = { type: "tool-call" as const, toolCallId: "tc-x", toolName: "rm_rf", input: "{}" };
    stubModel({ doGenerate: { ...toolCallResult(), content: [call] } });

    const result = await turnOn(gateway("anthropic", model({})));

    expect(result.toolCalls).toEqual([
      expect.objectContaining({ kind: "invalid", toolCallId: "tc-x", toolName: "rm_rf", error: expect.stringMatching(/NoSuchTool/) }),
    ]);
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
  });

  test("a provider error writes one error row, with no retry and no fallback", async () => {
    await clearRows();
    const mock = stubModel({
      doGenerate: async () => {
        throw new Error("stub provider unavailable");
      },
    });

    await expect(turnOn(gateway("anthropic", model({})))).rejects.toThrow(/stub provider unavailable/);

    expect(mock.doGenerateCalls).toHaveLength(1);
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    expect(rows[0]?.costUsd).toBeNull();
  });

  test("a truncated turn maps to `truncated`; an `error` finish reason is a provider_error row", async () => {
    await clearRows();
    stubModel({ doGenerate: { ...toolCallResult(), finishReason: { unified: "length" as const, raw: "max_tokens" } } });
    expect((await turnOn(gateway("anthropic", model({})))).finishReason).toBe("truncated");

    await clearRows();
    stubModel({ doGenerate: { ...toolCallResult(), finishReason: { unified: "error" as const, raw: undefined } } });
    const errored = await turnOn(gateway("anthropic", model({})));
    expect(errored.finishReason).toBe("provider_error");
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    expect(rows[0]?.errorKind).toBe("FinishReason:error");
  });

  test("a tool with an execute function is refused before any request, and no row is written", async () => {
    await clearRows();
    const mock = stubModel({ doGenerate: toolCallResult() });
    const gw = gateway("anthropic", model({}));
    const executable = { ...READ_FILE, execute: async () => "ran" };

    const call = gw.forCall({ projectId, taskId: null, callSite: "agent-runner" }).generateTurn({
      model: gw.resolveModel("Strong", "agent-runner"),
      system: "s",
      messages: [{ role: "user", content: "u" }],
      // @ts-expect-error TurnToolSchema types `execute` as never: the gateway never runs a tool
      tools: { read_file: executable },
      abortSignal: new AbortController().signal,
    });

    await expect(call).rejects.toThrow(/execute function/);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await rowsOfThisProject()).toHaveLength(0);
  });
});

describe("one ladder attempt is one recorded, charged provider request", () => {
  function result(
    text: string,
    finishReason: "stop" | "length",
    output: number,
    raw: Record<string, number | Record<string, number>>,
  ) {
    return {
      content: text === "" ? [] : [{ type: "text" as const, text }],
      usage: {
        inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: output, text: undefined, reasoning: undefined },
        raw,
      },
      finishReason: { unified: finishReason, raw: finishReason },
      warnings: [],
    };
  }
  const DEEPSEEK_RAW = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 };

  test("a deepseek-type request carries thinking disabled by default and enabled where the policy says; others carry none", async () => {
    const ask = (gw: GuardedModelAccess, callSite: "decomposition" | "liaison-intake") =>
      gw.forCall({ projectId, taskId: null, callSite }).generateStructured({
        capability: "Strong",
        prompt: "greet",
        schema: GreetingSchema,
        maxTokens: 512,
        site: callSite,
      });
    const ok = result('{"greeting":"hi"}', "stop", 10, DEEPSEEK_RAW);
    const deepseek = model({ id: "ds-thinking", cacheWriteCostPer1M: null });

    let mock = stubModel({ doGenerate: ok });
    await ask(gateway("deepseek", deepseek), "decomposition");
    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({ deepseek: { thinking: { type: "disabled" } } });
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBe(512);

    mock = stubModel({ doGenerate: ok });
    const policy = { default: "off" as const, sites: { "liaison-intake": "on" as const } };
    await ask(gateway("deepseek", deepseek, () => PEAK, policy), "liaison-intake");
    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({ deepseek: { thinking: { type: "enabled" } } });
    // Thinking on: the bound sent covers reasoning on top of the caller's 512 answer tokens.
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBeGreaterThan(512);

    mock = stubModel({ doGenerate: ok });
    await ask(gateway("anthropic", model({}), () => PEAK, policy), "liaison-intake");
    expect(mock.doGenerateCalls[0]?.providerOptions).toBeUndefined();
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBe(512);
  });

  test("with thinking on, the spend cap prices the worst case from the larger bound that is sent", async () => {
    await clearRows();
    // $1,000 per 1M output tokens: 512 answer tokens fit a $1 project cap; 512 plus a reasoning allowance do not.
    const deepseek = model({ id: "ds-bound", provider: "deepseek", outputCostPer1M: 1_000, cacheWriteCostPer1M: null });
    const underCap = (thinking: "on" | "off") =>
      new GuardedModelAccess(buildGateway({
        models: sdkLanguageModels,
        config: {
          providers: [
            { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [deepseek], enabled: true },
          ],
          defaultProvider: "deepseek",
          thinking: { default: thinking, sites: {} },
        },
        checkedSources: ["test"],
        clock: () => PEAK,
      }), new LlmCallLedger(
        calls,
        new SpendCap({ ledger: calls, projects: new ProjectRepository(db), caps: { deploymentUsd: 1e6, perProjectUsd: 1 } }),
      ))
        .forCall({ projectId, taskId: null, callSite: "decomposition" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    const mock = stubModel({ doGenerate: result('{"greeting":"hi"}', "stop", 10, DEEPSEEK_RAW) });
    await expect(underCap("on")).rejects.toThrow(BudgetExceeded);
    expect(mock.doGenerateCalls).toHaveLength(0);
    await expect(underCap("off")).resolves.toMatchObject({ data: { greeting: "hi" } });
    expect(mock.doGenerateCalls).toHaveLength(1);
    await clearRows();
  });

  test("empty text at finish reason length is a 'truncated' error row with its reasoning tokens, never ok", async () => {
    await clearRows();
    const raw = { ...DEEPSEEK_RAW, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } };
    stubModel({ doGenerate: result("", "length", 4096, raw) });

    await expect(
      gateway("deepseek", model({ id: "ds-truncated", cacheWriteCostPer1M: null }))
        .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 4096 }),
    ).rejects.toMatchObject({
      name: "StructuredOutputTruncated",
      maxTokens: 4096,
      reasoningAllowance: 0,
      reasoningTokens: 4096,
      textLength: 0,
      message: expect.stringMatching(/the whole bound went to reasoning/),
    });

    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "error",
      errorKind: "truncated",
      finishReason: "length",
      outputTokens: 4096,
      reasoningTokens: 4096,
    });
  });

  test("a truncation sent with thinking on reports the bound it was sent with and the reasoning allowance in it", async () => {
    await clearRows();
    const raw = { ...DEEPSEEK_RAW, completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 9000 } };
    const mock = stubModel({ doGenerate: result("", "length", 9000, raw) });
    const thinkingOn = { default: "on" as const, sites: {} };

    const failure = await gateway("deepseek", model({ id: "ds-truncated-on", cacheWriteCostPer1M: null }), () => PEAK, thinkingOn)
      .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 4096 })
      .then(
        () => expect.unreachable("a truncated call must not succeed"),
        (error: unknown) => error,
      );

    const sent = mock.doGenerateCalls[0]?.maxOutputTokens;
    expect(failure).toMatchObject({ name: "StructuredOutputTruncated", maxTokens: sent, reasoningAllowance: (sent ?? 0) - 4096 });
    expect(sent).toBeGreaterThan(4096);
    await clearRows();
  });

  test("a failed generateObject is recorded at what the provider billed", async () => {
    await clearRows();
    const anthropicRaw = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    stubModel({ doGenerate: result('{"greeting": "cut off', "length", 4096, anthropicRaw) });
    const gw = gateway("anthropic", model({ id: "sonnet-like" }));

    await expect(
      gw.forCall({ projectId, taskId: null, callSite: "decomposition" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 4096 }),
    ).rejects.toMatchObject({ name: "StructuredOutputTruncated" });

    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "error", errorKind: "truncated", finishReason: "length" });
    const recorded = rows.reduce((sum, row) => sum + (row.costUsd ?? Number.NaN), 0);
    expect(recorded).toBeCloseTo((1000 * 3 + 4096 * 15) / 1_000_000, 6);
  });

  test("every ladder attempt sends exactly one provider request and writes one row", async () => {
    await clearRows();
    const mock = stubModel({ doGenerate: result("not json", "stop", 5, DEEPSEEK_RAW) });
    const attempts: LadderAttemptEvent[] = [];
    // Frontier serves both the Strong base tier and the Frontier escalation tier.
    const gw = gateway("deepseek", model({ id: "ds-ladder", capabilityLevel: "Frontier", cacheWriteCostPer1M: null }));
    const laddered = withStructuredLadder(gw.forCall({ projectId, taskId: null, callSite: "decomposition" }), {
      site: "decomposition",
      attempts: 2,
      onAttempt: (event) => attempts.push(event),
    });

    await expect(
      laddered.generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 }),
    ).rejects.toThrow(/Structured output exhausted/);

    expect(attempts).toHaveLength(4);
    expect(mock.doGenerateCalls).toHaveLength(attempts.length);
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(attempts.length);
    expect(rows.every((row) => row.errorKind === "InvalidJson" && row.finishReason === "stop")).toBe(true);
    // Fourth run N17: a failed attempt's event recorded "unknown" while its llm_calls row had the model.
    expect(attempts.map((a) => a.model)).toEqual(rows.map((row) => row.model));
    expect(rows.every((row) => row.model === "ds-ladder")).toBe(true);
  });

  test("text cut off at length is never closed into acceptance: every ladder attempt is a truncated row", async () => {
    await clearRows();
    // Closing the brace would make this valid against GreetingSchema.
    const mock = stubModel({ doGenerate: result('{"greeting":"hi"', "length", 512, DEEPSEEK_RAW) });
    const attempts: LadderAttemptEvent[] = [];
    const gw = gateway("deepseek", model({ id: "ds-cut", capabilityLevel: "Frontier", cacheWriteCostPer1M: null }));
    const laddered = withStructuredLadder(gw.forCall({ projectId, taskId: null, callSite: "decomposition" }), {
      site: "decomposition",
      attempts: 2,
      onAttempt: (event) => attempts.push(event),
    });

    await expect(
      laddered.generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 }),
    ).rejects.toThrow(/Structured output exhausted.*output truncated/);

    expect(attempts.map((a) => `${a.capability}:${a.outcome}`)).toEqual([
      "Strong:invalid",
      "Strong:invalid",
      "Frontier:invalid",
      "Frontier:invalid",
    ]);
    expect(mock.doGenerateCalls).toHaveLength(4);
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.errorKind === "truncated" && row.finishReason === "length")).toBe(true);
  });

  test("a generateObject response at length is truncated even when its text parses", async () => {
    await clearRows();
    const anthropicRaw = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    stubModel({ doGenerate: result('{"greeting":"hi"}', "length", 512, anthropicRaw) });

    await expect(
      gateway("anthropic", model({ id: "sonnet-cut" }))
        .forCall({ projectId, taskId: null, callSite: "decomposition" })
        .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 }),
    ).rejects.toMatchObject({ name: "StructuredOutputTruncated" });

    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "error", errorKind: "truncated", finishReason: "length" });
  });

  test("a fenced, complete JSON response still parses into one ok row", async () => {
    await clearRows();
    stubModel({ doGenerate: result('```json\n{"greeting":"hi"}\n```', "stop", 10, DEEPSEEK_RAW) });

    const response = await gateway("deepseek", model({ id: "ds-fenced", cacheWriteCostPer1M: null }))
      .forCall({ projectId, taskId: null, callSite: "decomposition" })
      .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 512 });

    expect(response.data).toEqual({ greeting: "hi" });
    const rows = await rowsOfThisProject();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "ok", finishReason: "stop" });
  });
});
