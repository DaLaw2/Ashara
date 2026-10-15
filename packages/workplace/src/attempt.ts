import type { ModelMessage, ToolResultPart } from "ai";
import type { CellBackend } from "@ashara/execution-infra";
import { PreCallRefusal } from "@ashara/finance";
import type { ContextualTurnLlm, CostedTurnResult } from "@ashara/finance";
import { describeErrorChain, serializeError } from "@ashara/shared";
import type { Clock } from "@ashara/shared";
import type { Assignment } from "./assignment.js";
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

/**
 * The routing site agent work is tagged with today (model-access KNOWN_LLM_SITES, config/models.toml):
 * the llm_calls rows of an attempt carry it, and the caller resolves the pinned model with it.
 */
const AGENT_CALL_SITE = "agent-runner";

export interface AttemptDeps {
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

class RecordWriteFailed extends Error {
  constructor(record: AttemptRecord["kind"], options: ErrorOptions) {
    super(`Writing the "${record}" attempt record failed: ${describeErrorChain(options.cause)}`, options);
    this.name = "RecordWriteFailed";
  }
}

/**
 * Runs one attempt of an assignment: an explicit loop in Z0 (ADR-074 d7, no SDK stopWhen) where each
 * turn is one recorded model call and each returned tool call runs, in order, through the cell.
 * Resolves to exactly one Outcome terminal; throws only InvalidAssignment, before any call is made.
 */
export async function runAttempt(assignment: Assignment, deps: AttemptDeps): Promise<Outcome> {
  const limits = resolveLimits(assignment);
  const isEnvironmentWork = assignment.workKind === "environment";
  if (isEnvironmentWork !== (deps.environment !== null)) {
    throw new InvalidAssignment(assignment.taskId, [
      isEnvironmentWork
        ? "environment: an environment assignment needs Z0's environment check for build_environment"
        : `environment: only an environment assignment may be given Z0's environment check (work kind ${assignment.workKind ?? "none"})`,
    ]);
  }
  const isCheckWork = assignment.workKind === "check";
  if (isCheckWork !== (deps.checks !== null)) {
    throw new InvalidAssignment(assignment.taskId, [
      isCheckWork
        ? "checks: a check assignment needs Z0's check recorder for define_check"
        : `checks: only a check assignment may be given Z0's check recorder (work kind ${assignment.workKind ?? "none"})`,
    ]);
  }
  // run_checks is implementation work's: check work writes checks, environment work is decided by its gate.
  if ((isCheckWork || isEnvironmentWork) && deps.taskChecks !== null) {
    throw new InvalidAssignment(assignment.taskId, [
      `taskChecks: only implementation work runs stored checks (work kind ${assignment.workKind ?? "none"})`,
    ]);
  }
  const tools = toolSchemasFor(assignment.workKind, deps.taskChecks !== null);
  const { clock, signal } = deps;
  const startedAt = clock.now();
  const deadline = startedAt + limits.wallClockMs;
  const llm = deps.llm.forCall({ projectId: assignment.projectId, taskId: assignment.taskId, callSite: AGENT_CALL_SITE });
  const system = buildSystemPrompt(assignment.brief, assignment.workKind);
  const messages: ModelMessage[] = [{ role: "user", content: FIRST_MESSAGE }];
  // Taken before the loop appends to `messages`: exactly what the first call is sent.
  const digest = promptDigest({ system, messages, tools });
  const costs = new CostTally();
  let turnsUsed = 0;
  let lastToolCall: LastToolCall | null = null;
  /** A dispute's evidence: what the checks printed the last time the implementer ran them. */
  let lastCheckRun: string | null = null;

  async function record(entry: AttemptRecord): Promise<RecordWriteFailed | null> {
    try {
      await deps.records.append(entry);
      return null;
    } catch (error) {
      return new RecordWriteFailed(entry.kind, { cause: error });
    }
  }

  async function conclude(terminal: Terminal): Promise<Outcome> {
    const outcome: Outcome = { ...terminal, turnsUsed, cost: costs.snapshot(), lastToolCall, promptDigest: digest };
    const failed = await record({ kind: "outcome", at: clock.now(), outcome: toRecordedOutcome(outcome) });
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

  function recordsFailed(error: RecordWriteFailed): Promise<Outcome> {
    return conclude({ kind: "environment_failure", source: "records", error, detail: error.message });
  }

  /** The terminal for a stop signal observed between steps, or null to keep going. */
  function interruption(): Terminal | null {
    if (signal.aborted) {
      return { kind: "cancelled", reason: signal.reason, detail: `cancelled after ${turnsUsed} turn(s): ${describeErrorChain(signal.reason)}` };
    }
    const elapsedMs = clock.now() - startedAt;
    if (elapsedMs >= limits.wallClockMs) {
      return {
        kind: "wall_clock",
        wallClockMs: limits.wallClockMs,
        elapsedMs,
        detail: `wall clock of ${limits.wallClockMs} ms exhausted after ${elapsedMs} ms and ${turnsUsed} turn(s)`,
      };
    }
    return null;
  }

  const started = await record({
    kind: "attempt_started",
    at: startedAt,
    projectId: assignment.projectId,
    taskId: assignment.taskId,
    role: { id: assignment.role.id, name: assignment.role.name },
    provider: assignment.model.provider,
    modelId: assignment.model.modelId,
    cellImage: assignment.cellImage,
    limits,
    system,
    firstMessage: FIRST_MESSAGE,
    promptDigest: digest,
  });
  if (started !== null) return recordsFailed(started);

  for (;;) {
    const stop = interruption();
    if (stop !== null) return conclude(stop);
    if (turnsUsed >= limits.maxTurns) {
      return conclude({ kind: "turn_cap", maxTurns: limits.maxTurns, detail: `turn cap of ${limits.maxTurns} reached without finish` });
    }

    turnsUsed += 1;
    const turn = turnsUsed;
    // Real time, not the injected clock: the clock decides the terminal between steps; this timer
    // only bounds a model call that would otherwise outlive the attempt.
    const wallClock = new AbortController();
    const timer = setTimeout(() => wallClock.abort(new AttemptWallClockExhausted(turn, limits.wallClockMs)), Math.max(0, deadline - clock.now()));
    let result: CostedTurnResult;
    try {
      result = await llm.generateTurn({
        model: assignment.model,
        system,
        messages,
        tools,
        abortSignal: AbortSignal.any([signal, wallClock.signal]),
      });
    } catch (error) {
      const refusal = preCallRefusalOf(error);
      // A refused request was never sent, so it cost nothing: it is not an unmeasured turn.
      const serialized = serializeError(error);
      if (refusal === null) costs.addUnknown(turn, `the call failed before returning a cost (${serialized.name})`);
      const failed = await record({ kind: "turn_failed", at: clock.now(), turn, error: serialized });
      if (failed !== null) return recordsFailed(failed);
      if (refusal !== null) {
        return conclude({
          kind: "refused",
          error: refusal,
          detail: `turn ${turn} model call to ${assignment.model.provider}/${assignment.model.modelId} was refused before it was sent (${refusal.name}): ${refusal.message}`,
        });
      }
      if (wallClock.signal.aborted && !signal.aborted) {
        const elapsedMs = clock.now() - startedAt;
        return conclude({
          kind: "wall_clock",
          wallClockMs: limits.wallClockMs,
          elapsedMs,
          detail: `wall clock of ${limits.wallClockMs} ms ran out during turn ${turn}'s model call`,
        });
      }
      const stopped = interruption();
      if (stopped !== null) return conclude(stopped);
      return conclude({
        kind: "transport_exhausted",
        error,
        detail: `turn ${turn} model call to ${assignment.model.provider}/${assignment.model.modelId} failed: ${describeErrorChain(error)}`,
      });
    } finally {
      clearTimeout(timer);
    }

    costs.add(turn, result.cost);
    const turnRecorded = await record({
      kind: "turn",
      at: clock.now(),
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
    if (turnRecorded !== null) return recordsFailed(turnRecorded);
    messages.push(result.assistant);

    if (result.finishReason === "provider_error") {
      const error = new ProviderErrorFinish(turn, result.provider, result.model, result.rawFinishReason);
      return conclude({ kind: "transport_exhausted", error, detail: error.message });
    }
    // Checked before any tool call runs: a call in a cut response may be cut itself.
    if (result.finishReason === "truncated") {
      const tokens = result.reportedOutputTokens === null ? "an unreported number of" : String(result.reportedOutputTokens);
      return conclude({
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
      });
    }
    if (result.toolCalls.length === 0) {
      return conclude({
        kind: "model_stopped_without_finish",
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        finalText: truncateText(result.text),
        detail: `turn ${turn}: the model stopped (${result.finishReason}) without calling finish`,
      });
    }

    const toolResults: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      const between = interruption();
      if (between !== null) return conclude(between);
      lastToolCall = { turn, toolName: call.toolName, input: describeInput(call.input) };

      const remainingSeconds = Math.max(1, Math.ceil((deadline - clock.now()) / 1000));
      const execution =
        call.kind === "invalid"
          ? { kind: "result" as const, isError: true, output: truncateText(`Invalid tool call ${call.toolName}: ${call.error}. Fix the call and try again.`) }
          : await executeTool(call.toolName, call.input, {
              cell: deps.cell,
              commandTimeoutSeconds: Math.min(limits.perCommandTimeoutSeconds, remainingSeconds),
              tools,
              environment: deps.environment,
              checks: deps.checks,
              taskChecks: deps.taskChecks,
            });

      if (execution.kind === "finish") {
        const { args } = execution;
        return conclude({
          kind: "finished",
          status: args.status,
          summary: args.summary,
          blockedReason: args.status === "blocked" ? args.blockedReason : null,
          statement: args.status === "done" && "statement" in args ? args.statement : null,
          detail: `turn ${turn}: the model called finish with status ${args.status}`,
        });
      }
      if (execution.kind === "dispute") {
        return conclude({
          kind: "disputed",
          checkName: execution.checkName,
          ofTask: execution.ofTask,
          reason: execution.reason,
          evidence: lastCheckRun,
          detail:
            `turn ${turn}: the model disputed check ${JSON.stringify(execution.checkName)}` +
            `${execution.ofTask === null ? "" : ` of merged task ${execution.ofTask}`}: ${execution.reason}`,
        });
      }
      if (execution.kind === "environment_failure") {
        return conclude({
          kind: "environment_failure",
          source: "cell",
          error: execution.error,
          detail: `turn ${turn}: ${execution.toolName} could not run in the cell: ${describeErrorChain(execution.error)}`,
        });
      }

      const resultRecorded = await record({
        kind: "tool_result",
        at: clock.now(),
        turn,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        isError: execution.isError,
        output: execution.output,
      });
      if (resultRecorded !== null) return recordsFailed(resultRecorded);
      if (call.kind === "valid" && call.toolName === "run_checks") lastCheckRun = execution.output;
      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: execution.isError ? { type: "error-text", value: execution.output } : { type: "text", value: execution.output },
      });
    }
    messages.push({ role: "tool", content: toolResults });
  }
}
