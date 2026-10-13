import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { CellExecFailed, CellToolFailed } from "@ashara/execution-infra";
import type { CellBackend, ExecResult } from "@ashara/execution-infra";
import { PreCallRefusal } from "@ashara/llm-gateway";
import type { ContextualTurnLlm, CostMeasurement, ResolvedModel, TurnResult } from "@ashara/llm-gateway";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { Assignment } from "./assignment.js";
import { runAttempt } from "./attempt.js";
import type { AttemptDeps } from "./attempt.js";
import type { CheckDefinition, CheckDefinitionPort } from "./check-definition.js";
import type { CheckRunReport, TaskCheckRunPort } from "./check-run.js";
import type { EnvironmentCheckPort, EnvironmentCheckReport, EnvironmentCommandsRun } from "./environment-check.js";
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
    role: { id: "worker", name: "Worker" },
    workKind: "implementation",
    model,
    cellImage: { kind: "base-cell", image: "base@sha256:0000000000000000000000000000000000000000000000000000000000000000", digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    brief: {
      goal: "Write hello.txt",
      intent: "A greeting file",
      visionVersion: 1,
      assumptions: [],
      projectEnvironment: { kind: "to-define" },
      context: "An empty workspace.",
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
    environment: null,
    checks: null,
    taskChecks: null,
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

  // The 509bbbc5 review: Finance's BudgetExceeded (a PreCallRefusal) ended the attempt as transport_exhausted.
  it("ends as refused, carrying the refusal by type, when a turn's call is refused before it is sent", async () => {
    class CapRefusal extends PreCallRefusal {}
    const refusal = new CapRefusal("budget_cap: the spend cap of project p is $1.000000");
    const { llm } = scriptedLlm([
      () => turn([{ name: "list_directory", input: {} }]),
      () => {
        throw refusal;
      },
    ]);

    const outcome = await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);

    expect(outcome).toMatchObject({ kind: "refused", error: refusal, turnsUsed: 2 });
    // The refused request was never sent: the attempt's cost stays measured.
    expect(outcome.cost).toEqual({ measured: true, totalUsd: MEASURED.totalCost, turns: 1 });
    expect(outcome.detail).toContain("refused before it was sent");
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

describe("build_environment", () => {
  const empty = { text: "", truncated: false };
  const ran: EnvironmentCommandsRun & { kind: "ran" } = {
    kind: "ran",
    build: { command: "true", exitCode: 0, timedOut: false, stdout: empty, stderr: empty },
    test: { command: "echo ok", exitCode: 0, timedOut: false, stdout: { text: "ok\n", truncated: false }, stderr: empty },
    leftOver: [],
  };
  const tested: EnvironmentCheckReport = {
    kind: "tested",
    version: "v".repeat(64),
    imageRef: "localhost/ashara-env-p:vvvv",
    build: { kind: "built", log: { text: "STEP 1/1: FROM base", truncated: false } },
    commands: ran,
  };
  const STATEMENT = "A shell-only environment, because nothing more is needed.";

  function port(report: EnvironmentCheckReport) {
    const timeouts: number[] = [];
    const environment: EnvironmentCheckPort = {
      async check(testTimeoutSeconds) {
        timeouts.push(testTimeoutSeconds);
        return report;
      },
    };
    return { environment, timeouts };
  }

  it("is offered only to environment work, and an implementation attempt's call to it is refused", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "build_environment", input: {} }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
    ]);
    const { cell } = fakeCell();

    await runAttempt(assignment(), deps(llm, cell).deps);

    expect(Object.keys(requests[0]?.tools ?? {})).not.toContain("build_environment");
    expect(toolResultsOf(requests[1]?.messages.at(-1))[0]).toMatchObject({
      type: "error-text",
      value: expect.stringContaining('Unknown tool "build_environment"'),
    });
  });

  it("returns the version, build log and test output to the environment role's model", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "build_environment", input: {} }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Wrote environment/ and .gitignore.", statement: STATEMENT } }]),
    ]);
    const { cell } = fakeCell();
    const { environment, timeouts } = port(tested);

    const outcome = await runAttempt({ ...assignment(), workKind: "environment" }, deps(llm, cell, { environment }).deps);

    // The statement is kept apart from the summary: only it reaches the client.
    expect(outcome).toMatchObject({ kind: "finished", status: "done", summary: "Wrote environment/ and .gitignore.", statement: STATEMENT });
    expect(Object.keys(requests[0]?.tools ?? {})).toContain("build_environment");
    expect(timeouts).toEqual([60]);
    const [result] = toolResultsOf(requests[1]?.messages.at(-1));
    expect(result).toMatchObject({ type: "text", value: expect.stringContaining(`Environment version ${"v".repeat(64)}`) });
    expect(result).toMatchObject({ value: expect.stringContaining("Test stdout:\nok") });
    expect(result).toMatchObject({ value: expect.stringContaining("Verdict: PASSED") });
  });

  it("environment work's done without a statement is an argument error the model can fix; other work's finish takes none", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done.", statement: STATEMENT } }]),
    ]);
    const { environment } = port(tested);
    const outcome = await runAttempt({ ...assignment(), workKind: "environment" }, deps(llm, fakeCell().cell, { environment }).deps);
    expect(toolResultsOf(requests[1]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining("statement") });
    expect(outcome).toMatchObject({ kind: "finished", status: "done", statement: STATEMENT });

    const other = scriptedLlm([() => turn([{ name: "finish", input: { status: "done", summary: "Done." } }])]);
    expect(await runAttempt(assignment(), deps(other.llm, fakeCell().cell).deps)).toMatchObject({ kind: "finished", statement: null });
  });

  it("the environment brief states the definition schema and the scope and cleanliness rules", () => {
    const system = buildSystemPrompt(assignment().brief, "environment");
    for (const field of ["- owned:", "- containerfile:", "- build:", "- test:"]) expect(system).toContain(field);
    expect(system).toContain('"environment/" (required, the one owned directory)');
    expect(system).toContain("Only owned paths may be added, changed or deleted");
    expect(system).toContain("must be ignored by a committed .gitignore");
    expect(system).toContain("do not write the product");
  });

  it("a test that prints nothing, a dirty checkout, out-of-scope work or a failed build is a tool error the model can act on", async () => {
    const silent: EnvironmentCheckReport = { ...tested, commands: { ...ran, test: { ...ran.test, stdout: empty } } };
    const dirty: EnvironmentCheckReport = { ...tested, commands: { ...ran, leftOver: ["out/a"] } };
    const outside: EnvironmentCheckReport = { kind: "out_of_scope", owned: ["environment/"], paths: ["src/x"] };
    const failed: EnvironmentCheckReport = {
      kind: "build_failed",
      version: "v".repeat(64),
      detail: "podman build exited 1",
      log: { text: "Error: no such image", truncated: true },
    };
    for (const [report, expected] of [
      [silent, "FAILED: the test command printed nothing"],
      [dirty, "NOT clean"],
      [dirty, "- out/a"],
      [outside, "- src/x"],
      [failed, "Image build log (truncated: only its end is shown):\nError: no such image"],
    ] as const) {
      const { llm, requests } = scriptedLlm([
        () => turn([{ name: "build_environment", input: {} }]),
        () => turn([{ name: "finish", input: { status: "blocked", summary: "No.", blockedReason: "It fails." } }]),
      ]);
      const { environment } = port(report);
      await runAttempt({ ...assignment(), workKind: "environment" }, deps(llm, fakeCell().cell, { environment }).deps);
      expect(toolResultsOf(requests[1]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining(expected) });
    }
  });

  it("refuses an environment assignment without Z0's check, and the check for any other work", async () => {
    const { llm } = scriptedLlm([]);
    const { environment } = port(tested);

    await expect(runAttempt({ ...assignment(), workKind: "environment" }, deps(llm, fakeCell().cell).deps)).rejects.toBeInstanceOf(InvalidAssignment);
    await expect(runAttempt(assignment(), deps(llm, fakeCell().cell, { environment }).deps)).rejects.toBeInstanceOf(InvalidAssignment);
  });
});

