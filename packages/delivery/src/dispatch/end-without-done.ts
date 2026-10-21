import { cleanupWorkdir, commitPartialWork } from "@ashara/execution-infra";
import {
  VerificationInfrastructureFault,
  WORK_FAILED,
  agentWorkOf,
  describeAgentWork,
  discardCheckWorkdir,
  environmentBlocked,
  environmentErrorOf,
  unavailableOf,
} from "@ashara/quality";
import type { AgentWork, DispatchWork, ExecutionResult, TaskChecks } from "@ashara/quality";
import { wrapError } from "@ashara/shared";
import type { ErrorEnvelope, Outcome } from "@ashara/workplace";
import { attemptSummary, outcomeRecord, turnFailureOf } from "@ashara/workplace";
import type { Dispatch, DispatchContext } from "./dispatch-types.js";

/** An attempt that ended other than finished(done). */
interface EndedRun {
  readonly context: DispatchContext;
  readonly dispatch: Dispatch;
  readonly outcome: Outcome;
}

/** What every ending reports with: what was kept of the agent's work, and the chain's diagnostic context. */
interface Ending {
  readonly context: DispatchContext;
  readonly dispatch: Dispatch;
  readonly agentWork: Exclude<AgentWork, "none">;
  /** Discipline C: task, model, turns, last tool call and the terminal's own detail. */
  readonly chainFields: Readonly<Record<string, unknown>>;
}

type OutcomeOf<K extends Outcome["kind"]> = Extract<Outcome, { readonly kind: K }>;

/**
 * The stored check a dispute names, with the revision holding it and the task it decides: one of
 * the dispatched task's own checks when `ofTask` is null, else one of the merged task `ofTask`'s
 * latest checks (the regression suite its merge must pass). null when no stored check is so named.
 */
function disputedCheckOf(
  taskId: string,
  work: Extract<DispatchWork, { readonly kind: "stored-checks" }>,
  checkName: string,
  ofTask: string | null,
): { readonly revision: TaskChecks; readonly check: TaskChecks["checks"][number]; readonly checksOf: string } | null {
  const revision = ofTask === null ? work.stored : work.merged.find((prior) => prior.taskId === ofTask);
  if (revision === undefined) return null;
  const check = revision.checks.find((candidate) => candidate.name === checkName);
  if (check === undefined) return null;
  return { revision, check, checksOf: ofTask ?? taskId };
}

/**
 * Every terminal except finished(done): finished(blocked) is `blocked`; a cell that failed under
 * the attempt is environment-blocked (the operator's to fix), and so is a model call that failed
 * (transport_exhausted), under the provider's or Ashara's class; a turn that did not fit its
 * model's window (context_budget_exceeded) is `context_exceeded`, with the catalog model of a
 * larger window the task is dispatched on next, or none; every other terminal is `failed`
 * with the terminal named. None of them is read as completed on the agent's word: only a check
 * author's `blocked` whose checked task Z0 finds delivered on main completes (checkedTaskOnMain).
 */
