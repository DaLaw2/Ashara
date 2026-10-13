import type { LlmCallRepository } from "@ashara/db";
import type { ModelConfig, PendingLlmCall } from "@ashara/llm-gateway";
import { BudgetExceeded, SpendCapsInvalid, SpendEstimateInvalid } from "./errors.js";

type ProjectId = PendingLlmCall["context"]["projectId"];

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
  readonly ledger: Pick<LlmCallRepository, "spentUsd">;
  /** The per-project block (migration 025): a project at its cap is blocked, and the loop skips it. */
  readonly projects: {
    block(
      projectId: ProjectId,
      cause: { readonly errorClass: string; readonly reason: string },
    ): Promise<"blocked" | "already-blocked">;
  };
  readonly caps: SpendCaps;
}

function isPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The worst-case USD cost of one call: input estimated from the request's
 * bytes at one token per byte plus framing, output at its full bound, both
 * priced at the model's highest rate in any price window (input at the higher
 * of the plain and cache-write rates).
 */
export function worstCaseCostUsd(model: ModelConfig, requestBytes: number, maxOutputTokens: number): number {
  const rates = [model, ...model.priceWindows.map((window) => window.rates)];
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
 * Admitted calls not yet recorded are held as in-flight estimates, and admission
 * is serialized, so concurrent calls cannot each see the same headroom.
 */
export class SpendCap {
  private readonly inFlight = new Map<string, { readonly projectId: ProjectId; readonly estimateUsd: number }>();
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
   * Admits a call whose worst case fits under both caps, or throws
   * `BudgetExceeded`. A project refusal blocks the project first, so whichever
   * caller catches the refusal, the project ends blocked.
   */
  admit(call: PendingLlmCall): Promise<void> {
    const admission = this.admissions.then(() => this.admitNow(call));
    this.admissions = admission.catch(() => undefined);
    return admission;
  }

  /** Drops an admitted call's in-flight estimate once its row is in llm_calls. */
  release(callId: string): void {
    this.inFlight.delete(callId);
  }

  /**
   * Whether the deployment's cap stops the loop: a call it refused in this
   * process, or recorded spend already at the cap, when no call can fit.
   */
  async deploymentStop(): Promise<DeploymentStop | null> {
    if (this.deploymentRefusal) return { reason: this.deploymentRefusal.message };
    const spentUsd = await this.deps.ledger.spentUsd({ kind: "deployment" });
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

  private inFlightUsd(projectId?: ProjectId): number {
    let total = 0;
    for (const call of this.inFlight.values()) {
      if (projectId === undefined || call.projectId === projectId) total += call.estimateUsd;
    }
    return total;
  }

  private async admitNow(call: PendingLlmCall): Promise<void> {
    const { ledger, projects, caps } = this.deps;
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

    const deploymentSpent = await ledger.spentUsd({ kind: "deployment" });
    const deploymentInFlight = this.inFlightUsd();
    if (deploymentSpent + deploymentInFlight + estimatedCostUsd > caps.deploymentUsd) {
      const refused = refusal({ kind: "deployment" }, caps.deploymentUsd, deploymentSpent, deploymentInFlight);
      this.deploymentRefusal ??= refused;
      console.error(`[SpendCap] ${refused.message}`);
      throw refused;
    }

    const projectSpent = await ledger.spentUsd({ kind: "project", projectId });
    const projectInFlight = this.inFlightUsd(projectId);
    if (projectSpent + projectInFlight + estimatedCostUsd > caps.perProjectUsd) {
      const refused = refusal({ kind: "project", projectId }, caps.perProjectUsd, projectSpent, projectInFlight);
      const blocked = await projects.block(projectId, { errorClass: refused.name, reason: refused.message });
      console.warn(`[SpendCap] project ${projectId} ${blocked}: ${refused.message}`);
      throw refused;
    }

    this.inFlight.set(call.callId, { projectId, estimateUsd: estimatedCostUsd });
  }
}
