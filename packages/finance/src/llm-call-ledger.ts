import type { LlmCallRepository, NewLlmCall } from "@ashara/db";
import { calculateCost } from "@ashara/llm-gateway";
import type { LlmCallRecorder, LlmProviderCall, ModelConfig } from "@ashara/llm-gateway";
import { UnpricedModel } from "./errors.js";

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
 * The count of one cache class to price, or `null` when it is unknown. A class
 * the model bills at its own rate must be reported: unreported, its split from
 * plain input is unknown. A class the model does not bill is plain input.
 */
function cacheCount(reported: number | null, rate: number | null): number | null {
  if (reported !== null) return reported;
  return rate === null ? 0 : null;
}

/**
 * The call's cost in USD at the rates in force at `at`, or `null` when a count
 * that enters the price was not reported, or a reported cache class has no
 * rate for this model. Never 0 for an unknown cost.
 */
function costOf(call: LlmProviderCall, at: Date): number | null {
  const reported = call.usage?.reported;
  if (!reported || reported.inputTokens === null || reported.outputTokens === null) return null;
  const cacheRead = cacheCount(reported.cacheReadTokens, call.model.cacheReadCostPer1M);
  const cacheWrite = cacheCount(reported.cacheWriteTokens, call.model.cacheWriteCostPer1M);
  if (cacheRead === null || cacheWrite === null) return null;
  const cost = calculateCost(reported.inputTokens, reported.outputTokens, cacheRead, cacheWrite, call.model, at);
  return cost === null ? null : cost.totalCost;
}

/** Maps one provider call made at `at` to its llm_calls row. Every unreported count stays `null`. */
function toLlmCallRow(call: LlmProviderCall, at: Date): NewLlmCall {
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
    costUsd: costOf(call, at),
    createdAt: at,
    ...outcome,
  };
}

/**
 * The Finance cost ledger's recorder (architecture K10): the server's gateway
 * calls `assertPriced` before every provider request and `record` after it.
 * `clock` stamps each row: the instant whose rates price a call is its `created_at`.
 */
export class LlmCallLedger implements LlmCallRecorder {
  constructor(
    private readonly calls: LlmCallRepository,
    private readonly clock: () => Date,
  ) {}

  assertPriced(provider: string, model: ModelConfig): void {
    assertPriced(provider, model);
  }

  async record(call: LlmProviderCall): Promise<void> {
    await this.calls.insert(toLlmCallRow(call, this.clock()));
  }
}
