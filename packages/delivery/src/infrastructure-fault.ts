import type { Logger } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution/halt-causes.js";
import type { InfrastructureFault } from "./execution/halt-causes.js";
import { modelCallBlockCategory, projectBlockCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";

// A charge for a fault that is not a task's work (its infrastructure faults counted, the budget read,
// its project halted past it) is made here alone, in the one transaction that holds the task's
// project row and then its row locked (withItemLocked), and only while the task is in the status the
// charge is for. The owner may move the task at any moment: a transition committed first is read
// under the lock and nothing is charged; one made after waits for the charge's commit.

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
 * What a charge counts on the task and when it halts the task's project:
 * - `dispatch`: a fault under a dispatch, counted. The fault past the budget halts the project under
 *   the fault's class: a substrate fault on infrastructure, which the substrate probe resumes;
 *   Ashara's own, or its model provider's, as a fault, which the operator repairs. A fault after that
 *   is `spent`: the halt could not wait it out, and the task is the caller's to give up.
 * - `unread-main`: main unread on a transient fault, counted; every fault past the budget halts the
 *   project on `halt`.
 * - `halt-now`: a fault no retry clears; the project halts on `halt` at once, nothing counted.
 */
type FaultCharge =
  | { readonly kind: "dispatch"; readonly fault: InfrastructureFault }
  | { readonly kind: "unread-main"; readonly halt: Error }
  | { readonly kind: "halt-now"; readonly halt: Error };

/**
 * A charge's writes as committed: none (the task was not in the status charged, or is gone), the
 * count after it with the halt it raised, if any, or the project halted with nothing counted.
 */
export type FaultChargeOutcome =
  | { readonly kind: "uncharged"; readonly found: WorkItemStatus | "gone" }
  | { readonly kind: "within"; readonly faults: number }
  | { readonly kind: "halted"; readonly faults: number; readonly result: "blocked" | "already-blocked" }
  | { readonly kind: "halted-uncounted"; readonly result: "blocked" | "already-blocked" }
  | { readonly kind: "spent"; readonly faults: number };

/** Where a charge is written and reported. */
export interface FaultChargeDeps {
  readonly workItemRepo: Pick<WorkItemRepository, "withItemLocked">;
  readonly logger: Logger;
}

/** One charge: the task, the status it is charged in, what is charged, and the step it is charged for (in its log). */
export interface FaultChargeRequest {
  readonly task: WorkItem;
  readonly expected: WorkItemStatus;
  readonly charge: FaultCharge;
  readonly step: string;
}

/** The halt a charge raises, and how it is reported. */
interface Halt {
  readonly error: Error;
  readonly cause: ProjectBlockCause;
  readonly faultClass: InfrastructureFault["class"];
  readonly summary: string;
}

function dispatchHalt(task: WorkItem, faults: number, fault: InfrastructureFault): Halt {
  if (fault.class === "substrate") {
    const error = new InfrastructureFaultBudgetSpent(task.id, faults, fault);
    return { error, cause: { ...projectBlockCause(error), category: "infrastructure" }, faultClass: fault.class, summary: "on infrastructure" };
  }
  // The fault's class was read by the one classifier when the task was blocked under it
  // (modelCallFailureOf, through environmentBlocked's fault): the halt is blamed the same way.
  const error = fault.class === "provider" ? new ProviderFaultBudgetSpent(task.id, faults, fault) : new AsharaFaultBudgetSpent(task.id, faults, fault);
  return {
    error,
    cause: { ...projectBlockCause(error), category: modelCallBlockCategory(fault.class) },
    faultClass: fault.class,
    summary: `on a fault that was not its work (${fault.class})`,
  };
}

function asharaHalt(error: Error): Halt {
  return { error, cause: projectBlockCause(error), faultClass: "ashara", summary: "on Ashara's own fault" };
}

type Locked = { readonly outcome: FaultChargeOutcome; readonly halt: Halt | null };

function within(faults: number): Locked {
  return { outcome: { kind: "within", faults }, halt: null };
}

/**
 * Charges `request.task` for a fault that is not its work, in the transaction that holds its project
 * row and then its row locked, only while it is still `request.expected` as read under that lock; a
 * task gone is warned of and one moved is logged, and neither is charged. The count, the budget read
 * and the halt commit together, or none of them does: a read or write that fails throws.
 */
export async function chargeInfrastructureFault(
  deps: FaultChargeDeps,
  request: FaultChargeRequest & { readonly charge: { readonly kind: "dispatch" | "unread-main" } },
): Promise<Exclude<FaultChargeOutcome, { readonly kind: "halted-uncounted" }>>;
export async function chargeInfrastructureFault(deps: FaultChargeDeps, request: FaultChargeRequest): Promise<FaultChargeOutcome>;
export async function chargeInfrastructureFault(deps: FaultChargeDeps, request: FaultChargeRequest): Promise<FaultChargeOutcome> {
  const { task, expected, charge } = request;
  const locked = await deps.workItemRepo.withItemLocked(task, async (current, ledger): Promise<Locked> => {
    if (current === null || current.status !== expected) return { outcome: { kind: "uncharged", found: current?.status ?? "gone" }, halt: null };
    if (charge.kind === "halt-now") {
      const raised = asharaHalt(charge.halt);
      return { outcome: { kind: "halted-uncounted", result: await ledger.blockProject(task.projectId, raised.cause) }, halt: raised };
    }
    const halt = async (raised: Halt, faults: number): Promise<Locked> => ({
      outcome: { kind: "halted", faults, result: await ledger.blockProject(task.projectId, raised.cause) },
      halt: raised,
    });
    const faults = await ledger.recordInfrastructureFault(task.id);
    if (faults <= INFRASTRUCTURE_FAULT_BUDGET) return within(faults);
    if (charge.kind === "unread-main") return halt(asharaHalt(charge.halt), faults);
    if (faults > INFRASTRUCTURE_FAULT_BUDGET + 1) return { outcome: { kind: "spent", faults }, halt: null };
    return halt(dispatchHalt(task, faults, charge.fault), faults);
  });
  report(deps.logger, request, locked);
  return locked.outcome;
}

function report(logger: Logger, request: FaultChargeRequest, { outcome, halt }: Locked): void {
  const { task, step } = request;
  if (outcome.kind === "uncharged") {
    if (outcome.found === "gone") logger.warn("delivery.item-vanished", `the task is gone; nothing is charged for it (${step})`, { taskId: task.id });
    else logger.info("delivery.fault-uncharged", `it moved to ${outcome.found} before its charge; nothing is charged for it (${step})`, { taskId: task.id, status: outcome.found });
    return;
  }
  if (halt === null || (outcome.kind !== "halted" && outcome.kind !== "halted-uncounted")) return;
  const message = `project ${task.projectId} ${outcome.result} ${halt.summary}: ${halt.error.message}`;
  const fields = { taskId: task.id, projectId: task.projectId, faultClass: halt.faultClass, result: outcome.result };
  if (halt.faultClass === "ashara") logger.error("delivery.project-halted", message, fields, halt.error);
  else logger.info("delivery.project-halted", message, fields);
}
