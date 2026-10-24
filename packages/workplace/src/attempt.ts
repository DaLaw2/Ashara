import type { ModelMessage, ToolResultPart } from "ai";
import type { CellBackend } from "@ashara/execution-infra";
import { ContextBudgetExceeded, PreCallRefusal, modelCallAbortedOf } from "@ashara/finance";
import type { ContextualTurnLlm, CostedTurnResult } from "@ashara/finance";
import { describeErrorChain, serializeError } from "@ashara/shared";
import type { Clock } from "@ashara/shared";
import type { Assignment, ResolvedLimits } from "./assignment.js";
import { resolveLimits } from "./assignment.js";
import type { CheckDefinitionPort } from "./check-definition.js";
import type { TaskCheckRunPort } from "./check-run.js";
import type { EnvironmentCheckPort } from "./environment-check.js";
import { AttemptWallClockExhausted, InvalidAssignment, ProviderErrorFinish } from "./errors.js";
import { CostTally } from "./outcome.js";
import type { LastToolCall, Outcome, Terminal } from "./outcome.js";
import { FIRST_MESSAGE, buildSystemPrompt } from "./prompt.js";
import { promptDigest } from "./prompt-digest.js";
import { describeInput, toRecordedOutcome, truncateText } from "./records.js";
import type { AttemptRecord, AttemptRecordSink } from "./records.js";
import { executeTool, toolSchemasFor } from "./tools.js";
import type { ToolExecution, ToolSchemas } from "./tools.js";

/**
 * The routing site agent work is tagged with today (model-access KNOWN_LLM_SITES, config/models.toml):
 * the llm_calls rows of an attempt carry it, and the caller resolves the pinned model with it. The
 * run report ties exactly the rows of this site to attempts.
 */
export const AGENT_CALL_SITE = "agent-runner";

interface AttemptDeps {
  /** The recorded gateway: every turn is one generateTurn call, one llm_calls row. */
  readonly llm: ContextualTurnLlm;
  /** The task's cell; every tool call goes through it, none touches the host filesystem. */
  readonly cell: CellBackend;
  /** Only differences of its readings are used. */
  readonly clock: Clock;
  readonly records: AttemptRecordSink;
  /** Aborting it ends the attempt as cancelled, the in-flight model call included. */
  readonly signal: AbortSignal;
  /**
   * Z0's environment check behind build_environment: required for an environment assignment and
   * refused for any other, so the tool and its port cannot drift apart.
   */
  readonly environment: EnvironmentCheckPort | null;
  /** Z0's check recorder behind define_check: required for a check assignment and refused for any other. */
  readonly checks: CheckDefinitionPort | null;
  /**
   * Z0's run of the task's stored checks behind run_checks: offered exactly when supplied (a task
   * decided by stored checks), and refused for a check assignment, whose checks do not exist yet.
   */
  readonly taskChecks: TaskCheckRunPort | null;
}

/** The pre-call refusal `error` is, or carries as a cause; null for any other failure. */
function preCallRefusalOf(error: unknown): PreCallRefusal | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return current;
  }
  return null;
}

/** The context budget breach `error` is, or carries as a cause; null for any other failure. */
function contextBudgetBreachOf(error: unknown): ContextBudgetExceeded | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ContextBudgetExceeded) return current;
  }
  return null;
}

class RecordWriteFailed extends Error {
  constructor(record: AttemptRecord["kind"], options: ErrorOptions) {
    super(`Writing the "${record}" attempt record failed: ${describeErrorChain(options.cause)}`, options);
    this.name = "RecordWriteFailed";
  }
}

/**
 * Runs one attempt of an assignment: an explicit loop in Z0 (no SDK stopWhen) where each
 * turn is one recorded model call and each returned tool call runs, in order, through the cell.
 * Resolves to exactly one Outcome terminal; throws only InvalidAssignment, before any call is made.
 */
export async function runAttempt(assignment: Assignment, deps: AttemptDeps): Promise<Outcome> {
  const limits = resolveLimits(assignment);
  assertToolPorts(assignment, deps);
  return new AttemptLoop(assignment, deps, limits).run();
}