describe("define_check", () => {
  function recorder() {
    const defined: CheckDefinition[] = [];
    const checks: CheckDefinitionPort = {
      define(check) {
        if (defined.some((d) => d.name === check.name)) return { kind: "refused", reason: `a check named ${check.name} is already defined` };
        defined.push(check);
        return { kind: "recorded", defined: defined.length };
      },
    };
    return { checks, defined };
  }

  it("is offered to check work only; implementation and environment attempts never see it", async () => {
    for (const workKind of ["implementation", "environment", null] as const) {
      const { llm, requests } = scriptedLlm([
        () => turn([{ name: "define_check", input: { name: "x", command: "false" } }]),
        () => turn([{ name: "finish", input: { status: "blocked", summary: "Done.", blockedReason: "No check tool." } }]),
      ]);
      const environment: EnvironmentCheckPort | null =
        workKind === "environment" ? { check: async () => ({ kind: "definition_refused", detail: "unused" }) } : null;
      await runAttempt({ ...assignment(), workKind }, deps(llm, fakeCell().cell, { environment }).deps);
      expect(Object.keys(requests[0]?.tools ?? {}), String(workKind)).not.toContain("define_check");
      expect(toolResultsOf(requests[1]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining('Unknown tool "define_check"') });
    }
  });

  it("records each check of a check attempt and tells the model a duplicate name is refused", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "define_check", input: { name: "greets", command: "grep -q hello greet.txt && cat greet.txt" } }]),
      () => turn([{ name: "define_check", input: { name: "greets", command: "true" } }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "One check." } }]),
    ]);
    const { checks, defined } = recorder();

    const outcome = await runAttempt({ ...assignment(), workKind: "check" }, deps(llm, fakeCell().cell, { checks }).deps);

    expect(outcome).toMatchObject({ kind: "finished", status: "done" });
    expect(Object.keys(requests[0]?.tools ?? {})).toContain("define_check");
    expect(Object.keys(requests[0]?.tools ?? {})).not.toContain("build_environment");
    expect(requests[0]?.system).toContain("Every check must FAIL on the project as it is now");
    expect(defined).toEqual([{ name: "greets", command: "grep -q hello greet.txt && cat greet.txt" }]);
    expect(toolResultsOf(requests[2]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining("already defined") });
  });

  it("refuses a check assignment without Z0's recorder, and the recorder for any other work", async () => {
    const { llm } = scriptedLlm([]);
    const { checks } = recorder();
    await expect(runAttempt({ ...assignment(), workKind: "check" }, deps(llm, fakeCell().cell).deps)).rejects.toBeInstanceOf(InvalidAssignment);
    await expect(runAttempt(assignment(), deps(llm, fakeCell().cell, { checks }).deps)).rejects.toBeInstanceOf(InvalidAssignment);
  });
});

