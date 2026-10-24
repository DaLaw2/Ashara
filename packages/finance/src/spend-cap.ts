import type { ModelConfig } from "@ashara/model-access";
import { BudgetExceeded, SpendCapsInvalid, SpendEstimateInvalid, WorkBudgetSpent } from "./errors.js";
import type { WorkAtBudget } from "./errors.js";
import type { PendingLlmCall } from "./guarded-model-access.js";
import type { LlmCallRepository } from "./llm-call-repository.js";
import { DEFAULT_WORK_BUDGETS, WorkLedger } from "./work-ledger.js";
import type { WorkBudgets } from "./work-ledger.js";

/**
 * Every token of a byte-level BPE tokenizer (the Claude, GPT, DeepSeek and
 * Gemini families) covers at least one UTF-8 byte, so a request's bytes bound
 * its input tokens from above. Typical English and code run 3-4 bytes per
 * token: the estimate is three to four times the usual count, and never under it.
 */
const BYTES_PER_TOKEN_FLOOR = 1;

/** Input a request's bytes do not show: role markers and the tool-use preamble a provider adds. */
const REQUEST_FRAMING_TOKENS = 1_024;

/** USD caps on llm_calls spend: every project's own, and the whole deployment's. */
interface SpendCaps {
  readonly deploymentUsd: number;
  readonly perProjectUsd: number;
}

/**
 * The amounts a cap was judged on when it stopped work, as the ledger read them: the cap, the spend
 * recorded, the worst case set aside for calls in flight, and the worst case of the call it refused
 * (null when no call was refused: recorded and in-flight spend had already reached the cap).
 */
export interface SpendAtCap {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly inFlightUsd: number;
  readonly nextCallUsd: number | null;
}

/** Why the loop must stop: the deployment's cap admits no further call. */
interface DeploymentStop {
  readonly reason: string;
  readonly spend: SpendAtCap;
}

/**
 * An admission refusing a call, as the loop routes it: a spend cap's (`project`, `deployment`), or
 * the work ledger's, a task's budget spent (`task_work`) or its project's (`project_work`).
 */
export type SpendRefusal =
  | { readonly kind: "project"; readonly projectId: string; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly kind: "deployment"; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly kind: "task_work"; readonly projectId: string; readonly taskId: string; readonly reason: string; readonly work: WorkAtBudget }
  | { readonly kind: "project_work"; readonly projectId: string; readonly reason: string; readonly work: WorkAtBudget };

function spendOf(refused: BudgetExceeded): SpendAtCap {
  return { capUsd: refused.capUsd, spentUsd: refused.spentUsd, inFlightUsd: refused.inFlightUsd, nextCallUsd: refused.estimatedCostUsd };
}

interface SpendCapDeps {
  /** llm_calls: the spend a cap reads, the requests the work ledger reads, and the row an admitted call is written to before it is sent. */
  readonly ledger: Pick<LlmCallRepository, "spend" | "admit" | "work" | "workBySite">;
  readonly caps: SpendCaps;
  /** The work ledger's budgets in model requests (policy default: DEFAULT_WORK_BUDGETS). */
  readonly workBudgets?: WorkBudgets;
  /**
   * What an admission awaits the admissions ahead of it through (policy default: as is). The
   * composition root passes Ashara's contended-wait seam, so a driver that runs one task at a
   * time can see a task waiting behind another's admission.
   */
  readonly admissionTurn?: (ahead: Promise<unknown>) => Promise<unknown>;
}

function isPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The worst-case USD cost of one call: input estimated from the request's
 * bytes at one token per byte plus framing, output at its full bound, both
 * priced at the model's highest rate in any price window, prompt-length tier or
 * dated price (input at the higher of the plain and cache-write rates). A cap, not a price.
 */
