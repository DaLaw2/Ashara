import { sql } from "drizzle-orm";
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
  /** Finance's worst-case estimate of the call, made before it was sent (migration 035). */
  readonly estimatedCostUsd: number;
  /** Why the provider stopped (`no-response` when the request threw before one arrived). */
  readonly finishReason: string;
  /** The instant the call was made; its rates priced `costUsd`. */
  readonly createdAt: Date;
} & LlmCallOutcomeColumns;

/**
 * A stored row. `finishReason` is `null` only on a row written before migration
 * 030 recorded it, `estimatedCostUsd` only on one written before migration 035.
 */
type LlmCallRecord = Omit<NewLlmCall, "finishReason" | "estimatedCostUsd"> & {
  readonly id: string;
  readonly finishReason: string | null;
  readonly estimatedCostUsd: number | null;
};

/** Which spend a cap reads: one project's calls, or every call of the deployment. */
type SpendScope = { readonly kind: "project"; readonly projectId: ProjectId } | { readonly kind: "deployment" };

/**
 * llm_calls holds a row with neither a cost nor an estimate. Migration 035's
 * validated CHECK llm_calls_spend_known forbids one, so this means the schema
 * is not what the code was written against.
 */
class LlmCallSpendUnknown extends Error {
  constructor(
    readonly scope: SpendScope,
    readonly rows: number,
  ) {
    super(
      `llm_calls holds ${rows} row(s) with neither cost_usd nor estimated_cost_usd in scope ` +
        `${scope.kind === "project" ? `project ${scope.projectId}` : "deployment"}; their spend cannot be counted ` +
        `against the cap. Check that migration 035 (CHECK llm_calls_spend_known) is applied.`,
    );
    this.name = "LlmCallSpendUnknown";
  }
}

const SpendRowSchema = z.object({
  spentUsd: z.coerce.number().nonnegative(),
  unknownRows: z.coerce.number().int().nonnegative(),
});

type LlmCallRow = typeof llmCalls.$inferSelect;

const OutcomeColumnsSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), errorKind: z.null() }),
  z.object({ outcome: z.literal("error"), errorKind: z.string().min(1) }),
]);

function toRecord(row: LlmCallRow): LlmCallRecord {
  const outcome = OutcomeColumnsSchema.parse({ outcome: row.outcome, errorKind: row.errorKind });
  return {
    id: row.id,
    projectId: parseProjectId(row.projectId, "llm_calls.project_id"),
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
    estimatedCostUsd: row.estimatedCostUsd,
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
        estimatedCostUsd: call.estimatedCostUsd,
        finishReason: call.finishReason,
        outcome: call.outcome,
        errorKind: call.errorKind,
        createdAt: call.createdAt,
      })
      .returning();
    return toRecord(row);
  }

  /**
   * The USD spent in `scope`: each call's measured cost, or its pre-call
   * worst-case estimate when the cost is unmeasured. No rows is $0 spent; a row
   * with neither number throws.
   */
  async spentUsd(scope: SpendScope): Promise<number> {
    const where = scope.kind === "project" ? sql`WHERE project_id = ${scope.projectId}` : sql``;
    const result = await this.db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(cost_usd, estimated_cost_usd)), 0)::float8 AS "spentUsd",
             COUNT(*) FILTER (WHERE cost_usd IS NULL AND estimated_cost_usd IS NULL)::int AS "unknownRows"
      FROM llm_calls ${where}`);
    const row = SpendRowSchema.parse(result.rows[0]);
    if (row.unknownRows > 0) throw new LlmCallSpendUnknown(scope, row.unknownRows);
    return row.spentUsd;
  }
}
