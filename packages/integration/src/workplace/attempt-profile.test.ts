import { describe, expect, it } from "vitest";
import type { CellBackend } from "@ashara/execution-infra";
import type { ContextualTurnLlm, CostedTurnResult } from "@ashara/finance";
import { attemptProfileOf } from "@ashara/delivery";
import type { ResolvedModel } from "@ashara/model-access";
import { WORK_KINDS } from "@ashara/organization";
import type { WorkKind } from "@ashara/organization";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { runAttempt } from "@ashara/workplace";
import type { CheckDefinitionPort, EnvironmentCheckPort, TaskCheckRunPort } from "@ashara/workplace";

type Assignment = Parameters<typeof runAttempt>[0];
type AttemptDeps = Parameters<typeof runAttempt>[1];
type TurnRequest = Parameters<ReturnType<ContextualTurnLlm["forCall"]>["generateTurn"]>[0];

const STOPPED: CostedTurnResult = {
  assistant: { role: "assistant", content: [{ type: "text", text: "stop" }] },
  text: "stop",
  toolCalls: [],
  finishReason: "stop",
  rawFinishReason: null,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  reportedOutputTokens: 1,
  cost: { measured: true, inputCost: 0, outputCost: 0, cacheSavings: 0, totalCost: 0 },
  provider: "fake",
  model: "fake-model",
};

const model: ResolvedModel = {
  model: "fake-model",
  modelId: "fake-model",
  provider: "fake",
  effectiveCapability: "Strong",
  modelConfig: {
    id: "fake-model",
    apiModelId: "fake-model",
    provider: "fake",
    capabilityLevel: "Strong",
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
    priceTiers: [],
  },
};

function unused(what: string): never {
  throw new Error(`${what} is not called by an attempt that stops on its first turn`);
}

const cell: CellBackend = {
  readFile: () => unused("readFile"),
  writeFile: () => unused("writeFile"),
  listDirectory: () => unused("listDirectory"),
  search: () => unused("search"),
  run: () => unused("run"),
};
const environment: EnvironmentCheckPort = { check: () => unused("environment.check") };
const checks: CheckDefinitionPort = {
  fileWritten: () => unused("checks.fileWritten"),
  define: () => unused("checks.define"),
  probe: () => unused("checks.probe"),
};
const taskChecks: TaskCheckRunPort = { checkNames: ["c1"], mergedChecks: [], run: () => unused("taskChecks.run") };

const BRIEFS: Readonly<Record<string, Assignment["brief"]>> = {
  plain: {
    goal: "Write hello.txt",
    intent: "A greeting file",
    visionVersion: 1,
    assumptions: [],
    projectEnvironment: { kind: "to-define" },
    context: "An empty workspace.",
    deliverables: ["hello.txt"],
  },
  protected: {
    goal: "Print the total",
    intent: "Monthly totals of a CSV of expenses",
    visionVersion: 2,
    assumptions: [{ key: "A1", statement: "Amounts are in cents", note: "stated" }],
    projectEnvironment: { kind: "defined", version: "a".repeat(64), statement: "The team chose a stack." },
    context: "The project as it stands.",
    deliverables: [],
    priorAttemptFailure: "The last attempt failed.",
    knowledgeContext: "A lesson.",
    contextMap: "src/\n  main",
    protectedPaths: { recipe: ["environment/environment.toml"], checkFiles: ["checks/c1.sh"], inputs: ["manifest"] },
  },
  "protected, nothing stored": {
    goal: "Print the total",
    intent: "Monthly totals",
    visionVersion: 1,
    assumptions: [],
    projectEnvironment: { kind: "to-define" },
    context: "Nothing yet.",
    deliverables: ["total"],
    protectedPaths: { recipe: ["environment/environment.toml"], checkFiles: [], inputs: [] },
  },
};

/** The assignment Delivery's dispatch hands Workplace for a task of this work kind. */
function assignmentFor(workKind: WorkKind | null, brief: Assignment["brief"]): Assignment {
  return {
    projectId: parseProjectId("00000000-0000-4000-8000-000000000001", "test"),
    taskId: createWorkItemId(),
    role: { id: "worker", name: "Worker" },
    ...attemptProfileOf(workKind),
    brief,
    model,
    cellImage: { kind: "base-cell", image: "base@sha256:" + "0".repeat(64), digest: "sha256:" + "0".repeat(64) },
    limits: { maxTurns: 2, perCommandTimeoutSeconds: 60 },
  };
}

interface Sent {
  readonly granted: boolean;
  readonly system?: string;
  readonly tools?: string;
}

async function firstCall(assignment: Assignment, ports: Pick<AttemptDeps, "environment" | "checks" | "taskChecks">): Promise<Sent> {
  const requests: TurnRequest[] = [];
  const llm: ContextualTurnLlm = {
    forCall: () => ({
      async generateTurn(request) {
        requests.push(request);
        return STOPPED;
      },
    }),
  };
  const deps: AttemptDeps = {
    llm,
    cell,
    clock: { now: () => 0 },
    records: { append: async () => {} },
    signal: new AbortController().signal,
    ...ports,
  };
  try {
    await runAttempt(assignment, deps);
  } catch (err) {
    if (err instanceof Error && err.name === "InvalidAssignment") return { granted: false };
    throw err;
  }
  const [sent] = requests;
  if (sent === undefined) throw new Error("the attempt made no model call");
  return { granted: true, system: sent.system, tools: JSON.stringify(sent.tools) };
}

const PORT_SETS = [false, true].flatMap((env) =>
  [false, true].flatMap((chk) =>
    [false, true].map((run) => ({
      label: `environment=${env} checks=${chk} taskChecks=${run}`,
      ports: { environment: env ? environment : null, checks: chk ? checks : null, taskChecks: run ? taskChecks : null },
    })),
  ),
);

describe("an attempt per work kind: the prompt, the tools and the port grants", () => {
  const kinds: readonly (WorkKind | null)[] = [...WORK_KINDS, null];
  it.each(kinds.map((kind) => [kind ?? "none", kind] as const))("work kind %s", async (_label, kind) => {
    const sent: Record<string, Sent> = {};
    for (const [name, brief] of Object.entries(BRIEFS)) {
      for (const { label, ports } of PORT_SETS) {
        sent[`${name} | ${label}`] = await firstCall(assignmentFor(kind, brief), ports);
      }
    }
    expect(sent).toMatchSnapshot();
  });
});
