import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PodmanSubstrate, createCellBackend, loadBaseCell } from "@ashara/execution-infra";
import { GuardedModelAccess, measureCost } from "@ashara/finance";
import type { LlmCallRecorder, LlmProviderCall } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { runAttempt } from "@ashara/workplace";
import type { AttemptRecord } from "@ashara/workplace";
import { testCellInstance } from "../test-cells.js";

// Real podman cell from the BaseCell image, real gateway, mock model: no real LLM call, no skip
// (CI rejects skipped tests). The recorder is in memory: it counts the rows the gateway would write.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const modelConfig: ModelConfig = {
  id: "mock-model",
  apiModelId: "mock-model-api",
  provider: "anthropic",
  capabilityLevel: "Strong",
  inputCostPer1M: 3,
  outputCostPer1M: 15,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: 0.3,
  cacheWriteCostPer1M: 3.75,
  priceWindows: [], priceTiers: [],
};

function toolCallTurn(toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName, input: JSON.stringify(input) }],
    usage: {
      inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: 50, reasoning: undefined },
      raw: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    warnings: [],
  };
}

const instance = testCellInstance();
let workspace = "";
let substrate: PodmanSubstrate;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "ashara-workplace-"));
  substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: tmpdir() });
}, 60_000);

afterAll(async () => {
  await substrate.teardownAll();
  await rm(workspace, { recursive: true, force: true });
}, 60_000);

describe("runAttempt on a real cell", () => {
  it("writes a file and runs a command inside the cell, one recorded call per turn", async () => {
    const script = [
      toolCallTurn("write_file", { path: "src/hello.txt", content: "hello from the cell\n" }),
      toolCallTurn("run_command", { command: "test -f src/hello.txt && wc -c < src/hello.txt" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote src/hello.txt." }),
    ];
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        const next = script.shift();
        if (next === undefined) throw new Error("the mock model's script is exhausted");
        return next;
      },
    });
    stub.model = mock;

    const rows: LlmProviderCall[] = [];
    const recorder: LlmCallRecorder = {
      admit: async () => {},
      record: async (call) => {
        rows.push(call);
        if (call.usage === null) return { measured: false, missingCounts: [], missingRates: [] };
        return measureCost(call.usage.reported, call.model, call.requestedAt);
      },
    };
    const gateway = new GuardedModelAccess(buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          { name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true },
        ],
        defaultProvider: "anthropic",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }), recorder);

    const base = await loadBaseCell();
    const taskId = createWorkItemId();
    const cell = await substrate.createCell({ image: base.image, project: "proj-workplace-test", task: taskId, role: "worker", instance, mount: { hostPath: workspace } });
    const records: AttemptRecord[] = [];
    try {
      const outcome = await runAttempt(
        {
          projectId: parseProjectId("00000000-0000-4000-8000-000000000002", "test"),
          taskId,
          role: { id: "worker", name: "Worker" },
          toolProfile: "run-and-dispute-checks",
          charter: { identity: "You are a coding agent.", duties: null },
          model: gateway.resolveModel("Strong", "agent-runner"),
          cellImage: { kind: "base-cell", image: "base@sha256:0000000000000000000000000000000000000000000000000000000000000000", digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
          brief: {
            goal: "Write src/hello.txt",
            intent: "A greeting file",
            visionVersion: 1,
            assumptions: [],
            projectEnvironment: { kind: "to-define" },
            context: "An empty workspace.",
            deliverables: ["src/hello.txt"],
          },
          limits: { maxTurns: 5, perCommandTimeoutSeconds: 30 },
        },
        {
          llm: gateway,
          cell: createCellBackend(cell, { toolTimeoutSeconds: 30 }),
          clock: { now: () => Date.now() },
          records: { append: async (record) => void records.push(record) },
          signal: new AbortController().signal,
          environment: null,
          checks: null,
          taskChecks: null,
        },
      );

      expect(outcome).toMatchObject({ kind: "finished", status: "done", turnsUsed: 3 });
      expect(outcome.cost.measured).toBe(true);
      expect(await readFile(join(workspace, "src", "hello.txt"), "utf8")).toBe("hello from the cell\n");
      const runResult = records.find((r) => r.kind === "tool_result" && r.toolName === "run_command");
      expect(runResult).toMatchObject({ isError: false, output: "Exit code: 0\nSTDOUT:\n20\n" });
      expect(mock.doGenerateCalls).toHaveLength(3);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.context.taskId === taskId && row.context.callSite === "agent-runner" && row.operation === "generateText:turn")).toBe(true);
    } finally {
      await cell.teardown();
    }
  });
});
