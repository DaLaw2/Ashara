import type { LlmCallRepository } from "@ashara/db";
import { WorkBudgetSpent, WorkBudgetsInvalid } from "./errors.js";
import type { WorkAtBudget } from "./errors.js";
import type { PendingLlmCall } from "./guarded-model-access.js";

/** The model requests one task, and one project with all its tasks, may draw (ADR-084 decision 1). */
export interface WorkBudgets {
  readonly perTaskRequests: number;
  readonly perProjectRequests: number;
}

/**
 * Policy defaults (Decided: ADR-084 decision 1, owner 2026-10-16), each overridable by the
 * deployment's config. Per task 60: more than two full dispatches of the agent's 25 turns, so a
 * task's own retry bounds stop it first in the ordinary case and the ledger only where loops
 * compose. Per project 600: ten such tasks' worth, two orders of magnitude under the worst case
 * the loops compose to without it (loop-convergence investigation, about 108,000).
 */
export const DEFAULT_WORK_BUDGETS: WorkBudgets = { perTaskRequests: 60, perProjectRequests: 600 };

interface WorkLedgerDeps {
  /** llm_calls: the requests a scope has drawn, and the row a drawn request is written to. */
  readonly ledger: Pick<LlmCallRepository, "work" | "workBySite" | "admit">;
  readonly budgets: WorkBudgets;
}

/**
 * Finance's one work ledger (ADR-084 decision 1): the bound on how much model work a task and a
 * project get, in model requests, scoped project then task; the per-dispatch turn cap stays the
 * attempt's. Nothing here counts: a scope's drawn requests are its llm_calls rows, so a refund, an
 * unblock or a restart cannot return one, and the owner's recorded grant is the only way a
 * project's budget grows. A task draws only while its project has requests left.
 */
export class WorkLedger {
  constructor(private readonly deps: WorkLedgerDeps) {
    const { perTaskRequests, perProjectRequests } = deps.budgets;
    const valid = Number.isSafeInteger(perTaskRequests) && perTaskRequests > 0 && Number.isSafeInteger(perProjectRequests) && perProjectRequests > 0;
    if (!valid) throw new WorkBudgetsInvalid(deps.budgets);
  }

  /**
   * Draws one model request for `call`: refuses it with `WorkBudgetSpent` when its project, or its
   * task, has no request left, and otherwise writes its llm_calls row as pending, which is the
   * draw. The one draw point: the spend cap runs it inside its admission turn, before every
   * provider request the gateway sends, so a read and its write cannot interleave with another's.
   */
  async draw(call: PendingLlmCall, estimatedCostUsd: number): Promise<void> {
    const { ledger, budgets } = this.deps;
    const { projectId, taskId, callSite } = call.context;
    const drawn = await ledger.work({ projectId, taskId });

    const projectBudget = budgets.perProjectRequests + drawn.project.granted;
    if (drawn.project.spent + drawn.project.inFlight >= projectBudget) {
      const work = await this.atBudget("project", projectBudget, drawn.project.granted, drawn.project, { projectId, taskId: null });
      throw new WorkBudgetSpent({ scope: { kind: "project", projectId }, callSite, work });
    }
    if (taskId !== null && drawn.task !== null && drawn.task.spent + drawn.task.inFlight >= budgets.perTaskRequests) {
      const work = await this.atBudget("task", budgets.perTaskRequests, 0, drawn.task, { projectId, taskId });
      throw new WorkBudgetSpent({ scope: { kind: "task", projectId, taskId }, callSite, work });
    }

    await ledger.admit({
      id: call.callId,
      projectId,
      taskId,
      callSite,
      provider: call.provider,
      model: call.model.id,
      estimatedCostUsd,
    });
  }

  private async atBudget(
    scope: WorkAtBudget["scope"],
    budgetRequests: number,
    grantedRequests: number,
    drawn: { readonly spent: number; readonly inFlight: number },
    of: Parameters<LlmCallRepository["workBySite"]>[0],
  ): Promise<WorkAtBudget> {
    const bySite = await this.deps.ledger.workBySite(of);
    return { scope, budgetRequests, grantedRequests, spentRequests: drawn.spent, inFlightRequests: drawn.inFlight, bySite };
  }
}
