import type { LlmCallRepository, NewLlmCall } from "@ashara/db";
import { describeUnmeasuredCost, measureCost } from "@ashara/llm-gateway";
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
 * The call's cost in USD at the rates in force at `at`, or `null` when it is
 * unmeasured. Never 0 for an unknown cost. A request that produced no usage
 * report (it threw) is NULL without a log line: its error is the record. Any
 * other NULL is logged at `warn` with the classes that left it unmeasured.
 */
function costOf(call: LlmProviderCall, at: Date): number | null {
  if (call.usage === null) return null;
  const cost = measureCost(call.usage.reported, call.model, at);
  if (cost.measured) return cost.totalCost;
  console.warn(
    `[LlmCallLedger] ${describeUnmeasuredCost(cost, call.provider, call.model.id)}, ` +
      `project=${call.context.projectId}, callSite=${call.context.callSite}, operation=${call.operation}; ` +
      `llm_calls.cost_usd is NULL`,
  );
  return null;
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