/** Each tool port is supplied exactly when the assignment's tool profile offers the tool behind it. */
function assertToolPorts(assignment: Assignment, deps: AttemptDeps): void {
  const { toolProfile } = assignment;
  const buildsEnvironment = toolProfile === "build-environment";
  if (buildsEnvironment !== (deps.environment !== null)) {
    throw new InvalidAssignment(assignment.taskId, [
      buildsEnvironment
        ? "environment: a build-environment assignment needs Z0's environment check for build_environment"
        : `environment: only a build-environment assignment may be given Z0's environment check (tool profile ${toolProfile})`,
    ]);
  }
  const definesChecks = toolProfile === "define-checks";
  if (definesChecks !== (deps.checks !== null)) {
    throw new InvalidAssignment(assignment.taskId, [
      definesChecks
        ? "checks: a define-checks assignment needs Z0's check recorder for define_check"
        : `checks: only a define-checks assignment may be given Z0's check recorder (tool profile ${toolProfile})`,
    ]);
  }
  // run_checks is the work's that the stored checks decide: checks being defined do not exist yet, and an environment is decided by its gate.
  if ((definesChecks || buildsEnvironment) && deps.taskChecks !== null) {
    throw new InvalidAssignment(assignment.taskId, [
      `taskChecks: a ${toolProfile} assignment runs no stored checks`,
    ]);
  }
}

type ToolCall = CostedTurnResult["toolCalls"][number];
type CallExecution = ToolExecution | { readonly kind: "result"; readonly isError: true; readonly output: string };

/** What one step of the loop leaves: the attempt's Outcome when the step ended it, or what the next step takes. */
type Step<T> = { readonly kind: "ended"; readonly outcome: Promise<Outcome> } | { readonly kind: "next"; readonly value: T };

/** The terminal of a turn whose response ends the attempt before any tool call runs; null when its tool calls run. */
function responseTerminal(result: CostedTurnResult, turn: number): Terminal | null {
  if (result.finishReason === "provider_error") {
    const error = new ProviderErrorFinish(turn, result.provider, result.model, result.rawFinishReason);
    return { kind: "transport_exhausted", error, detail: error.message };
  }
  // Checked before any tool call runs: a call in a cut response may be cut itself.
  if (result.finishReason === "truncated") {
    const tokens = result.reportedOutputTokens === null ? "an unreported number of" : String(result.reportedOutputTokens);
    return {
      kind: "output_truncated",
      turn,
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      outputTokens: result.reportedOutputTokens,
      droppedToolCalls: result.toolCalls.length,
      detail:
        `turn ${turn}: ${result.provider}/${result.model} output was cut at the output token limit after ${tokens} output tokens ` +
        `(raw finish reason: ${result.rawFinishReason ?? "none sent"}); none of its ${result.toolCalls.length} tool call(s) ran`,
    };
  }
  if (result.toolCalls.length === 0) {
    return {
      kind: "model_stopped_without_finish",
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      finalText: truncateText(result.text),
      detail: `turn ${turn}: the model stopped (${result.finishReason}) without calling finish`,
    };
  }
  return null;
}

/** The terminal of a tool call that ends the attempt by itself: finish, or a dispute of a check. */
function concludingCall(execution: Extract<CallExecution, { readonly kind: "finish" | "dispute" }>, turn: number, lastCheckRun: string | null): Terminal {
  if (execution.kind === "finish") {
    const { args } = execution;
    return {
      kind: "finished",
      status: args.status,
      summary: args.summary,
      blockedReason: args.status === "blocked" ? args.blockedReason : null,
      blockedOn: args.status === "blocked" ? args.blockedOn : null,
      statement: args.status === "done" && "statement" in args ? args.statement : null,
      detail: `turn ${turn}: the model called finish with status ${args.status}`,
    };
  }
  return {
    kind: "disputed",
    checkName: execution.checkName,
    ofTask: execution.ofTask,
    reason: execution.reason,
    evidence: lastCheckRun,
    detail:
      `turn ${turn}: the model disputed check ${JSON.stringify(execution.checkName)}` +
      `${execution.ofTask === null ? "" : ` of merged task ${execution.ofTask}`}: ${execution.reason}`,
  };
}

