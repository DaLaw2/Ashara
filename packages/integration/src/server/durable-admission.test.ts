import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, LlmCallRepository, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { recordingLogger } from "@ashara/shared";

// An admitted call's estimate is durable: a process that dies between a call's
// admission and its record leaves a row the next process still counts. Against Postgres; no real
// LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `durable-admission-test-${randomUUID().slice(0, 8)}`;

const MODEL: ModelConfig = {
  id: "durable-admission-model",
  apiModelId: "durable-admission-model",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [],
  priceTiers: [], datedPrices: [],
};

type Db = ReturnType<typeof createDb>;
let db: Db;
let calls: LlmCallRepository;
let projects: ProjectRepository;
let clientId: string;

/** One server process: its own SpendCap and ledger, nothing in memory shared with another. */
function serverProcess(perProjectUsd: number): { readonly gateway: GuardedModelAccess; readonly ledger: LlmCallLedger } {
  const cap = new SpendCap({ ledger: calls, caps: { deploymentUsd: 1e6, perProjectUsd } });
  const ledger = new LlmCallLedger(calls, cap);
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true },
      ],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), ledger, recordingLogger());
  return { gateway, ledger };
}

function greet(gateway: GuardedModelAccess, projectId: Awaited<ReturnType<ProjectRepository["create"]>>["id"]) {
  return gateway
    .forCall({ projectId, taskId: null, callSite: "decomposition" })
    .generateStructured({ capability: "Strong", prompt: "greet", schema: z.object({ greeting: z.string() }), maxTokens: 64 });
}

const RowSchema = z.object({ state: z.string(), costUsd: z.number().nullable(), estimatedCostUsd: z.number(), outcome: z.string().nullable() });

async function rowsOf(projectId: string): Promise<z.infer<typeof RowSchema>[]> {
  const result = await db.execute(sql`
    SELECT state, cost_usd::float8 AS "costUsd", estimated_cost_usd::float8 AS "estimatedCostUsd", outcome
    FROM llm_calls WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(RowSchema).parse(result.rows);
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("an admitted call's estimate survives the process that admitted it", () => {
  test("a crash between admission and record: after the restart the cap still counts the call at its estimate", async () => {
    const projectId = (await projects.create(NAME, clientId)).id;
    // The provider request is sent and never answers: the process dies with the call in flight.
    let sent = 0;
    stub.model = new MockLanguageModelV4({
      doGenerate: () => {
        sent += 1;
        return new Promise<never>(() => {});
      },
    });
    const dying = serverProcess(1e6);
    void greet(dying.gateway, projectId);
    await vi.waitFor(() => expect(sent).toBe(1));
    const [admitted] = await rowsOf(projectId);
    expect(admitted).toMatchObject({ state: "pending", costUsd: null, outcome: null });
    const estimate = admitted?.estimatedCostUsd ?? Number.NaN;
    expect(estimate).toBeGreaterThan(0);

    // The restart: a new process, room for one more worst case on its own but not on top of the lost call's.
    const restarted = serverProcess(estimate * 1.5);
    await restarted.ledger.reconcileAtStartup();
    expect(await rowsOf(projectId)).toEqual([{ state: "unmeasured_after_crash", costUsd: null, estimatedCostUsd: estimate, outcome: null }]);
    expect(await calls.spend({ kind: "project", projectId })).toEqual({ recordedUsd: estimate, inFlightUsd: 0 });
    stub.model = new MockLanguageModelV4({
      doGenerate: () => {
        sent += 1;
        return new Promise<never>(() => {});
      },
    });
    await expect(greet(restarted.gateway, projectId)).rejects.toMatchObject({ name: "BudgetExceeded", scope: { kind: "project", projectId } });
    expect(sent).toBe(1);
  });
});
