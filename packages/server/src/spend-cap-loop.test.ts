import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { ContinuousRunner, CoreLoop } from "@ashara/orchestrator";
import type { CoreLoopDeps } from "@ashara/orchestrator";

// The deployment cap end to end: Finance refuses an LLM call made inside a loop
// step, and the runner stops with the stated reason. Against Postgres; no real
// LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME = `spend-cap-loop-test-${randomUUID().slice(0, 8)}`;

const MODEL: ModelConfig = {
  id: "spend-cap-loop-model",
  apiModelId: "spend-cap-loop-model",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [],
};

type Db = ReturnType<typeof createDb>;
let db: Db;

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (SELECT id FROM projects WHERE name = ${NAME})`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${NAME}`);
  await db.$client.end();
});

describe("the deployment spend cap stops the loop", () => {
  test("a step's call refused at the deployment cap ends the run with the cap's reason, and the provider is never called", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectRepository(db);
    const client = await new ClientRepository(db).create(NAME);
    const projectId = (await projects.create(NAME, client.id)).id;
    const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("the provider must not be called"); } });
    stub.model = mock;

    // No call fits under this cap, whatever other suites add to or delete from llm_calls meanwhile.
    const capUsd = 1e-9;
    const spendCap = new SpendCap({ ledger: calls, projects, caps: { deploymentUsd: capUsd, perProjectUsd: capUsd } });
    const gateway: LLMGateway = buildGateway({
      config: {
        providers: [
          { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true },
        ],
        defaultProvider: "deepseek",
      },
      checkedSources: ["test"],
      recording: { kind: "recorded", recorder: new LlmCallLedger(calls, spendCap) },
      clock: () => new Date(),
    });

    const intake = vi.fn(async () => {
      await gateway
        .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
        .generateStructured({ capability: "Strong", prompt: "read", schema: z.object({ ok: z.boolean() }), maxTokens: 64 });
      return [];
    });
    const roster = vi.fn(async () => []);
    // Only the steps this cycle reaches are real; anything else fails loudly.
    const deps = {
      clientStops: { runPending: async () => [] },
      stackChoices: { runPending: async () => [] },
      liaisonIntake: { runPending: intake },
      rosterDerivation: { runPending: roster },
      firstPlanning: { runPending: notExercised("firstPlanning") },
      planReports: { runPending: notExercised("planReports") },
      spendCap: {
        deploymentStop: async () => {
          const stop = await spendCap.deploymentStop();
          // The first check, before intake, must let the step run so its refusal is what stops the loop.
          return intake.mock.calls.length === 0 ? null : stop;
        },
        refusalOf: (error: unknown) => spendCap.refusalOf(error),
      },
    } as unknown as CoreLoopDeps;

    const stop = await new ContinuousRunner(new CoreLoop(deps)).run(new AbortController().signal);

    expect(intake).toHaveBeenCalledTimes(1);
    expect(roster).not.toHaveBeenCalled();
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(stop?.reason).toMatch(/^budget_cap: the spend cap of the deployment/);
  });
});
