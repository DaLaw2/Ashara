import { z } from "zod";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { llmCalls } from "../schema.js";

/** `error` always names its kind; `ok` never carries one (the table's CHECK enforces the same). */
type LlmCallOutcomeColumns =
  | { readonly outcome: "ok"; readonly errorKind: null }
  | { readonly outcome: "error"; readonly errorKind: string };

/** One llm_calls row to insert. Every `null` token or cost field means "not measured". */
export type NewLlmCall = {
  readonly projectId: ProjectId;
  readonly taskId: string | null;
  readonly callSite: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Output tokens the provider reported as reasoning; `null` when it reported no such count. */
  readonly reasoningTokens: number | null;
  readonly costUsd: number | null;
  /** Why the provider stopped (`no-response` when the request threw before one arrived). */
  readonly finishReason: string;
  /** The instant the call was made; its rates priced `costUsd`. */
  readonly createdAt: Date;
} & LlmCallOutcomeColumns;

/** A stored row. `finishReason` is `null` only on a row written before migration 030 recorded it. */
type LlmCallRecord = Omit<NewLlmCall, "finishReason"> & {
  readonly id: string;
  readonly finishReason: string | null;
};

type LlmCallRow = typeof llmCalls.$inferSelect;

const OutcomeColumnsSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), errorKind: z.null() }),
  z.object({ outcome: z.literal("error"), errorKind: z.string().min(1) }),
]);

function toRecord(row: LlmCallRow): LlmCallRecord {
  const outcome = OutcomeColumnsSchema.parse({ outcome: row.outcome, errorKind: row.errorKind });
  return {
    id: row.id,
    projectId: parseProjectId(row.projectId),
    taskId: row.taskId,
    callSite: row.callSite,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    costUsd: row.costUsd,
    finishReason: row.finishReason,
    createdAt: row.createdAt,
    ...outcome,
  };
}

/** The Finance cost ledger's per-call rows (architecture K10, migrations 015 and 030). */
export class LlmCallRepository {
  constructor(private readonly db: DbHandle) {}

  async insert(call: NewLlmCall): Promise<LlmCallRecord> {
    const [row] = await this.db
      .insert(llmCalls)
      .values({
        projectId: call.projectId,
        taskId: call.taskId,
        callSite: call.callSite,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadTokens: call.cacheReadTokens,
        cacheWriteTokens: call.cacheWriteTokens,
        reasoningTokens: call.reasoningTokens,
        costUsd: call.costUsd,
        finishReason: call.finishReason,
        outcome: call.outcome,
        errorKind: call.errorKind,
        createdAt: call.createdAt,
      })
      .returning();
    return toRecord(row);
  }
}