export async function endWithoutDone({ context, dispatch: d, outcome }: EndedRun): Promise<ExecutionResult> {
  const { deps, verification } = context;
  const { task, staff, workDir, targetProjectPath } = d;
  let agentWork: Exclude<AgentWork, "none">;
  if (d.work.kind === "check-authoring") {
    // Nothing of a check task is kept for a retry: the next attempt starts again from main.
    await discardCheckWorkdir(workDir, targetProjectPath, d.work.branch, deps.logger);
    agentWork = "discarded";
  } else {
    agentWork = agentWorkOf(
      await commitPartialWork(d.repo, `ashara: partial work for retry (task ${task.id}, dispatch ${task.attempt}, ${outcome.kind})`),
    );
    await cleanupWorkdir(workDir, targetProjectPath);
  }

  const ending: Ending = {
    context,
    dispatch: d,
    agentWork,
    chainFields: {
      taskId: task.id,
      role: staff.role,
      provider: staff.model.provider,
      model: staff.model.modelId,
      outcome: outcome.kind,
      turnCount: outcome.turnsUsed,
      lastToolCall: outcome.lastToolCall,
      records: d.records.dir,
    },
  };

  if (outcome.kind === "environment_failure") return environmentFailed(ending, outcome);
  if (outcome.kind === "transport_exhausted") return modelCallFailed(ending, outcome);
  if (outcome.kind === "context_budget_exceeded") return windowExceeded(ending, outcome);
  if (outcome.kind === "refused") return attemptRefused(ending, outcome);

  // Identified by the abort reason itself, not its text: the cancellation carries the very
  // reason this process's shutdown signal was aborted with. Any other cancellation stays a failure.
  const shutdown = deps.shutdownSignal;
  if (outcome.kind === "cancelled" && shutdown.aborted && outcome.reason === shutdown.reason) return shutdownInterrupted(ending, outcome);

  // Workplace offers dispute_check only to implementation work with stored checks, and only for
  // the names of its own checks or of a merged task's; a dispute that
  // names no stored check falls through to failed below.
  const disputed = outcome.kind === "disputed" && d.work.kind === "stored-checks" ? disputedCheckOf(task.id, d.work, outcome.checkName, outcome.ofTask) : null;
  if (outcome.kind === "disputed" && disputed !== null) return checkDisputed(ending, outcome, disputed);

  let notDelivered = "";
  if (outcome.kind === "finished" && d.work.kind === "check-authoring") {
    const evaluated = await verification.delivered.checkedTaskOnMain(d, d.work, outcome);
    if ("status" in evaluated) return evaluated;
    notDelivered = `; Z0 does not find it delivered: ${evaluated.why}`;
  }

  if (outcome.kind === "finished") {
    const chain = wrapError("development", "agentAttempt", `${outcome.blockedReason ?? outcome.summary}${notDelivered}`, ending.chainFields);
    const envelope: ErrorEnvelope = {
      outcome: "blocked",
      summary: `agent reported blocked after ${outcome.turnsUsed} turns: ${attemptSummary(outcome)}${notDelivered}`,
      chain,
      agentOutput: outcomeRecord(outcome),
    };
    return {
      status: "blocked",
      verdict: WORK_FAILED,
      detail: envelope.summary,
      outcome,
      sessionId: d.sessionId,
      attempt: task.attempt,
      errorEnvelope: envelope,
    };
  }

  const cause = outcome.kind === "cancelled" ? outcome.reason : outcome.detail;
  const chain = wrapError("development", "agentAttempt", cause, ending.chainFields);
  const envelope: ErrorEnvelope = {
    outcome: "failed",
    summary: `attempt ended as ${outcome.kind} after ${outcome.turnsUsed} turn(s) on ${staff.model.provider}/${staff.model.modelId}: ${outcome.detail}`,
    chain,
    agentOutput: outcomeRecord(outcome),
  };
  return {
    status: "failed",
    verdict: WORK_FAILED,
    detail: envelope.summary,
    outcome,
    sessionId: d.sessionId,
    attempt: task.attempt,
    errorEnvelope: envelope,
  };
}

/**
 * Workplace already told the substrate's failure from the tool's own (classifyCellError);
 * a records sink that cannot write is the same kind of failure, on the Z0 side.
 * run_checks runs in a CI cell of its own, and Z0's machinery around it is no cell at all.
 */
function environmentFailed({ context, dispatch: d, agentWork, chainFields }: Ending, outcome: OutcomeOf<"environment_failure">): ExecutionResult {
  const errorClass = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error;
  const typed = environmentErrorOf(outcome.error);
  const cell = outcome.lastToolCall?.toolName === "run_checks" ? "CI cell (run_checks)" : "task cell";
  // Substrate only by its class (fault-class.ts); records that cannot be written, Z0's
  // verification machinery and anything unclassified are Ashara's (fail-closed).
  const fault = outcome.source !== "records" && typed !== null ? "substrate" : "ashara";
  const unavailable =
    outcome.source === "records"
      ? "attempt records"
      : outcome.error instanceof VerificationInfrastructureFault
        ? `verification infrastructure (${outcome.error.step})`
        : typed !== null
          ? unavailableOf(typed, cell)
          : `Ashara's own machinery under the ${cell}`;
  return environmentBlocked(
    {
      task: d.task,
      sessionId: d.sessionId,
      stage: "agentAttempt",
      fault,
      errorClass,
      message: `the attempt's environment failed (${outcome.source}) after ${outcome.turnsUsed} turn(s): ${outcome.detail}`,
      chain: wrapError("development", "agentAttempt", outcome.error, { ...chainFields, source: outcome.source, errorClass }),
      unavailable,
      outcome,
      agentWork,
    },
    context.deps.eventSink,
    context.deps.logger,
  );
}

