import type { LlmCallRepository, NewLlmCall } from "@ashara/db";
import { calculateCost } from "@ashara/llm-gateway";
import type { LlmCallRecorder, LlmProviderCall, ModelConfig } from "@ashara/llm-gateway";
import { UnpricedModel } from "./errors.js";

function isPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Refuses a model whose input or output price is unset (0), negative or not a number. */
export function assertPriced(provider: string, model: ModelConfig): void {
  if (isPrice(model.inputCostPer1M) && isPrice(model.outputCostPer1M)) return;
  throw new UnpricedModel({
    provider,
    model: model.id,
    inputCostPer1M: model.inputCostPer1M,
    outputCostPer1M: model.outputCostPer1M,
  });
}

/**
 * The call's cost in USD, or `null` when any count that enters the price was
 * not reported. Cache counts enter it only for a model priced with a cache
 * discount (`supportsCaching`); for any other model calculateCost charges
 * every input token at one rate, so the split into cache classes cannot move
 * the total and the unreported split is passed as 0 to the arithmetic only.
 */
export function costOf(call: LlmProviderCall): number | null {
  const reported = call.usage?.reported;
  if (!reported || reported.inputTokens === null || reported.outputTokens === null) return null;
  if (call.model.supportsCaching && (reported.cacheReadTokens === null || reported.cacheWriteTokens === null)) {
    return null;
  }
  return calculateCost(
    reported.inputTokens,
    reported.outputTokens,
    reported.cacheReadTokens ?? 0,
    reported.cacheWriteTokens ?? 0,
    call.model,
  ).totalCost;
}

/** Maps one provider call to its llm_calls row. Every unreported count stays `null`. */
export function toLlmCallRow(call: LlmProviderCall): NewLlmCall {
  const outcome =
    call.outcome.kind === "ok"
      ? { outcome: "ok" as const, errorKind: null }
      : { outcome: "error" as const, errorKind: call.outcome.errorKind };
  return {
    projectId: call.context.projectId,
    taskId: call.context.taskId,
    callSite: call.context.callSite,
    provider: call.provider,
    model: call.model.id,
    inputTokens: call.usage?.reported.inputTokens ?? null,
    outputTokens: call.usage?.reported.outputTokens ?? null,
    cacheReadTokens: call.usage?.reported.cacheReadTokens ?? null,
    cacheWriteTokens: call.usage?.reported.cacheWriteTokens ?? null,
    costUsd: costOf(call),
    ...outcome,
  };
}

/**
 * The Finance cost ledger's recorder (architecture K10): the server's gateway
 * calls `assertPriced` before every provider request and `record` after it.
 */
export class LlmCallLedger implements LlmCallRecorder {
  constructor(private readonly calls: LlmCallRepository) {}

  assertPriced(provider: string, model: ModelConfig): void {
    assertPriced(provider, model);
  }

  async record(call: LlmProviderCall): Promise<void> {
    await this.calls.insert(toLlmCallRow(call));
  }
}
