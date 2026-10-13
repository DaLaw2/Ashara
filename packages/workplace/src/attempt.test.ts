import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { CellExecFailed, CellToolFailed } from "@ashara/execution-infra";
import type { CellBackend, ExecResult } from "@ashara/execution-infra";
import type { ContextualTurnLlm, CostMeasurement, ResolvedModel, TurnResult } from "@ashara/llm-gateway";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { Assignment } from "./assignment.js";
import { runAttempt } from "./attempt.js";
import type { AttemptDeps } from "./attempt.js";
import { AttemptWallClockExhausted, InvalidAssignment, ProviderErrorFinish } from "./errors.js";
import { buildSystemPrompt } from "./prompt.js";
import type { AttemptRecord } from "./records.js";

type TurnRequest = Parameters<ReturnType<ContextualTurnLlm["forCall"]>["generateTurn"]>[0];
type Call = { readonly name: string; readonly input: unknown; readonly invalid?: string };
type Step = (request: TurnRequest) => Promise<TurnResult> | TurnResult;

const MEASURED: CostMeasurement = { measured: true, inputCost: 0.001, outputCost: 0.002, cacheSavings: 0, totalCost: 0.003 };

let callCounter = 0;

function turn(calls: readonly Call[], options: { text?: string; finishReason?: TurnResult["finishReason"]; cost?: CostMeasurement } = {}): TurnResult {
  const toolCalls = calls.map((call) => {
    callCounter += 1;
    const toolCallId = `tc-${callCounter}`;
    return call.invalid === undefined
      ? { kind: "valid" as const, toolCallId, toolName: call.name, input: call.input }
      : { kind: "invalid" as const, toolCallId, toolName: call.name, input: call.input, error: call.invalid };
  });
  return {
    assistant: {
      role: "assistant",
      content: [
        ...(options.text === undefined ? [] : [{ type: "text" as const, text: options.text }]),
        ...toolCalls.map((c) => ({ type: "tool-call" as const, toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
      ],
    },
    text: options.text ?? "",
    toolCalls,
    finishReason: options.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
    rawFinishReason: null,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: options.cost ?? MEASURED,
    provider: "fake",
    model: "fake-model",
  };
}

function scriptedLlm(steps: readonly Step[]) {
  const requests: TurnRequest[] = [];
  const contexts: unknown[] = [];
  const llm: ContextualTurnLlm = {
    forCall(context) {
      contexts.push(context);
      return {
        async generateTurn(request) {
          // The loop mutates its message list; snapshot what this turn was sent.
          requests.push({ ...request, messages: [...request.messages] });
          const step = steps[requests.length - 1];
          if (step === undefined) throw new Error(`script has no step ${requests.length}`);
          return step(request);
        },
      };
    },
  };
  return { llm, requests, contexts };
}

function fakeCell(overrides: Partial<CellBackend> = {}) {
  const files = new Map<string, string>();
  const commands: { command: string; timeoutSeconds: number }[] = [];
  const cell: CellBackend = {
    async readFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new CellToolFailed("readFile", ["cat", "--", path], 1, `cat: ${path}: No such file or directory`, false);
      return { text, truncated: false };
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async listDirectory() {
      return { entries: [...files.keys()].sort(), truncated: false };
    },
    async search() {
      return { text: "", truncated: false };
    },
    async run(command, timeoutSeconds): Promise<ExecResult> {
      commands.push({ command, timeoutSeconds });
      return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false };
    },
    ...overrides,
  };
  return { cell, files, commands };
}

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
  },
};

function assignment(limits: Partial<Assignment["limits"]> = {}): Assignment {
  return {
    projectId: parseProjectId("00000000-0000-4000-8000-000000000001"),
    taskId: createWorkItemId(),
    role: "worker",
    model,
    brief: {
      goal: "Write hello.txt",
      projectFrame: { intent: "A greeting file", stack: ["Plain text"], source: "contract-knowledge" },
      context: "An empty workspace.",
      constraints: [],
      deliverables: ["hello.txt"],
    },
    limits: { maxTurns: 10, perCommandTimeoutSeconds: 60, ...limits },
  };
}

function deps(llm: ContextualTurnLlm, cell: CellBackend, overrides: Partial<AttemptDeps> = {}) {
  const records: AttemptRecord[] = [];
  const full: AttemptDeps = {
    llm,
    cell,
    clock: { now: () => Date.now() },
    records: { append: async (record) => void records.push(record) },
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps: full, records };
}

function toolResultsOf(message: ModelMessage | undefined) {
  if (message?.role !== "tool") throw new Error(`expected a tool message, got ${message?.role ?? "none"}`);
  return message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : []));
}