/** One attempt in flight: its turns, its cost tally and what its records and outcome report. */
class AttemptLoop {
  private readonly tools: ToolSchemas;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly llm: ReturnType<ContextualTurnLlm["forCall"]>;
  private readonly system: string;
  private readonly messages: ModelMessage[];
  private readonly digest: string;
  private readonly costs = new CostTally();
  private turnsUsed = 0;
  private lastToolCall: LastToolCall | null = null;
  /** The input the provider reported for the previous turn: the window guard projects the next turn from it. */
  private priorInputTokens: number | null = null;
  /** A dispute's evidence: what the checks printed the last time the implementer ran them. */
  private lastCheckRun: string | null = null;

  constructor(
    private readonly assignment: Assignment,
    private readonly deps: AttemptDeps,
    private readonly limits: ResolvedLimits,
  ) {
    const { toolProfile } = assignment;
    this.tools = toolSchemasFor(toolProfile, deps.taskChecks !== null);
    this.startedAt = deps.clock.now();
    this.deadline = this.startedAt + limits.wallClockMs;
    this.llm = deps.llm.forCall({ projectId: assignment.projectId, taskId: assignment.taskId, callSite: AGENT_CALL_SITE });
    this.system = buildSystemPrompt(assignment.brief, assignment.charter, toolProfile);
    this.messages = [{ role: "user", content: FIRST_MESSAGE }];
    // Taken before the loop appends to `messages`: exactly what the first call is sent.
    this.digest = promptDigest({ system: this.system, messages: this.messages, tools: this.tools });
  }

  async run(): Promise<Outcome> {
    const { assignment, limits } = this;
    const started = await this.record({
      kind: "attempt_started",
      at: this.startedAt,
      projectId: assignment.projectId,
      taskId: assignment.taskId,
      role: { id: assignment.role.id, name: assignment.role.name },
      provider: assignment.model.provider,
      modelId: assignment.model.modelId,
      cellImage: assignment.cellImage,
      limits,
      system: this.system,
      firstMessage: FIRST_MESSAGE,
      promptDigest: this.digest,
    });
    if (started !== null) return this.recordsFailed(started);

    for (;;) {
      const stop = this.interruption();
      if (stop !== null) return this.conclude(stop);
      if (this.turnsUsed >= limits.maxTurns) {
        return this.conclude({ kind: "turn_cap", maxTurns: limits.maxTurns, detail: `turn cap of ${limits.maxTurns} reached without finish` });
      }

      this.turnsUsed += 1;
      const ran = await this.runTurn(this.turnsUsed);
      if (ran.kind === "ended") return ran.outcome;
    }
  }