export function worstCaseCostUsd(model: ModelConfig, requestBytes: number, maxOutputTokens: number): number {
  const rates = [
    model,
    ...model.priceWindows.map((window) => window.rates),
    ...model.priceTiers.map((tier) => tier.rates),
    ...model.datedPrices.map((price) => price.rates),
  ];
  // eslint-disable-next-line no-restricted-syntax -- policy default: a null cache-write rate bills no cache write (TokenRates), so the worst-case input rate is the input rate itself
  const inputRate = Math.max(...rates.map((r) => Math.max(r.inputCostPer1M, r.cacheWriteCostPer1M ?? 0)));
  const outputRate = Math.max(...rates.map((r) => r.outputCostPer1M));
  const inputTokens = Math.ceil(requestBytes / BYTES_PER_TOKEN_FLOOR) + REQUEST_FRAMING_TOKENS;
  const estimate = (inputTokens * inputRate + maxOutputTokens * outputRate) / 1_000_000;
  const countsValid =
    Number.isInteger(requestBytes) && requestBytes >= 0 && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0;
  if (!countsValid || !isPositiveAmount(estimate)) {
    throw new SpendEstimateInvalid({ model: model.id, requestBytes, maxOutputTokens, estimatedCostUsd: estimate });
  }
  return estimate;
}

/**
 * Finance's one spend authority. The cap is read from llm_calls on every call,
 * so it survives a restart; an unmeasured call counts at its recorded estimate.
 * An admitted call's row is written at admission with its worst-case estimate
 * (state 'pending'), so a call admitted and never recorded, its
 * process dead or its record failed, still counts after a restart. Admission is
 * serialized, so concurrent calls cannot each see the same headroom.
 */
export class SpendCap {
  private admissions: Promise<unknown> = Promise.resolve();
  private deploymentRefusal: BudgetExceeded | null = null;
  private readonly work: WorkLedger;

  constructor(private readonly deps: SpendCapDeps) {
    const { caps } = deps;
    // Policy default: DEFAULT_WORK_BUDGETS; the composition root passes the deployment's.
    this.work = new WorkLedger({ ledger: deps.ledger, budgets: deps.workBudgets ?? DEFAULT_WORK_BUDGETS });
    const valid =
      isPositiveAmount(caps.deploymentUsd) && isPositiveAmount(caps.perProjectUsd) && caps.perProjectUsd <= caps.deploymentUsd;
    if (!valid) {
      throw new SpendCapsInvalid(caps);
    }
  }

  /**
   * Admits a call whose worst case fits under both caps and whose project and task have a model
   * request left, or throws `BudgetExceeded` or `WorkBudgetSpent`, Finance's typed refusals. Finance never halts a project itself: the project's halt is Delivery's,
   * which blocks a project its refusal names wherever the refusal surfaces.
   */
  admit(call: PendingLlmCall): Promise<void> {
    const ahead = this.deps.admissionTurn?.(this.admissions) ?? this.admissions;
    const admission = ahead.then(() => this.admitNow(call));
    // The next admission waits for this one to settle, whatever its outcome; its refusal reaches
    // the caller through `admission`.
    this.admissions = Promise.allSettled([admission]);
    return admission;
  }

  /**
   * Whether the deployment's cap stops the loop: a call it refused in this
   * process, or spend (recorded and in flight) already at the cap, when no call can fit.
   *
   * The refusal is remembered for the life of the process on purpose. The caps
   * are read once at boot (ASHARA_BUDGET_LIMIT_USD), so raising one takes a
   * restart by design, and a restart starts with no remembered refusal and
   * re-reads the ledger. Within the process nothing can lift the cap, and the
   * memory is what stops the loop when the refused call surfaced on a path that
   * does not route refusals itself (a throw the loop handles as an error).
   */
  async deploymentStop(): Promise<DeploymentStop | null> {
    if (this.deploymentRefusal) return { reason: this.deploymentRefusal.message, spend: spendOf(this.deploymentRefusal) };
    const spend = await this.deps.ledger.spend({ kind: "deployment" });
    const spentUsd = spend.recordedUsd + spend.inFlightUsd;
    if (spentUsd < this.deps.caps.deploymentUsd) return null;
    return {
      reason:
        `budget_cap: the deployment has spent $${spentUsd.toFixed(6)} (llm_calls) of its ` +
        `$${this.deps.caps.deploymentUsd.toFixed(6)} cap; no further call can be admitted. ` +
        `Raise ASHARA_BUDGET_LIMIT_USD and restart the server.`,
      spend: { capUsd: this.deps.caps.deploymentUsd, spentUsd: spend.recordedUsd, inFlightUsd: spend.inFlightUsd, nextCallUsd: null },
    };
  }