/**
 * A model call that failed is never the agent's work: no answer of the model was read. It is
 * blocked under whose failure it was, the provider's or Ashara's own (turnFailureOf).
 */
function modelCallFailed({ context, dispatch: d, agentWork, chainFields }: Ending, outcome: OutcomeOf<"transport_exhausted">): ExecutionResult {
  const { staff } = d;
  const fault = turnFailureOf(outcome.error);
  const errorClass = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error;
  const model = `${staff.model.provider}/${staff.model.modelId}`;
  return environmentBlocked(
    {
      task: d.task,
      sessionId: d.sessionId,
      stage: "agentAttempt",
      fault,
      errorClass,
      message: `the attempt's model call failed after ${outcome.turnsUsed} turn(s): ${outcome.detail}`,
      chain: wrapError("development", "agentAttempt", outcome.error, { ...chainFields, errorClass, fault }),
      unavailable: fault === "provider" ? `model provider (${model})` : `Ashara's request to the model provider (${model})`,
      outcome,
      agentWork,
    },
    context.deps.eventSink,
    context.deps.logger,
  );
}

/**
 * Deterministic: the same model meets the same window, so it is never the agent's failure nor
 * retried on that model. The next dispatch is on a model whose window is larger, or none is.
 */
function windowExceeded({ context, dispatch: d, agentWork, chainFields }: Ending, outcome: OutcomeOf<"context_budget_exceeded">): ExecutionResult {
  const { deps } = context;
  const { task, staff } = d;
  const { windowTokens, outputReserveTokens, breach } = outcome.error.context;
  const widerModel = deps.staffing.widerModel(task, windowTokens);
  const wider =
    widerModel === null
      ? null
      : { provider: widerModel.provider, modelId: widerModel.modelId, windowTokens: widerModel.modelConfig.maxContextTokens };
  const estimate =
    breach.source === "preflight"
      ? `its projected input of ${breach.projectedInputTokens} tokens (${breach.basis}) exceeds the window less the output reserve`
      : `the provider rejected it as longer than the window: ${breach.providerMessage}`;
  const next =
    wider === null
      ? `no catalog model graded for the task has a window larger than ${windowTokens} tokens`
      : `its next dispatch is on ${wider.provider}/${wider.modelId}, window ${wider.windowTokens} tokens`;
  const summary =
    `turn ${outcome.turn} did not fit the ${windowTokens}-token window of ${staff.model.provider}/${staff.model.modelId} ` +
    `(output reserve ${outputReserveTokens}) after ${outcome.turnsUsed} turn(s): ${estimate}; ${next}; ${describeAgentWork(agentWork)}`;
  deps.logger.info("delivery.context-exceeded", summary, { taskId: task.id, attempt: task.attempt, windowTokens, outputReserveTokens });
  deps.eventSink?.emit({
    event: "context_exceeded",
    taskId: task.id,
    attempt: task.attempt,
    provider: staff.model.provider,
    model: staff.model.modelId,
    windowTokens,
    outputReserveTokens,
    source: breach.source,
    wider: wider === null ? null : `${wider.provider}/${wider.modelId}`,
  });
  return {
    status: "context_exceeded",
    model: { provider: staff.model.provider, modelId: staff.model.modelId },
    windowTokens,
    outputReserveTokens,
    projectedInputTokens: breach.source === "preflight" ? breach.projectedInputTokens : null,
    providerMessage: breach.source === "provider" ? breach.providerMessage : null,
    wider,
    detail: summary,
    outcome,
    sessionId: d.sessionId,
    attempt: task.attempt,
    errorEnvelope: {
      outcome: "blocked",
      summary,
      chain: wrapError("development", "agentAttempt", outcome.error, { ...chainFields, errorClass: outcome.error.name, windowTokens }),
      agentOutput: outcomeRecord(outcome),
    },
  };
}

