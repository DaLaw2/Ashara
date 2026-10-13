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
  readonly costUsd: number | null;
  /** The instant the call was made; its rates priced `costUsd`. */
  readonly createdAt: Date;
} & LlmCallOutcomeColumns;

type LlmCallRecord = NewLlmCall & {
  readonly id: string;
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
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    ...outcome,
  };
}

/** The Finance cost ledger's per-call rows (architecture K10, migration 015). */
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
        costUsd: call.costUsd,
        outcome: call.outcome,
        errorKind: call.errorKind,
        createdAt: call.createdAt,
      })
      .returning();
    return toRecord(row);
  }
}