  /** One turn: its model call, its record, then each of its tool calls in order. */
  private async runTurn(turn: number): Promise<Step<null>> {
    const called = await this.callModel(turn);
    if (called.kind === "ended") return called;
    const result = called.value;

    this.costs.add(turn, result.cost);
    this.priorInputTokens = result.reportedInputTokens;
    const turnRecorded = await this.record({
      kind: "turn",
      at: this.deps.clock.now(),
      turn,
      text: truncateText(result.text),
      toolCalls: result.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: describeInput(call.input),
        valid: call.kind === "valid",
      })),
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      usage: result.usage,
      costUsd: result.cost.measured ? result.cost.totalCost : null,
    });
    if (turnRecorded !== null) return this.ended(this.recordsFailed(turnRecorded));
    this.messages.push(result.assistant);

    const responseEnd = responseTerminal(result, turn);
    if (responseEnd !== null) return this.ended(this.conclude(responseEnd));

    const toolResults: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      const ran = await this.runToolCall(call, turn);
      if (ran.kind === "ended") return ran;
      toolResults.push(ran.value);
    }
    this.messages.push({ role: "tool", content: toolResults });
    return { kind: "next", value: null };
  }

  /** The turn's model call, bounded by what is left of the attempt's wall clock; a call that fails ends the attempt. */
  private async callModel(turn: number): Promise<Step<CostedTurnResult>> {
    const { assignment, limits, deps } = this;
    const { clock, signal } = deps;
    // Real time, not the injected clock: the clock decides the terminal between steps; this timer
    // only bounds a model call that would otherwise outlive the attempt.
    const wallClock = new AbortController();
    const timer = setTimeout(() => wallClock.abort(new AttemptWallClockExhausted(turn, limits.wallClockMs)), Math.max(0, this.deadline - clock.now()));
    try {
      return {
        kind: "next",
        value: await this.llm.generateTurn({
          model: assignment.model,
          system: this.system,
          messages: this.messages,
          tools: this.tools,
          abortSignal: AbortSignal.any([signal, wallClock.signal]),
          priorInputTokens: this.priorInputTokens,
        }),
      };
    } catch (error) {
      const refusal = preCallRefusalOf(error);
      const overflow = contextBudgetBreachOf(error);
      // A refused request, one the window guard stopped, or one aborted before it was sent (no
      // llm_calls row exists) cost nothing: it is not an unmeasured turn. One aborted in flight was
      // sent, and its row with no usage is counted at its estimate, so it stays unmeasured here.
      const unsent = refusal !== null || overflow?.context.breach.source === "preflight" || modelCallAbortedOf(error)?.at.stage === "before-send";
      const serialized = serializeError(error);
      if (!unsent) this.costs.addUnknown(turn, `the call failed before returning a cost (${serialized.name})`);
      const failed = await this.record({ kind: "turn_failed", at: clock.now(), turn, error: serialized });
      if (failed !== null) return this.ended(this.recordsFailed(failed));
      if (overflow !== null) {
        return this.ended(this.conclude({ kind: "context_budget_exceeded", turn, source: overflow.context.breach.source, error: overflow, detail: `turn ${turn}: ${overflow.message}` }));
      }
      if (refusal !== null) {
        return this.ended(this.conclude({
          kind: "refused",
          error: refusal,
          detail: `turn ${turn} model call to ${assignment.model.provider}/${assignment.model.modelId} was refused before it was sent (${refusal.name}): ${refusal.message}`,
        }));
      }
      if (wallClock.signal.aborted && !signal.aborted) {
        const elapsedMs = clock.now() - this.startedAt;
        return this.ended(this.conclude({
          kind: "wall_clock",
          wallClockMs: limits.wallClockMs,
          elapsedMs,
          detail: `wall clock of ${limits.wallClockMs} ms ran out during turn ${turn}'s model call`,
        }));
      }
      const stopped = this.interruption();
      if (stopped !== null) return this.ended(this.conclude(stopped));
      return this.ended(this.conclude({
        kind: "transport_exhausted",
        error,
        detail: `turn ${turn} model call to ${assignment.model.provider}/${assignment.model.modelId} failed: ${describeErrorChain(error)}`,
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  /** One tool call of the turn, run in the cell: its result for the model, or the attempt's end. */
  private async runToolCall(call: ToolCall, turn: number): Promise<Step<ToolResultPart>> {
    const { deps, limits } = this;
    const { clock, signal } = deps;
    const between = this.interruption();
    if (between !== null) return this.ended(this.conclude(between));
    this.lastToolCall = { turn, toolName: call.toolName, input: describeInput(call.input) };

    const remainingSeconds = Math.max(1, Math.ceil((this.deadline - clock.now()) / 1000));
    const execution: CallExecution =
      call.kind === "invalid"
        ? { kind: "result" as const, isError: true, output: truncateText(`Invalid tool call ${call.toolName}: ${call.error}. Fix the call and try again.`) }
        : await executeTool(call.toolName, call.input, {
            cell: deps.cell,
            commandTimeoutSeconds: Math.min(limits.perCommandTimeoutSeconds, remainingSeconds),
            tools: this.tools,
            environment: deps.environment,
            checks: deps.checks,
            taskChecks: deps.taskChecks,
          });

    if (execution.kind === "finish" || execution.kind === "dispute") return this.ended(this.conclude(concludingCall(execution, turn, this.lastCheckRun)));
    // The shutdown during a tool call ends the attempt as cancelled, whatever the call returned: an
    // interrupted command has no outcome, and none is recorded for it or shown to the model.
    if (execution.kind === "interrupted" || signal.aborted) {
      const stopped = this.interruption();
      if (stopped !== null) return this.ended(this.conclude(stopped));
    }
    if (execution.kind === "interrupted") {
      // Interrupted by a signal other than the attempt's: nothing the model can act on, and no outcome.
      return this.ended(this.conclude({
        kind: "environment_failure",
        source: "cell",
        error: execution.error,
        detail: `turn ${turn}: ${execution.toolName} was interrupted in the cell, not by this attempt's signal: ${execution.error.message}`,
      }));
    }
    if (execution.kind === "environment_failure") {
      return this.ended(this.conclude({
        kind: "environment_failure",
        source: "cell",
        error: execution.error,
        detail: `turn ${turn}: ${execution.toolName} could not run in the cell: ${describeErrorChain(execution.error)}`,
      }));
    }

    const resultRecorded = await this.record({
      kind: "tool_result",
      at: clock.now(),
      turn,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      isError: execution.isError,
      output: execution.output,
    });
    if (resultRecorded !== null) return this.ended(this.recordsFailed(resultRecorded));
    if (call.kind === "valid" && call.toolName === "run_checks") this.lastCheckRun = execution.output;
    return {
      kind: "next",
      value: {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: execution.isError ? { type: "error-text", value: execution.output } : { type: "text", value: execution.output },
      },
    };
  }

  private ended(outcome: Promise<Outcome>): Step<never> {
    return { kind: "ended", outcome };
  }

  private async record(entry: AttemptRecord): Promise<RecordWriteFailed | null> {
    try {
      await this.deps.records.append(entry);
      return null;
    } catch (error) {
      return new RecordWriteFailed(entry.kind, { cause: error });
    }
  }

  private async conclude(terminal: Terminal): Promise<Outcome> {
    const { turnsUsed, lastToolCall, digest } = this;
    const outcome: Outcome = { ...terminal, turnsUsed, cost: this.costs.snapshot(), lastToolCall, promptDigest: digest };
    const failed = await this.record({ kind: "outcome", at: this.deps.clock.now(), outcome: toRecordedOutcome(outcome) });
    if (failed === null) return outcome;
    // The outcome itself could not be recorded: an unrecorded "done" is not reported as done.
    return {
      kind: "environment_failure",
      source: "records",
      error: failed,
      detail: `the attempt ended as ${outcome.kind} (${outcome.detail}) but its outcome record was not written: ${failed.message}`,
      turnsUsed,
      cost: outcome.cost,
      lastToolCall,
      promptDigest: digest,
    };
  }

  private recordsFailed(error: RecordWriteFailed): Promise<Outcome> {
    return this.conclude({ kind: "environment_failure", source: "records", error, detail: error.message });
  }

  /** The terminal for a stop signal observed between steps, or null to keep going. */
  private interruption(): Terminal | null {
    const { signal, clock } = this.deps;
    if (signal.aborted) {
      return { kind: "cancelled", reason: signal.reason, detail: `cancelled after ${this.turnsUsed} turn(s): ${describeErrorChain(signal.reason)}` };
    }
    const elapsedMs = clock.now() - this.startedAt;
    if (elapsedMs >= this.limits.wallClockMs) {
      return {
        kind: "wall_clock",
        wallClockMs: this.limits.wallClockMs,
        elapsedMs,
        detail: `wall clock of ${this.limits.wallClockMs} ms exhausted after ${elapsedMs} ms and ${this.turnsUsed} turn(s)`,
      };
    }
    return null;
  }
}