  /** The cap refusal `error` is, or carries as a cause; `null` for any other error. */
  refusalOf(error: unknown): SpendRefusal | null {
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      if (current instanceof BudgetExceeded) {
        return current.scope.kind === "project"
          ? { kind: "project", projectId: current.scope.projectId, reason: current.message, spend: spendOf(current) }
          : { kind: "deployment", reason: current.message, spend: spendOf(current) };
      }
      if (current instanceof WorkBudgetSpent) {
        return current.scope.kind === "task"
          ? { kind: "task_work", projectId: current.scope.projectId, taskId: current.scope.taskId, reason: current.message, work: current.work }
          : { kind: "project_work", projectId: current.scope.projectId, reason: current.message, work: current.work };
      }
    }
    return null;
  }

  /**
   * One admission: both caps checked, then the work ledger's draw, which checks the request budgets
   * and writes the call's pending row, all inside this admission's turn. Recorded spend and in-flight estimates come from one statement on llm_calls,
   * so no call can be between them, as it could between an in-memory in-flight set and a read. A call recorded
   * while the read runs moves from its estimate to its cost, never above it, so a stale read only
   * overcounts.
   */
  private async admitNow(call: PendingLlmCall): Promise<void> {
    const { ledger, caps } = this.deps;
    const { projectId } = call.context;
    const estimatedCostUsd = worstCaseCostUsd(call.model, call.requestBytes, call.maxOutputTokens);
    const refusal = (scope: BudgetExceeded["scope"], capUsd: number, spentUsd: number, inFlightUsd: number) =>
      new BudgetExceeded({
        scope,
        provider: call.provider,
        model: call.model.id,
        capUsd,
        spentUsd,
        inFlightUsd,
        estimatedCostUsd,
      });

    const { recordedUsd: deploymentSpent, inFlightUsd: deploymentInFlight } = await ledger.spend({ kind: "deployment" });
    if (deploymentSpent + deploymentInFlight + estimatedCostUsd > caps.deploymentUsd) {
      const refused = refusal({ kind: "deployment" }, caps.deploymentUsd, deploymentSpent, deploymentInFlight);
      this.deploymentRefusal ??= refused;
      console.error(`[SpendCap] ${refused.message}`);
      throw refused;
    }

    const { recordedUsd: projectSpent, inFlightUsd: projectInFlight } = await ledger.spend({ kind: "project", projectId });
    if (projectSpent + projectInFlight + estimatedCostUsd > caps.perProjectUsd) {
      const refused = refusal({ kind: "project", projectId }, caps.perProjectUsd, projectSpent, projectInFlight);
      console.warn(`[SpendCap] project ${projectId} refused at its cap: ${refused.message}`);
      throw refused;
    }

    await this.work.draw(call, estimatedCostUsd);
  }
}

/**
 * The error class a `budget_cap` block records, which says whose cap it was: the deployment's, which
 * halts every active project at once (the core loop's halt at the cap), or the project's own (the
 * spend cap's refusal of one project's call). The Liaison's report names the cap from it.
 */
export const SPEND_CAP_ERROR_CLASS = {
  deployment: "DeploymentSpendCapReached",
  project: "BudgetExceeded",
} as const;

/** The error class a `work_budget` block records: the work ledger's refusal at project scope. */
export const WORK_BUDGET_ERROR_CLASS = "WorkBudgetSpent";