describe("runAttempt", () => {
  it("writes a file, runs a command and finishes done, with turns, cost and records", async () => {
    const { llm, requests, contexts } = scriptedLlm([
      () => turn([{ name: "write_file", input: { path: "hello.txt", content: "hi\n" } }]),
      () => turn([{ name: "run_command", input: { command: "cat hello.txt", timeout_seconds: 600 } }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Wrote hello.txt." } }]),
    ]);
    const { cell, files, commands } = fakeCell();
    const { deps: d, records } = deps(llm, cell);
    const a = assignment();

    const outcome = await runAttempt(a, d);

    expect(outcome).toMatchObject({ kind: "finished", status: "done", summary: "Wrote hello.txt.", blockedReason: null, turnsUsed: 3 });
    expect(outcome.cost).toEqual({ measured: true, totalUsd: 3 * MEASURED.totalCost, turns: 3 });
    expect(outcome.lastToolCall).toMatchObject({ turn: 3, toolName: "finish" });
    expect(files.get("hello.txt")).toBe("hi\n");
    // The model asked for 600 s; the attempt's per-command limit wins.
    expect(commands).toEqual([{ command: "cat hello.txt", timeoutSeconds: 60 }]);
    expect(contexts).toEqual([{ projectId: a.projectId, taskId: a.taskId, callSite: "agent-runner" }]);
    expect(requests.every((r) => r.model === model && Object.keys(r.tools).includes("finish"))).toBe(true);
    expect(toolResultsOf(requests[2]?.messages.at(-1))).toEqual([{ type: "text", value: "Exit code: 0\nSTDOUT:\nok\n" }]);
    expect(records.map((r) => r.kind)).toEqual(["attempt_started", "turn", "tool_result", "turn", "tool_result", "turn", "outcome"]);
  });

  it("returns invalid tool arguments to the model as a tool error and keeps going", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "write_file", input: { path: "a.txt" } }, { name: "nope", input: "{", invalid: "AI_NoSuchToolError" }]),
      () => turn([{ name: "finish", input: { status: "blocked", summary: "Stuck." } }]),
      () => turn([{ name: "finish", input: { status: "blocked", summary: "Stuck.", blockedReason: "No spec." } }]),
    ]);
    const { cell, files } = fakeCell();

    const outcome = await runAttempt(assignment(), deps(llm, cell).deps);

    expect(outcome).toMatchObject({ kind: "finished", status: "blocked", blockedReason: "No spec.", turnsUsed: 3 });
    expect(files.size).toBe(0);
    const [argsError, invalidCall] = toolResultsOf(requests[1]?.messages.at(-1));
    expect(argsError).toMatchObject({ type: "error-text", value: expect.stringContaining("Invalid arguments for write_file: content") });
    expect(invalidCall).toMatchObject({ type: "error-text", value: expect.stringContaining("AI_NoSuchToolError") });
    expect(toolResultsOf(requests[2]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining("blockedReason") });
  });

  it("reports a command's own failure and a missing file to the model, not as an environment failure", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "read_file", input: { path: "absent.txt" } }, { name: "run_command", input: { command: "false" } }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
    ]);
    const { cell } = fakeCell({
      run: async () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false, stdoutTruncated: false, stderrTruncated: false }),
    });

    const outcome = await runAttempt(assignment(), deps(llm, cell).deps);

    expect(outcome.kind).toBe("finished");
    const [read, run] = toolResultsOf(requests[1]?.messages.at(-1));
    expect(read).toMatchObject({ type: "error-text", value: expect.stringContaining("No such file") });
    expect(run).toEqual({ type: "error-text", value: "Exit code: 1\nSTDERR:\nboom" });
  });

  it("ends at the turn cap", async () => {
    const listing: Step = () => turn([{ name: "list_directory", input: {} }]);
    const { llm } = scriptedLlm([listing, listing, listing]);

    const outcome = await runAttempt(assignment({ maxTurns: 2 }), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "turn_cap", maxTurns: 2, turnsUsed: 2 });
  });

  it("ends at the wall clock, read from the injected clock", async () => {
    let now = 0;
    const slow: Step = () => {
      now += 2_000;
      return turn([{ name: "list_directory", input: {} }]);
    };
    const { llm } = scriptedLlm([slow, slow, slow]);

    const outcome = await runAttempt(assignment({ wallClockMs: 3_000 }), deps(llm, fakeCell().cell, { clock: { now: () => now } }).deps);

    expect(outcome).toMatchObject({ kind: "wall_clock", wallClockMs: 3_000, elapsedMs: 4_000, turnsUsed: 2 });
  });

  it("aborts an in-flight model call when the wall clock runs out", async () => {
    let abortReason: unknown;
    const { llm } = scriptedLlm([
      (request) =>
        new Promise<TurnResult>((_resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => {
            abortReason = request.abortSignal.reason;
            reject(new Error("aborted by signal"));
          });
        }),
    ]);

    const outcome = await runAttempt(assignment({ wallClockMs: 50 }), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "wall_clock", turnsUsed: 1 });
    expect(outcome.cost.measured).toBe(false);
    expect(abortReason).toBeInstanceOf(AttemptWallClockExhausted);
    expect(abortReason).toMatchObject({ turn: 1, wallClockMs: 50 });
  });

  it("ends as transport_exhausted with a typed error when the provider finishes with an error", async () => {
    const { llm } = scriptedLlm([() => ({ ...turn([]), finishReason: "provider_error", rawFinishReason: "overloaded" })]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "transport_exhausted", turnsUsed: 1 });
    if (outcome.kind !== "transport_exhausted") throw new Error(`expected transport_exhausted, got ${outcome.kind}`);
    expect(outcome.error).toBeInstanceOf(ProviderErrorFinish);
    expect(outcome.error).toMatchObject({ turn: 1, provider: "fake", model: "fake-model", rawFinishReason: "overloaded" });
  });

  it("ends as model_stopped_without_finish when a response has no tool call", async () => {
    const { llm } = scriptedLlm([() => turn([], { text: "All done!" })]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "model_stopped_without_finish", finishReason: "stop", finalText: "All done!", turnsUsed: 1 });
  });

  it("ends as transport_exhausted on a generateTurn failure, cost unmeasured rather than 0", async () => {
    const failure = new Error("provider unreachable");
    const { llm } = scriptedLlm([
      () => turn([{ name: "list_directory", input: {} }]),
      () => {
        throw failure;
      },
    ]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "transport_exhausted", error: failure, turnsUsed: 2 });
    expect(outcome.cost).toEqual({
      measured: false,
      measuredUsd: MEASURED.totalCost,
      unmeasuredTurns: [{ turn: 2, reason: "the call failed before returning a cost (Error)" }],
    });
    expect(outcome.detail).toContain("provider unreachable");
  });

  it("marks the attempt unmeasured when the gateway could not price a turn", async () => {
    const unpriced: CostMeasurement = { measured: false, missingCounts: ["cacheReadTokens"], missingRates: [] };
    const { llm } = scriptedLlm([() => turn([{ name: "finish", input: { status: "done", summary: "x" } }], { cost: unpriced })]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);

    expect(outcome.cost).toMatchObject({ measured: false, measuredUsd: 0, unmeasuredTurns: [{ turn: 1 }] });
  });

  it("ends as environment_failure when the substrate, not the command, fails", async () => {
    const substrate = new CellExecFailed("cell-1", ["sh", "-c", "make"], 125, "OCI runtime error", "podman exec or timeout itself failed");
    const { llm } = scriptedLlm([() => turn([{ name: "run_command", input: { command: "make" } }])]);
    const { cell } = fakeCell({
      run: async () => {
        throw substrate;
      },
    });

    const outcome = await runAttempt(assignment(), deps(llm, cell).deps);

    expect(outcome).toMatchObject({ kind: "environment_failure", source: "cell", error: substrate, turnsUsed: 1 });
    expect(outcome.lastToolCall).toEqual({ turn: 1, toolName: "run_command", input: '{"command":"make"}' });
  });

  it("ends as environment_failure when the records sink fails, even after finish", async () => {
    const { llm } = scriptedLlm([() => turn([{ name: "finish", input: { status: "done", summary: "x" } }])]);
    const { deps: d } = deps(llm, fakeCell().cell, {
      records: {
        append: async (record) => {
          if (record.kind === "outcome") throw new Error("disk full");
        },
      },
    });

    const outcome = await runAttempt(assignment(), d);

    expect(outcome).toMatchObject({ kind: "environment_failure", source: "records" });
    expect(outcome.detail).toContain("finished");
  });

  it("ends as cancelled when the signal aborts, the in-flight call included", async () => {
    const controller = new AbortController();
    const { llm } = scriptedLlm([
      (request) =>
        new Promise<TurnResult>((_resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort(new Error("owner cancelled the task"));
        }),
    ]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell, { signal: controller.signal }).deps);

    expect(outcome).toMatchObject({ kind: "cancelled", turnsUsed: 1 });
    expect(outcome.detail).toContain("owner cancelled the task");
  });

  it("rejects invalid limits before any call", async () => {
    const { llm, requests } = scriptedLlm([]);
    await expect(runAttempt(assignment({ maxTurns: 0 }), deps(llm, fakeCell().cell).deps)).rejects.toBeInstanceOf(InvalidAssignment);
    expect(requests).toHaveLength(0);
  });
});

describe("workplace boundaries", () => {
  it("no production file reaches the host filesystem or spawns a host process", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = (await readdir(dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = await readFile(`${dir}/${name}`, "utf8");
      expect(text, name).not.toMatch(/from\s+["'](node:)?(fs|fs\/promises|child_process)["']/);
    }
  });

  it("the system prompt tells the agent nothing about git", () => {
    const prompt = buildSystemPrompt(assignment().brief);
    expect(prompt).not.toMatch(/\bgit\b/i);
    expect(prompt).toContain("A greeting file");
  });
});
