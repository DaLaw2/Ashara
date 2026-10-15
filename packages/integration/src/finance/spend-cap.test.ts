import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { BudgetExceeded, GuardedModelAccess, LlmCallLedger, SpendCap, worstCaseCostUsd } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";

// Against Postgres: every row belongs to a project this suite creates under a
// unique name, and afterAll deletes exactly those rows. No real LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);
const NAME = `spend-cap-test-${NONCE}`;
const LARGE = 1e6;

type Db = ReturnType<typeof createDb>;
type ProjectId = Awaited<ReturnType<ProjectRepository["create"]>>["id"];
let db: Db;
let calls: LlmCallRepository;
let projects: ProjectRepository;
let clientId: string;

const GreetingSchema = z.object({ greeting: z.string() });

const MODEL: ModelConfig = {
  id: "spend-cap-model",
  apiModelId: "spend-cap-model",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [], priceTiers: [],
};

function stubModel(usage: { input: number | undefined; output: number | undefined }): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text" as const, text: '{"greeting":"hi"}' }],
      usage: {
        inputTokens: { total: usage.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
        raw: undefined,
      },
      finishReason: { unified: "stop" as const, raw: "stop" },
      warnings: [],
    },
  });
  stub.model = mock;
  return mock;
}

/** One server process: its own SpendCap, so nothing in memory carries over from another. */
function processWithCaps(caps: ConstructorParameters<typeof SpendCap>[0]["caps"]): { readonly gateway: GuardedModelAccess; readonly cap: SpendCap } {
  const cap = new SpendCap({ ledger: calls, caps });
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true },
      ],
      defaultProvider: "deepseek",
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(calls, cap));
  return { gateway, cap };
}

function greet(gateway: GuardedModelAccess, projectId: ProjectId) {
  return gateway
    .forCall({ projectId, taskId: null, callSite: "decomposition" })
    .generateStructured({ capability: "Strong", prompt: "greet", schema: GreetingSchema, maxTokens: 64 });
}

async function newProject(): Promise<ProjectId> {
  return (await projects.create(NAME, clientId)).id;
}

const RowSchema = z.object({
  costUsd: z.number().nullable(),
  estimatedCostUsd: z.number(),
});

