import type { LlmCallMeasurement, LlmCallRepository } from "@ashara/db";
import { describeUnmeasuredCost, measureCost } from "@ashara/llm-gateway";
import type { LlmCallRecorder, LlmProviderCall, ModelConfig, PendingLlmCall } from "@ashara/llm-gateway";
import { UnpricedModel } from "./errors.js";
import { worstCaseCostUsd } from "./spend-cap.js";
import type { SpendCap } from "./spend-cap.js";

function isPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Refuses a model whose input or output price is unset (0), negative or not a number. */
function assertPriced(provider: string, model: ModelConfig): void {
  if (isPrice(model.inputCostPer1M) && isPrice(model.outputCostPer1M)) return;
  throw new UnpricedModel({
    provider,
    model: model.id,
    inputCostPer1M: model.inputCostPer1M,
    outputCostPer1M: model.outputCostPer1M,
  });
}

/**
 * The call's cost in USD at the rates in force when it was sent, or `null` when it is
 * unmeasured. Never 0 for an unknown cost: a NULL is logged at `warn`, and the
 * spend cap counts the row at `estimatedCostUsd`.
 */
function costOf(call: LlmProviderCall, estimatedCostUsd: number): number | null {
  const where =
    `project=${call.context.projectId}, callSite=${call.context.callSite}, operation=${call.operation}; ` +
    `llm_calls.cost_usd is NULL and the spend cap counts the call at its estimate $${estimatedCostUsd.toFixed(6)}`;
  if (call.usage === null) {
    console.warn(
      `[LlmCallLedger] cost unmeasured: provider=${call.provider}, model=${call.model.id}, the request ` +
        `returned no usage report (finish reason ${call.finishReason}), ${where}`,
    );
    return null;
  }
  const cost = measureCost(call.usage.reported, call.model, call.requestedAt);
  if (cost.measured) return cost.totalCost;
  console.warn(`[LlmCallLedger] ${describeUnmeasuredCost(cost, call.provider, call.model.id)}, ${where}`);
  return null;
}

/** What one provider call's record adds to the row its admission wrote. Every unreported count stays `null`. */
function measurementOf(call: LlmProviderCall): LlmCallMeasurement {
  const estimatedCostUsd = worstCaseCostUsd(call.model, call.requestBytes, call.maxOutputTokens);
  const outcome =
    call.outcome.kind === "ok"
      ? { outcome: "ok" as const, errorKind: null }
      : { outcome: "error" as const, errorKind: call.outcome.errorKind };
  return {
    inputTokens: call.usage?.reported.inputTokens ?? null,
    outputTokens: call.usage?.reported.outputTokens ?? null,
    cacheReadTokens: call.usage?.reported.cacheReadTokens ?? null,
    cacheWriteTokens: call.usage?.reported.cacheWriteTokens ?? null,
    reasoningTokens: call.usage?.reasoningTokens ?? null,
    costUsd: costOf(call, estimatedCostUsd),
    finishReason: call.finishReason,
    createdAt: call.requestedAt,
    ...outcome,
  };
}

/**
 * The Finance cost ledger's recorder (architecture K10): the server's gateway
 * calls `assertPriced` before every provider request and `record` after it.
 * The pre-call check refuses an unpriced model, then asks the spend cap to
 * admit the call's worst case, which writes the call's row as pending. A
 * recorded row's `created_at` is the instant the gateway sent the request, the
 * same instant whose rates price it here and in the cost the gateway returns.
 */
export class LlmCallLedger implements LlmCallRecorder {
  constructor(
    private readonly calls: Pick<LlmCallRepository, "record" | "markPendingUnmeasuredAfterCrash">,
    private readonly cap: SpendCap,
  ) {}

  async assertPriced(call: PendingLlmCall): Promise<void> {
    assertPriced(call.provider, call.model);
    await this.cap.admit(call);
  }

  /**
   * Completes the row the call's admission wrote. A call whose record fails stays pending, counted
   * at its estimate, until a later startup marks it unmeasured_after_crash, counted the same.
   */
  async record(call: LlmProviderCall): Promise<void> {
    await this.calls.record(call.callId, measurementOf(call));
  }

  /**
   * Run once at startup, before the first call is admitted: every pending row is a call an earlier
   * process admitted and never recorded. It keeps counting at its estimate; it is never dropped.
   */
  async reconcileAtStartup(): Promise<void> {
    const marked = await this.calls.markPendingUnmeasuredAfterCrash();
    if (marked === 0) return;
    console.warn(
      `[LlmCallLedger] ${marked} llm_calls row(s) were admitted by an earlier process and never recorded: ` +
        `marked unmeasured_after_crash, each still counted against the spend cap at its worst-case estimate`,
    );
  }
}