function attemptRefused({ context, dispatch: d, agentWork, chainFields }: Ending, outcome: OutcomeOf<"refused">): ExecutionResult {
  const { deps } = context;
  const { task } = d;
  const summary = `attempt stopped after ${outcome.turnsUsed} turn(s): ${outcome.detail}; ${describeAgentWork(agentWork)}`;
  deps.logger.info("delivery.attempt-refused", summary, { taskId: task.id, attempt: task.attempt, errorClass: outcome.error.name });
  deps.eventSink?.emit({ event: "task_refused", taskId: task.id, attempt: task.attempt, errorClass: outcome.error.name, reason: summary });
  return {
    status: "refused",
    refusal: outcome.error,
    detail: summary,
    outcome,
    sessionId: d.sessionId,
    attempt: task.attempt,
    errorEnvelope: {
      outcome: "blocked",
      summary,
      chain: wrapError("development", "agentAttempt", outcome.error, { ...chainFields, errorClass: outcome.error.name }),
      agentOutput: outcomeRecord(outcome),
    },
  };
}

function shutdownInterrupted({ context, dispatch: d, agentWork, chainFields }: Ending, outcome: OutcomeOf<"cancelled">): ExecutionResult {
  const { deps } = context;
  const { task } = d;
  const summary = `attempt interrupted by shutdown after ${outcome.turnsUsed} turn(s); ${describeAgentWork(agentWork)}`;
  deps.logger.info("delivery.attempt-interrupted", summary, { taskId: task.id, attempt: task.attempt, turns: outcome.turnsUsed });
  deps.eventSink?.emit({ event: "task_interrupted", taskId: task.id, attempt: task.attempt, turns: outcome.turnsUsed });
  return {
    status: "interrupted",
    detail: summary,
    outcome,
    sessionId: d.sessionId,
    attempt: task.attempt,
    errorEnvelope: {
      outcome: "blocked",
      summary,
      chain: wrapError("development", "agentAttempt", outcome.reason, chainFields),
      agentOutput: outcomeRecord(outcome),
    },
  };
}

function checkDisputed(
  { context, dispatch: d, agentWork, chainFields }: Ending,
  outcome: OutcomeOf<"disputed">,
  disputed: NonNullable<ReturnType<typeof disputedCheckOf>>,
): ExecutionResult {
  const { deps } = context;
  const { task } = d;
  const { revision: stored, check, checksOf } = disputed;
  const whose = checksOf === task.id ? "" : ` of merged task ${checksOf}`;
  const summary =
    `check ${JSON.stringify(check.name)}${whose} (revision ${stored.revision}, check task ${stored.checkTaskId}) disputed ` +
    `after ${outcome.turnsUsed} turn(s): ${outcome.reason}; ${describeAgentWork(agentWork)}`;
  deps.logger.info("delivery.check-disputed", summary, { taskId: task.id, attempt: task.attempt, check: check.name, checkTaskId: stored.checkTaskId });
  deps.eventSink?.emit({
    event: "check_disputed",
    taskId: task.id,
    attempt: task.attempt,
    checksOf,
    checkTaskId: stored.checkTaskId,
    revision: stored.revision,
    check: check.name,
    reason: outcome.reason,
  });
  return {
    status: "disputed",
    checksOf,
    checkTaskId: stored.checkTaskId,
    revision: stored.revision,
    check: { name: check.name, command: check.command },
    reason: outcome.reason,
    evidence: outcome.evidence,
    detail: summary,
    outcome,
    sessionId: d.sessionId,
    attempt: task.attempt,
    errorEnvelope: {
      outcome: "blocked",
      summary,
      chain: wrapError("development", "agentAttempt", outcome.reason, { ...chainFields, checksOf, checkTaskId: stored.checkTaskId, check: check.name }),
      agentOutput: outcomeRecord(outcome),
    },
  };
}