async function rowsOf(projectId: ProjectId): Promise<z.infer<typeof RowSchema>[]> {
  const result = await db.execute(sql`
    SELECT cost_usd::float8 AS "costUsd", estimated_cost_usd::float8 AS "estimatedCostUsd"
    FROM llm_calls WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(RowSchema).parse(result.rows);
}

const ProjectRowSchema = z.object({
  status: z.string(),
  blockedErrorClass: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

async function projectRow(projectId: ProjectId): Promise<z.infer<typeof ProjectRowSchema>> {
  const result = await db.execute(sql`
    SELECT status, blocked_error_class AS "blockedErrorClass", blocked_reason AS "blockedReason"
    FROM projects WHERE id = ${projectId}`);
  return ProjectRowSchema.parse(result.rows[0]);
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  calls = new LlmCallRepository(db);
  projects = new ProjectRepository(db);
  clientId = (await new ClientRepository(db).create(NAME)).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (SELECT id FROM projects WHERE name = ${NAME})`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${NAME}`);
  await db.$client.end();
});

describe("worstCaseCostUsd", () => {
  test("prices at the highest prompt-length tier: an estimate is a cap, never the base price", () => {
    const tiered: ModelConfig = {
      ...MODEL,
      priceTiers: [{ minInputTokens: 272_001, rates: { inputCostPer1M: 2, outputCostPer1M: 15, cacheReadCostPer1M: null, cacheWriteCostPer1M: null } }],
    };
    // 1,000 bytes plus 1,024 framing tokens of input, 100 output tokens.
    expect(worstCaseCostUsd(tiered, 1_000, 100)).toBeCloseTo((2_024 * 2 + 100 * 15) / 1_000_000, 12);
    expect(worstCaseCostUsd(MODEL, 1_000, 100)).toBeCloseTo((2_024 * 1 + 100 * 10) / 1_000_000, 12);
  });
});

describe("Finance's spend cap, read from llm_calls", () => {
  test("spend survives a restart: a new process refuses a call the earlier process's spend leaves no room for", async () => {
    const projectId = await newProject();
    const mock = stubModel({ input: 1000, output: 40 });
    await greet(processWithCaps({ deploymentUsd: LARGE, perProjectUsd: LARGE }).gateway, projectId);
    const [first] = await rowsOf(projectId);
    expect(first?.costUsd).toBeCloseTo((1000 * 1 + 40 * 10) / 1_000_000, 12);
    const spent = first?.costUsd ?? Number.NaN;
    const estimate = first?.estimatedCostUsd ?? Number.NaN;

    // The restarted process: same call, a cap that holds its estimate alone but not on top of the spend.
    const restarted = processWithCaps({ deploymentUsd: LARGE, perProjectUsd: spent + estimate / 2 });
    await expect(greet(restarted.gateway, projectId)).rejects.toMatchObject({
      name: "BudgetExceeded",
      scope: { kind: "project", projectId },
    });
    expect(mock.doGenerateCalls).toHaveLength(1);
  });

  test("a call whose estimate would cross the project cap is refused before the provider is called; Finance only refuses, it halts nothing", async () => {
    const projectId = await newProject();
    const mock = stubModel({ input: 1000, output: 40 });
    const { gateway, cap } = processWithCaps({ deploymentUsd: LARGE, perProjectUsd: 1e-9 });

    const refusal = await greet(gateway, projectId).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(BudgetExceeded);
    expect(cap.refusalOf(refusal)).toMatchObject({ kind: "project", projectId });
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await rowsOf(projectId)).toHaveLength(0);
    // The project's halt at its cap is Delivery's (O3 c), which blocks with the refusal's reason.
    expect((await projectRow(projectId)).status).toBe("active");
    if (!(refusal instanceof BudgetExceeded)) throw new Error("expected a BudgetExceeded refusal");
    expect(refusal.message).toMatch(/^budget_cap: the spend cap of project /);
    // The reason names the one exit migration 040 leaves: a bare status UPDATE is refused.
    expect(refusal.message).toContain(`scripts/project.ts unblock ${projectId}`);
    expect(refusal.message).not.toContain("UPDATE projects");
  });

  test("an unmeasured call (cost_usd NULL) counts at its recorded estimate, never $0, and is logged at warn", async () => {
    const projectId = await newProject();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    stubModel({ input: undefined, output: undefined });

    await greet(processWithCaps({ deploymentUsd: LARGE, perProjectUsd: LARGE }).gateway, projectId);

    const [row] = await rowsOf(projectId);
    expect(row?.costUsd).toBeNull();
    expect(row?.estimatedCostUsd).toBeGreaterThan(0);
    const spend = await calls.spend({ kind: "project", projectId });
    expect(spend.recordedUsd).toBeCloseTo(row?.estimatedCostUsd ?? Number.NaN, 12);
    expect(spend.inFlightUsd).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/spend cap counts the call at its estimate/));
  });

  test("the deployment cap refuses a call without blocking its project, and stops the loop from then on", async () => {
    const projectId = await newProject();
    const mock = stubModel({ input: 1000, output: 40 });
    await greet(processWithCaps({ deploymentUsd: LARGE, perProjectUsd: LARGE }).gateway, projectId);

    // Other suites add and delete llm_calls rows concurrently, so the deployment's
    // total moves; a cap far below this suite's own row holds whatever they do.
    const tiny = { deploymentUsd: 1e-9, perProjectUsd: 1e-9 };
    const { gateway, cap } = processWithCaps(tiny);
    await expect(greet(gateway, projectId)).rejects.toMatchObject({ name: "BudgetExceeded", scope: { kind: "deployment" } });

    expect(mock.doGenerateCalls).toHaveLength(1);
    expect((await projectRow(projectId)).status).toBe("active");
    expect((await cap.deploymentStop())?.reason).toMatch(/^budget_cap: the spend cap of the deployment/);
    // A fresh process at the same cap stops before any call: recorded spend is at the cap.
    const fresh = processWithCaps(tiny);
    expect((await fresh.cap.deploymentStop())?.reason).toMatch(/^budget_cap: the deployment has spent/);
  });

  test("an admitted call is a pending row from its admission on: another process's admission counts it", async () => {
    const projectId = await newProject();
    const pending = {
      callId: randomUUID(),
      context: { projectId, taskId: null, callSite: "decomposition" as const },
      provider: "deepseek",
      model: MODEL,
      operation: "generateObject" as const,
      requestBytes: 1_000,
      maxOutputTokens: 100,
    };
    const estimate = worstCaseCostUsd(MODEL, 1_000, 100);
    const caps = { deploymentUsd: LARGE, perProjectUsd: estimate * 1.5 };

    await processWithCaps(caps).cap.admit(pending);

    const [row] = await rowsOf(projectId);
    expect(row).toEqual({ costUsd: null, estimatedCostUsd: expect.closeTo(estimate, 12) });
    expect(await calls.spend({ kind: "project", projectId })).toEqual({ recordedUsd: 0, inFlightUsd: expect.closeTo(estimate, 12) });
    // A process with nothing in memory refuses a second worst case on the same headroom.
    await expect(processWithCaps(caps).cap.admit({ ...pending, callId: randomUUID() })).rejects.toMatchObject({
      name: "BudgetExceeded",
      scope: { kind: "project", projectId },
      inFlightUsd: expect.closeTo(estimate, 12),
    });
  });

  test("concurrent calls cannot each spend the same headroom", async () => {
    const projectId = await newProject();
    stubModel({ input: 1000, output: 40 });
    await greet(processWithCaps({ deploymentUsd: LARGE, perProjectUsd: LARGE }).gateway, projectId);
    const [first] = await rowsOf(projectId);
    const estimate = first?.estimatedCostUsd ?? Number.NaN;
    const spent = first?.costUsd ?? Number.NaN;

    // Room for one more worst case, not two.
    const { gateway } = processWithCaps({ deploymentUsd: LARGE, perProjectUsd: spent + estimate * 1.5 });
    const settled = await Promise.allSettled([greet(gateway, projectId), greet(gateway, projectId)]);

    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});