describe("run_checks", () => {
  function taskChecks(report: CheckRunReport) {
    const timeouts: number[] = [];
    const port: TaskCheckRunPort = {
      run: async (timeoutSeconds) => {
        timeouts.push(timeoutSeconds);
        return report;
      },
    };
    return { port, timeouts };
  }

  it("runs the stored checks through Z0's port and reports each verdict; a failing check is a tool error", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "run_checks", input: {} }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
    ]);
    const { port, timeouts } = taskChecks({
      kind: "ran",
      runs: [
        { name: "greets", command: "cat greet.txt", exitCode: 0, timedOut: false, output: "hello" },
        { name: "lists", command: "ls missing", exitCode: 2, timedOut: false, output: "No such file" },
      ],
    });

    await runAttempt(assignment({ perCommandTimeoutSeconds: 45 }), deps(llm, fakeCell().cell, { taskChecks: port }).deps);

    expect(Object.keys(requests[0]?.tools ?? {})).toContain("run_checks");
    expect(timeouts).toEqual([45]);
    const [result] = toolResultsOf(requests[1]?.messages.at(-1));
    expect(result).toMatchObject({ type: "error-text", value: expect.stringContaining("1 of 2 check(s) pass") });
    expect(result).toMatchObject({ value: expect.stringContaining('Check "greets": PASSED') });
    expect(result).toMatchObject({ value: expect.stringContaining('Check "lists": FAILED: exited 2') });
  });

  it("is offered only with Z0's port, takes no arguments, and is refused to check work", async () => {
    const { llm, requests } = scriptedLlm([
      () => turn([{ name: "run_checks", input: {} }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
    ]);
    await runAttempt(assignment(), deps(llm, fakeCell().cell).deps);
    expect(Object.keys(requests[0]?.tools ?? {})).not.toContain("run_checks");
    expect(toolResultsOf(requests[1]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining('Unknown tool "run_checks"') });

    const passing = taskChecks({ kind: "ran", runs: [{ name: "a", command: "true", exitCode: 0, timedOut: false, output: "ok" }] });
    const second = scriptedLlm([
      () => turn([{ name: "run_checks", input: { command: "true" } }]),
      () => turn([{ name: "finish", input: { status: "done", summary: "Done." } }]),
    ]);
    await runAttempt(assignment(), deps(second.llm, fakeCell().cell, { taskChecks: passing.port }).deps);
    expect(passing.timeouts).toEqual([]);
    expect(toolResultsOf(second.requests[1]?.messages.at(-1))[0]).toMatchObject({ type: "error-text", value: expect.stringContaining("Invalid arguments for run_checks") });

    const checks: CheckDefinitionPort = { define: () => ({ kind: "recorded", defined: 1 }) };
    await expect(
      runAttempt({ ...assignment(), workKind: "check" }, deps(scriptedLlm([]).llm, fakeCell().cell, { checks, taskChecks: passing.port }).deps),
    ).rejects.toBeInstanceOf(InvalidAssignment);
    // Environment work is decided by its gate alone: it is never given the stored checks either.
    const environment: EnvironmentCheckPort = { check: async () => ({ kind: "definition_refused", detail: "unused" }) };
    await expect(
      runAttempt({ ...assignment(), workKind: "environment" }, deps(scriptedLlm([]).llm, fakeCell().cell, { environment, taskChecks: passing.port }).deps),
    ).rejects.toBeInstanceOf(InvalidAssignment);
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
    const prompt = buildSystemPrompt(assignment().brief, "implementation");
    expect(prompt).not.toMatch(/\bgit\b/i);
    expect(prompt).toContain("A greeting file");
  });
});
