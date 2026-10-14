import { describe, expect, test } from "vitest";
import type { TaskDescriptor } from "@ashara/development";
import { buildGateway, sdkLanguageModels } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import type { CapabilityLevel, StoredTaskSpec } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { determineCapability } from "./task-capability.js";

const projectId = parseProjectId("22222222-2222-4222-8222-222222222222", "test");

const task = (taskSpec: StoredTaskSpec | undefined): TaskDescriptor => ({
  id: createWorkItemId(), projectId, title: "t", dispatchCount: 0, attempt: 1, successCriteria: [], workKind: "implementation",
  taskSpec,
});

function model(id: string, capabilityLevel: CapabilityLevel, outputCostPer1M: number): ModelConfig {
  return {
    id, apiModelId: id, provider: "deepseek", capabilityLevel, inputCostPer1M: 1, outputCostPer1M,
    maxContextTokens: 100_000, cacheReadCostPer1M: null, cacheWriteCostPer1M: null, priceWindows: [], priceTiers: [],
  };
}

// No routing profile for the combo: agent-runner requests take capability logic (findBestModel).
const gateway = buildGateway({
  models: sdkLanguageModels,
  config: {
    providers: [{
      name: "deepseek", providerType: "deepseek", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", enabled: true,
      models: [model("m-light", "Light", 1), model("m-medium", "Medium", 2), model("m-frontier", "Frontier", 8)],
    }],
    defaultProvider: "deepseek",
  },
  checkedSources: ["test"],
  recording: { kind: "unrecorded", reason: "resolution only: no call is made" },
  clock: () => new Date(),
});

describe("an attempt's model follows the planner's grade (ADR-074 addendum 2 d70)", () => {
  test.each([
    ["Light", "m-light"],
    ["Medium", "m-medium"],
    // No Strong model in the catalog: the lowest level at or above it.
    ["Strong", "m-frontier"],
  ] as const)("a task graded %s is staffed with %s", (grade, modelId) => {
    const capability = determineCapability(task({ origin: "decomposition", capability: grade }));
    expect(capability).toBe(grade);
    expect(gateway.resolveModel(capability, "agent-runner").modelId).toBe(modelId);
  });

  test("a task with no grade is refused with a typed error, never staffed at an assumed level", () => {
    for (const spec of [undefined, { origin: "environment-change" as const }]) {
      expect(() => determineCapability(task(spec))).toThrow(expect.objectContaining({ name: "TaskCapabilityUngraded" }));
    }
    expect(() => determineCapability(task({ origin: "check" }))).toThrow(/origin check.*no capability level/);
  });

  test("a redispatch with no escalating failure keeps the grade", () => {
    expect(determineCapability({ ...task({ capability: "Light" }), dispatchCount: 3 })).toBe("Light");
  });
});
