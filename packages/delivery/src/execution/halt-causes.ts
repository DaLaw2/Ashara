import type { Logger } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { WorkItem } from "../domain/index.js";
import type { FaultClass } from "../acl/quality-acl.js";
import type { LoopCore, TaskRefusal } from "../types.js";
import { projectCapCause, projectWorkCause } from "../project-halt.js";

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
  readonly projects: Pick<LoopCore["projectRepo"], "block">;
  readonly logger: Logger;
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
export async function haltOnProjectRefusal(deps: Pick<LoopCore, "spendCap" | "projectRepo" | "logger">, task: WorkItem, error: unknown): Promise<void> {
  const refusal = deps.spendCap.refusalOf(error);
  if (refusal?.kind === "project" || refusal?.kind === "project_work") {
    await haltOnRefusal({ projects: deps.projectRepo, logger: deps.logger }, task, refusal);
  }
}

/** A throw out of the dispatch's own steps (Z0's store, its code): Ashara's, never the task's work. */
export function asharaFaultOf(e: unknown, step: string): InfrastructureFault {
  return { class: "ashara", unavailable: `Ashara's own machinery (${step})`, reason: describeErrorChain(e) };
}
