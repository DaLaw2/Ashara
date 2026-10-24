import { cleanupWorkdir } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { outcomeRecord } from "@ashara/workplace";
import type { Outcome } from "@ashara/workplace";
import { asharaBlocked, thrownBlocked } from "../dispatch-result.js";
import type { ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { runSubstrateGate } from "../environment-check.js";
import type { EnvironmentStatementStore, SubstrateGateRun, TestedEnvironment } from "../environment-check.js";
import { environmentCheckPassed, formatEnvironmentCheck } from "../environment-verdict.js";
import { environmentErrorOf, VerificationInfrastructureFault } from "../fault-class.js";
import { WORK_FAILED } from "../task-verdict.js";
import type { DispatchCells } from "./dispatch-cells.js";

/** How a substrate-checked task's gate ended: passed with the image it tested, or the dispatch's result. */
type SubstrateGateOutcome =
  | { readonly kind: "passed"; readonly tested: TestedEnvironment }
  | { readonly kind: "ended"; readonly result: ExecutionResult };

export interface SubstrateGateDeps {
  readonly dispatchCells: Pick<DispatchCells, "environmentScope">;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  readonly statements: Pick<EnvironmentStatementStore, "record">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** The Sprint 0 merge gate: the environment the task defined parses, builds and passes its test. */
export class SubstrateGate {
  private readonly deps: SubstrateGateDeps;

  constructor(deps: SubstrateGateDeps) {
    this.deps = deps;
  }

  /**
   * The Sprint 0 gate (task_spec.checkedBy "substrate"), in place of per-task verify: on the agent's
   * work as committed to the task branch (commitWork), its environment definition must parse, its image
   * build and its `test` pass in a fresh CI cell. A failed gate is a task failure (the definition
   * is the environment role's work), never environment_unavailable; a substrate that cannot run
   * the gate blocks the task. On a pass the finish statement (the stack statement only, never the
   * summary) is kept on the work item; a done without one fails the task before the gate runs.
   */
  async substrateGate(d: VerifiedDispatch, statement: string | null, outcome: Outcome): Promise<SubstrateGateOutcome> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const fail = (summary: string, chain: ReturnType<typeof wrapError>): SubstrateGateOutcome => ({
      kind: "ended",
      result: { status: "failed", verdict: WORK_FAILED, detail: summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) } },
    });
    if (statement === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const summary = `substrate gate failed for ${task.id}: the attempt finished done without a stack statement (finish's statement field)`;
      return fail(summary, wrapError("development", "substrateGate", summary, { taskId: task.id }));
    }
    eventSink?.emit({ event: "substrate_gate_started", taskId: task.id, attempt: task.attempt, workDir });

    let run: SubstrateGateRun;
    try {
      run = await runSubstrateGate(this.deps.dispatchCells.environmentScope(d), attemptPolicy.perCommandTimeoutSeconds);
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const fault = environmentErrorOf(e) ?? new VerificationInfrastructureFault(task.id, "substrate gate run", { cause: e });
      return { kind: "ended", result: thrownBlocked({ task, sessionId, stage: "substrateGate", error: fault, where: { step: "substrate gate run", cell: "CI cell" }, agent: { outcome, agentWork: "kept" }, eventSink, logger: this.deps.logger }) };
    }

    const passed = environmentCheckPassed(run.report);
    const gateOutput = formatEnvironmentCheck(run.report);
    eventSink?.emit({ event: "substrate_gate_result", taskId: task.id, attempt: task.attempt, passed, report: run.report.kind, output: gateOutput });
    if (!passed || run.tested === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "substrateGate", gateOutput, { taskId: task.id, report: run.report.kind });
      return fail(`substrate gate failed for ${task.id}:\n${gateOutput}`, chain);
    }

    try {
      await this.deps.statements.record(task.id, statement, run.tested.version);
    } catch (e) {
      // The gate passed; only Z0's store failed to keep its statement, as recordRebuiltStatement's write.
      await cleanupWorkdir(workDir, targetProjectPath);
      const fault = new VerificationInfrastructureFault(task.id, `record the environment statement for version ${run.tested.version}`, { cause: e });
      return { kind: "ended", result: asharaBlocked({ task, sessionId, stage: "substrateGate", fault, agent: { outcome, agentWork: "kept" }, eventSink, logger: this.deps.logger }) };
    }
    return { kind: "passed", tested: run.tested };
  }
}
