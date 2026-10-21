import type { Logger } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { WorkItem } from "../domain/index.js";
import type { FaultClass } from "../acl/quality-acl.js";
import type { CoreLoopDeps, TaskRefusal } from "../types.js";
import { modelCallBlockCategory, projectBlockCause, projectCapCause, projectWorkCause } from "../project-halt.js";

/**
 * Infrastructure faults a task's dispatches meet, each requeued uncharged, before its project halts
 * as infrastructure. Why 3: it equals the attempts a task's own work
 * gets, so a fault that is not the task's is retried as often as one that
 * is. The fault past it halts the project once with its report; the substrate probe resumes the
 * project, and one more fault on the same task after that gives the task up: the probe passes but
 * this task's machines keep failing, so the fault is not one the halt can wait out.
 */
export const INFRASTRUCTURE_FAULT_BUDGET = 3;

/**
 * Why a dispatch stopped on something that is not the task's work (development's fault-class.ts):
 * its class, what was unavailable, and the fault's own diagnostic.
 */
export interface InfrastructureFault {
  readonly class: Exclude<FaultClass, "agent_work">;
  readonly unavailable: string;
  readonly reason: string;
}

/** Where a halt is written and reported. */
interface HaltDeps {
  readonly projects: Pick<CoreLoopDeps["projectRepo"], "block">;
  readonly logger: Logger;
}

/** The project's cause on record when a task's substrate faults spent their budget. */
class InfrastructureFaultBudgetSpent extends Error {
  constructor(
    readonly taskId: string,
    readonly faults: number,
    readonly fault: InfrastructureFault,
  ) {
    super(
      `task ${taskId} met ${faults} infrastructure fault(s), past the budget of ${INFRASTRUCTURE_FAULT_BUDGET} uncharged ` +
        `requeues; the project halts until the substrate probe passes. The last fault: ${fault.unavailable} ` +
        `unavailable: ${fault.reason}`,
    );
    this.name = "InfrastructureFaultBudgetSpent";
  }
}

/** The project's cause on record when a task's faults spent their budget and the last was Ashara's own. */
class AsharaFaultBudgetSpent extends Error {
  constructor(
    readonly taskId: string,
    readonly faults: number,
    readonly fault: InfrastructureFault,
  ) {
    super(
      `task ${taskId} met ${faults} fault(s) that were not its work, past the budget of ${INFRASTRUCTURE_FAULT_BUDGET} uncharged ` +
        `requeues, the last of Ashara's own machinery; the project halts until the operator repairs it. The last fault: ` +
        `${fault.unavailable}: ${fault.reason}`,
    );
    this.name = "AsharaFaultBudgetSpent";
  }
}

/** The project's cause on record when a task's faults spent their budget and the last was its model provider's. */
class ProviderFaultBudgetSpent extends Error {
  constructor(
    readonly taskId: string,
    readonly faults: number,
    readonly fault: InfrastructureFault,
  ) {
    super(
      `task ${taskId} met ${faults} fault(s) that were not its work, past the budget of ${INFRASTRUCTURE_FAULT_BUDGET} uncharged ` +
        `requeues, the last its model provider failing a request; the project halts until the operator looks into it. The last ` +
        `fault: ${fault.unavailable}: ${fault.reason}`,
    );
    this.name = "ProviderFaultBudgetSpent";
  }
}

/**
 * Halts the project of a task whose fault spent the budget, under the fault's class: a substrate
 * fault on infrastructure, which the substrate probe resumes; Ashara's own, or its model
 * provider's, as a fault, which the operator repairs.
 */
export async function haltOnFaultBudget(deps: HaltDeps, task: WorkItem, faults: number, fault: InfrastructureFault): Promise<void> {
  if (fault.class === "substrate") {
    const err = new InfrastructureFaultBudgetSpent(task.id, faults, fault);
    const halted = await deps.projects.block(task.projectId, { ...projectBlockCause(err), category: "infrastructure" });
    deps.logger.info("delivery.project-halted", `project ${task.projectId} ${halted} on infrastructure: ${err.message}`, {
      taskId: task.id,
      projectId: task.projectId,
      faultClass: fault.class,
      result: halted,
    });
    return;
  }
  // The fault's class was read by the one classifier when the task was blocked under it
  // (modelCallFailureOf, through environmentBlocked's fault): the halt is blamed the same way.
  const err = fault.class === "provider" ? new ProviderFaultBudgetSpent(task.id, faults, fault) : new AsharaFaultBudgetSpent(task.id, faults, fault);
  const cause = { ...projectBlockCause(err), category: modelCallBlockCategory(fault.class) };
  const halted = await deps.projects.block(task.projectId, cause);
  const message = `project ${task.projectId} ${halted} on a fault that was not its work (${fault.class}): ${err.message}`;
  const fields = { taskId: task.id, projectId: task.projectId, faultClass: fault.class, result: halted };
  if (fault.class === "ashara") deps.logger.error("delivery.project-halted", message, fields, err);
  else deps.logger.info("delivery.project-halted", message, fields);
}

/**
 * Blocks the project a refusal names: its configuration, its spend cap or its spent work budget.
 * Finance refuses, and the halt is Delivery's. A deployment's or a task's refusal blocks no project.
 */
export async function haltOnRefusal(deps: HaltDeps, task: WorkItem, refusal: TaskRefusal): Promise<void> {
  if (refusal.kind === "configuration") {
    const blocked = await deps.projects.block(task.projectId, {
      category: "configuration",
      errorClass: refusal.errorClass,
      reason: refusal.reason,
    });
    deps.logger.info("delivery.project-blocked", `project ${task.projectId} ${blocked} on a configuration fault (${refusal.errorClass}): ${refusal.reason}`, {
      taskId: task.id,
      projectId: task.projectId,
      category: "configuration",
      result: blocked,
    });
  } else if (refusal.kind === "project") {
    const blocked = await deps.projects.block(task.projectId, projectCapCause(refusal));
    deps.logger.info("delivery.project-blocked", `project ${task.projectId} ${blocked} at its spend cap: ${refusal.reason}`, {
      taskId: task.id,
      projectId: task.projectId,
      category: "budget_cap",
      result: blocked,
    });
  } else if (refusal.kind === "project_work") {
    const blocked = await deps.projects.block(task.projectId, projectWorkCause(refusal));
    deps.logger.info("delivery.project-blocked", `project ${task.projectId} ${blocked} on its spent work budget: ${refusal.reason}`, {
      taskId: task.id,
      projectId: task.projectId,
      category: "work_budget",
      result: blocked,
    });
  }
}

/**
 * A project's refusal that surfaced as a throw, not as a refused result, still halts the project:
 * at its spend cap, or on its spent work budget, wherever the refusal surfaces.
 */
export async function haltOnProjectRefusal(deps: Pick<CoreLoopDeps, "spendCap" | "projectRepo" | "logger">, task: WorkItem, error: unknown): Promise<void> {
  const refusal = deps.spendCap.refusalOf(error);
  if (refusal?.kind === "project" || refusal?.kind === "project_work") {
    await haltOnRefusal({ projects: deps.projectRepo, logger: deps.logger }, task, refusal);
  }
}

/** A throw out of the dispatch's own steps (Z0's store, its code): Ashara's, never the task's work. */
export function asharaFaultOf(e: unknown, step: string): InfrastructureFault {
  return { class: "ashara", unavailable: `Ashara's own machinery (${step})`, reason: describeErrorChain(e) };
}
