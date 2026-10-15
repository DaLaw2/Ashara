import type { LlmCallRepository } from "@ashara/db";
import type { ModelConfig } from "@ashara/model-access";
import { BudgetExceeded, SpendCapsInvalid, SpendEstimateInvalid } from "./errors.js";
import type { PendingLlmCall } from "./guarded-model-access.js";

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

/** Why the loop must stop: the deployment's cap admits no further call. */
interface DeploymentStop {
  readonly reason: string;
}

/** A spend cap refusing a call, as the loop routes it. */
type SpendRefusal =
  | { readonly kind: "project"; readonly projectId: string; readonly reason: string }
  | { readonly kind: "deployment"; readonly reason: string };

interface SpendCapDeps {
  /** llm_calls: the spend a cap reads, and the row an admitted call is written to before it is sent. */
  readonly ledger: Pick<LlmCallRepository, "spend" | "admit">;
  readonly caps: SpendCaps;
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
 * priced at the model's highest rate in any price window or prompt-length tier
 * (input at the higher of the plain and cache-write rates). A cap, not a price.
 */
export function worstCaseCostUsd(model: ModelConfig, requestBytes: number, maxOutputTokens: number): number {
  const rates = [
    model,
    ...model.priceWindows.map((window) => window.rates),
    ...model.priceTiers.map((tier) => tier.rates),
  ];
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
 * (state 'pending', migration 053), so a call admitted and never recorded, its
 * process dead or its record failed, still counts after a restart. Admission is
 * serialized, so concurrent calls cannot each see the same headroom.
 */
export class SpendCap {
  private admissions: Promise<unknown> = Promise.resolve();
  private deploymentRefusal: BudgetExceeded | null = null;

  constructor(private readonly deps: SpendCapDeps) {
    const { caps } = deps;
    const valid =
      isPositiveAmount(caps.deploymentUsd) && isPositiveAmount(caps.perProjectUsd) && caps.perProjectUsd <= caps.deploymentUsd;
    if (!valid) {
      throw new SpendCapsInvalid(caps);
    }
  }

  /**
   * Admits a call whose worst case fits under both caps, or throws `BudgetExceeded`, Finance's
   * typed refusal. Finance never halts a project itself: the project's halt is Delivery's (O3 c,
   * ADR-080 d3), which blocks a project its refusal names wherever the refusal surfaces.
   */
  admit(call: PendingLlmCall): Promise<void> {
    const ahead = this.deps.admissionTurn?.(this.admissions) ?? this.admissions;
    const admission = ahead.then(() => this.admitNow(call));
    this.admissions = admission.catch(() => undefined);
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
    if (this.deploymentRefusal) return { reason: this.deploymentRefusal.message };
    const spend = await this.deps.ledger.spend({ kind: "deployment" });
    const spentUsd = spend.recordedUsd + spend.inFlightUsd;
    if (spentUsd < this.deps.caps.deploymentUsd) return null;
    return {
      reason:
        `budget_cap: the deployment has spent $${spentUsd.toFixed(6)} (llm_calls) of its ` +
        `$${this.deps.caps.deploymentUsd.toFixed(6)} cap; no further call can be admitted. ` +
        `Raise ASHARA_BUDGET_LIMIT_USD and restart the server.`,
    };
  }

  /** The cap refusal `error` is, or carries as a cause; `null` for any other error. */
  refusalOf(error: unknown): SpendRefusal | null {
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      if (current instanceof BudgetExceeded) {
        return current.scope.kind === "project"
          ? { kind: "project", projectId: current.scope.projectId, reason: current.message }
          : { kind: "deployment", reason: current.message };
      }
    }
    return null;
  }

  /**
   * One admission: both caps checked, then the call's pending row written, all inside this
   * admission's turn. Recorded spend and in-flight estimates come from one statement on llm_calls,
   * so no call can be between them (the B9 race of an in-memory in-flight set). A call recorded
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

    await ledger.admit({
      id: call.callId,
      projectId,
      taskId: call.context.taskId,
      callSite: call.context.callSite,
      provider: call.provider,
      model: call.model.id,
      estimatedCostUsd,
    });
  }
}

/**
 * The error class a `budget_cap` block records, which says whose cap it was: the deployment's, which
 * halts every active project at once (the core loop's halt at the cap), or the project's own (the
 * spend cap's refusal of one project's call). The Liaison's report names the cap from it (smoke1 D4).
 */
export const SPEND_CAP_ERROR_CLASS = {
  deployment: "DeploymentSpendCapReached",
  project: "BudgetExceeded",
} as const;
