import type { LlmCallRepository } from "@ashara/db";
import { WorkBudgetSpent, WorkBudgetsInvalid } from "./errors.js";
import type { WorkAtBudget } from "./errors.js";
import type { PendingLlmCall } from "./guarded-model-access.js";
import { CALL_SITE_PURPOSE } from "./work-purpose.js";
import type { WorkPurpose } from "./work-purpose.js";

/**
 * The model requests one task, and one project with all its tasks, may draw (ADR-084 decision 1),
 * and the share of each project's budget, in whole percent, that only verification may draw
 * (ADR-084 addendum 1 decision 6).
 */
export interface WorkBudgets {
  readonly perTaskRequests: number;
  readonly perProjectRequests: number;
  readonly verificationReservePercent: number;
}

/**
 * Policy defaults, each overridable by the deployment's config. Per task 60 and per project 600
 * (Decided: ADR-084 decision 1, owner 2026-10-16): more than two full dispatches of the agent's 25
 * turns, so a task's own retry bounds stop it first in the ordinary case and the ledger only where
 * loops compose; ten such tasks' worth, two orders of magnitude under the worst case the loops
 * compose to without it (loop-convergence investigation, about 108,000). Reserve 25 percent
 * (Decided: ADR-084 addendum 1 decision 6, owner 2026-10-17; the share is task
 * t-ledger-reserve-warning's policy default): a CCPM feeding buffer at the end of the chain.
 */
export const DEFAULT_WORK_BUDGETS: WorkBudgets = { perTaskRequests: 60, perProjectRequests: 600, verificationReservePercent: 25 };

/**
 * One project's budget in model requests as it stands: the policy default plus the owner's grants;
 * the reserve ring-fenced in it for verification and acceptance, the reserve percent of the whole
 * rounded down; and what its upstream work may draw, the rest. A reserve under 100 percent leaves
 * upstream work at least one request.
 */
export interface ProjectWorkBudget {
  readonly budgetRequests: number;
  readonly reserveRequests: number;
  readonly upstreamRequests: number;
}

export function projectWorkBudget(budgets: WorkBudgets, grantedRequests: number): ProjectWorkBudget {
  const budgetRequests = budgets.perProjectRequests + grantedRequests;
  const reserveRequests = Math.floor((budgetRequests * budgets.verificationReservePercent) / 100);
  return { budgetRequests, reserveRequests, upstreamRequests: budgetRequests - reserveRequests };
}

/**
 * Whether a project's next request may be drawn: `exhausted` when its whole budget is drawn,
 * `reserve_protected` when only its reserve is left and the request is upstream work, `admitted`
 * otherwise. Every request drawn counts against both lines, a verification request's included.
 * @testseam work-ledger.test.ts admits a verification request past the reserve line, which no call site draws today (CALL_SITE_PURPOSE); WorkLedger.draw is its production caller
 */
export function projectDrawVerdict(purpose: WorkPurpose, drawnRequests: number, budget: ProjectWorkBudget): "admitted" | "exhausted" | "reserve_protected" {
  if (drawnRequests >= budget.budgetRequests) return "exhausted";
  if (purpose === "upstream" && drawnRequests >= budget.upstreamRequests) return "reserve_protected";
  return "admitted";
}

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
 * project's budget grows. A task draws only while its project has requests left, and upstream work
 * only while more than the project's verification reserve is left (CALL_SITE_PURPOSE, ADR-084
 * addendum 1 decision 6), so a ledger drained by planning, authoring and review still holds the
 * reserve for verifying what was built.
 */
export class WorkLedger {
  constructor(private readonly deps: WorkLedgerDeps) {
    const { perTaskRequests, perProjectRequests, verificationReservePercent } = deps.budgets;
    const valid =
      Number.isSafeInteger(perTaskRequests) &&
      perTaskRequests > 0 &&
      Number.isSafeInteger(perProjectRequests) &&
      perProjectRequests > 0 &&
      Number.isSafeInteger(verificationReservePercent) &&
      verificationReservePercent >= 0 &&
      verificationReservePercent < 100;
    if (!valid) throw new WorkBudgetsInvalid(deps.budgets);
  }

  /**
   * Draws one model request for `call`: refuses it with `WorkBudgetSpent` when its project, or its
   * task, has no request left, or when only the project's verification reserve is left and the call
   * is upstream work; otherwise writes its llm_calls row as pending, which is the draw. The one
   * draw point: the spend cap runs it inside its admission turn, before every provider request the
   * gateway sends, so a read and its write cannot interleave with another's.
   */
  async draw(call: PendingLlmCall, estimatedCostUsd: number): Promise<void> {
    const { ledger, budgets } = this.deps;
    const { projectId, taskId, callSite } = call.context;
    const drawn = await ledger.work({ projectId, taskId });

    const project = projectWorkBudget(budgets, drawn.project.granted);
    const verdict = projectDrawVerdict(CALL_SITE_PURPOSE[callSite], drawn.project.spent + drawn.project.inFlight, project);
    if (verdict !== "admitted") {
      const reserve = { requests: project.reserveRequests, protected: verdict === "reserve_protected" };
      const work = await this.atBudget("project", project.budgetRequests, drawn.project.granted, reserve, drawn.project, { projectId, taskId: null });
      throw new WorkBudgetSpent({ scope: { kind: "project", projectId }, callSite, work });
    }
    if (taskId !== null && drawn.task !== null && drawn.task.spent + drawn.task.inFlight >= budgets.perTaskRequests) {
      const work = await this.atBudget("task", budgets.perTaskRequests, 0, { requests: 0, protected: false }, drawn.task, { projectId, taskId });
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
    reserve: { readonly requests: number; readonly protected: boolean },
    drawn: { readonly spent: number; readonly inFlight: number },
    of: Parameters<LlmCallRepository["workBySite"]>[0],
  ): Promise<WorkAtBudget> {
    const bySite = await this.deps.ledger.workBySite(of);
    return {
      scope,
      budgetRequests,
      grantedRequests,
      reserveRequests: reserve.requests,
      reserveProtected: reserve.protected,
      spentRequests: drawn.spent,
      inFlightRequests: drawn.inFlight,
      bySite,
    };
  }
}
