import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { llmCalls } from "../schema/index.js";

/** `error` always names its kind; `ok` never carries one (the table's CHECK enforces the same). */
type LlmCallOutcomeColumns =
  | { readonly outcome: "ok"; readonly errorKind: null }
  | { readonly outcome: "error"; readonly errorKind: string };

/** An admitted call's row, written before the call is sent: all that admission knows (migration 053). */
interface AdmittedLlmCall {
  /** The gateway's call id; the call's record completes the row by it. */
  readonly id: string;
  readonly projectId: ProjectId;
  readonly taskId: string | null;
  readonly callSite: string;
  readonly provider: string;
  readonly model: string;
  /** Finance's worst-case estimate of the call (migration 035). */
  readonly estimatedCostUsd: number;
  /** The trace of the log scope the call was admitted in (migration 076): its row leads to its records. */
  readonly traceId: string;
}

/** What a call's record adds to its admitted row. Every `null` token or cost field means "not measured". */
export type LlmCallMeasurement = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Output tokens the provider reported as reasoning; `null` when it reported no such count. */
  readonly reasoningTokens: number | null;
  /** The context window of the model the call was sent to (model_configs.max_context_tokens), migration 074. */
  readonly contextWindowTokens: number;
  readonly costUsd: number | null;
  /** Why the provider stopped (`no-response` when the request threw before one arrived). */
  readonly finishReason: string;
  /** The instant the call was sent; its rates priced `costUsd`. */
  readonly createdAt: Date;
} & LlmCallOutcomeColumns;

/** Which spend a cap reads: one project's calls, or every call of the deployment. */
type SpendScope = { readonly kind: "project"; readonly projectId: ProjectId } | { readonly kind: "deployment" };

/** A scope's spend as a cap counts it. */
interface Spend {
  /** Rows no longer pending: each at its cost, or at its estimate when unmeasured or lost to a crash. */
  readonly recordedUsd: number;
  /** Estimates of the calls admitted and not yet recorded (state 'pending'). */
  readonly inFlightUsd: number;
}

function describeScope(scope: SpendScope): string {
  return scope.kind === "project" ? `project ${scope.projectId}` : "deployment";
}

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
        `${describeScope(scope)}; their spend cannot be counted against the cap. ` +
        `Check that migration 035 (CHECK llm_calls_spend_known) is applied.`,
    );
    this.name = "LlmCallSpendUnknown";
  }
}

/** A call id that is not a UUID cannot key its llm_calls row, so the call cannot be admitted. */
class LlmCallIdInvalid extends Error {
  constructor(
    readonly callId: string,
    readonly projectId: ProjectId,
  ) {
    super(`llm_calls cannot admit call "${callId}" of project ${projectId}: the call id keys its row and must be a UUID`);
    this.name = "LlmCallIdInvalid";
  }
}

/**
 * A call's record found no admitted row to complete: no row has its id, or that row is already
 * recorded. Its spend is not on record as measured; whatever row exists keeps counting as it was.
 */
class LlmCallNotAdmitted extends Error {
  constructor(
    readonly callId: string,
    readonly found: string | null,
  ) {
    super(
      `llm_calls cannot record call ${callId}: ` +
        (found === null ? "no row was written at its admission" : `its row is already in state '${found}'`) +
        `; only a 'pending' or 'unmeasured_after_crash' row is completed by a record`,
    );
    this.name = "LlmCallNotAdmitted";
  }
}

const SpendRowSchema = z.object({
  recordedUsd: z.coerce.number().nonnegative(),
  inFlightUsd: z.coerce.number().nonnegative(),
  unknownRows: z.coerce.number().int().nonnegative(),
});

const CallId = z.uuid();

/** The model requests a scope has drawn, as the work ledger counts them: one llm_calls row each. */
interface DrawnRequests {
  /** Rows no longer pending: requests recorded, or lost to a crash and still counted. */
  readonly spent: number;
  /** Rows admitted and not yet recorded (state 'pending'). */
  readonly inFlight: number;
}

/** What the work ledger reads before one request: the project's drawn requests and grants, and the task's when one is served. */
interface WorkDrawn {
  readonly project: DrawnRequests & {
    /** Requests the owner granted the project (work_grants, migration 067). */
    readonly granted: number;
  };
  /** null when the request serves no task. */
  readonly task: DrawnRequests | null;
}

/** The requests one call site drew in a scope. */
interface RequestsAtSite {
  readonly callSite: string;
  readonly requests: number;
}

/** Whose drawn requests are read: one project's, or one task's of it. */
type WorkScope = { readonly projectId: ProjectId; readonly taskId: string | null };

const WorkRowSchema = z.object({
  projectDrawn: z.coerce.number().int().nonnegative(),
  projectInFlight: z.coerce.number().int().nonnegative(),
  taskDrawn: z.coerce.number().int().nonnegative(),
  taskInFlight: z.coerce.number().int().nonnegative(),
  granted: z.coerce.number().int().nonnegative(),
});

const SiteRowSchema = z.object({ callSite: z.string().min(1), requests: z.coerce.number().int().positive() });

/** The Finance cost ledger's per-call rows (architecture K10, migrations 015, 030, 035 and 053). */
export class LlmCallRepository {
  constructor(private readonly db: DbHandle) {}

  /** Writes an admitted call's row, state 'pending', before the call is sent: from now on it counts. */
  async admit(call: AdmittedLlmCall): Promise<void> {
    if (!CallId.safeParse(call.id).success) throw new LlmCallIdInvalid(call.id, call.projectId);
    await this.db.insert(llmCalls).values({
      id: call.id,
      projectId: call.projectId,
      taskId: call.taskId,
      callSite: call.callSite,
      provider: call.provider,
      model: call.model,
      estimatedCostUsd: call.estimatedCostUsd,
      traceId: call.traceId,
      state: "pending",
    });
  }

  /**
   * Completes an admitted call's row with what the call measured. A row a later process's startup
   * marked unmeasured_after_crash is completed too: the call was not lost after all, and its
   * measured cost replaces the estimate. Throws when there is no such row to complete.
   */
  async record(callId: string, measured: LlmCallMeasurement): Promise<void> {
    const completed = await this.db
      .update(llmCalls)
      .set({
        inputTokens: measured.inputTokens,
        outputTokens: measured.outputTokens,
        cacheReadTokens: measured.cacheReadTokens,
        cacheWriteTokens: measured.cacheWriteTokens,
        reasoningTokens: measured.reasoningTokens,
        contextWindowTokens: measured.contextWindowTokens,
        costUsd: measured.costUsd,
        finishReason: measured.finishReason,
        outcome: measured.outcome,
        errorKind: measured.errorKind,
        createdAt: measured.createdAt,
        state: "recorded",
      })
      .where(and(eq(llmCalls.id, callId), inArray(llmCalls.state, ["pending", "unmeasured_after_crash"])))
      .returning({ id: llmCalls.id });
    if (completed.length === 1) return;
    const [existing] = await this.db.select({ state: llmCalls.state }).from(llmCalls).where(eq(llmCalls.id, callId));
    throw new LlmCallNotAdmitted(callId, existing?.state ?? null);
  }

  /**
   * At startup, before any call is admitted: every row still pending was admitted by a process
   * that ended before recording it. The call may have been sent and its cost is unknown, so the
   * row stays counted at its estimate, marked unmeasured_after_crash. Returns how many.
   *
   * Every pending row of the database, not only this process's targets: it assumes one server
   * process per database, as the work-item reconcile does (startup-reconciler.ts itemsByProject
   * requeues every InProgress item of every project) and the deployment cap does (it sums the whole
   * table). A second live process on the same database would see its in-flight rows relabelled;
   * they stay counted at their estimate and its record still completes them.
   */
  async markPendingUnmeasuredAfterCrash(): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE llm_calls SET state = 'unmeasured_after_crash' WHERE state = 'pending' RETURNING id`);
    return result.rows.length;
  }

  /**
   * The USD spent in `scope`: each call's measured cost, or its worst-case estimate while it is
   * pending, unmeasured, or lost to a crash. No rows is $0 spent; a row with neither number throws.
   */
  async spend(scope: SpendScope): Promise<Spend> {
    const where = scope.kind === "project" ? sql`WHERE project_id = ${scope.projectId}` : sql``;
    const result = await this.db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(cost_usd, estimated_cost_usd)) FILTER (WHERE state <> 'pending'), 0)::float8 AS "recordedUsd",
             COALESCE(SUM(estimated_cost_usd) FILTER (WHERE state = 'pending'), 0)::float8 AS "inFlightUsd",
             COUNT(*) FILTER (WHERE cost_usd IS NULL AND estimated_cost_usd IS NULL)::int AS "unknownRows"
      FROM llm_calls ${where}`);
    const row = SpendRowSchema.parse(result.rows[0]);
    if (row.unknownRows > 0) throw new LlmCallSpendUnknown(scope, row.unknownRows);
    return { recordedUsd: row.recordedUsd, inFlightUsd: row.inFlightUsd };
  }

  /**
   * The model requests drawn in `scope` (migration 067, ADR-084 decision 1): every llm_calls row of
   * the project, and of the task when one is named, in any state, so a request is drawn from the
   * moment it is admitted and stays drawn through a refund, an unblock or a restart; with the
   * requests the owner granted the project, read in the same statement.
   */
  async work(scope: WorkScope): Promise<WorkDrawn> {
    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "projectDrawn",
             COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0)::int AS "projectInFlight",
             COALESCE(SUM(CASE WHEN task_id = ${scope.taskId}::uuid THEN 1 ELSE 0 END), 0)::int AS "taskDrawn",
             COALESCE(SUM(CASE WHEN task_id = ${scope.taskId}::uuid AND state = 'pending' THEN 1 ELSE 0 END), 0)::int AS "taskInFlight",
             (SELECT COALESCE(SUM(requests), 0) FROM work_grants WHERE project_id = ${scope.projectId})::int AS "granted"
      FROM llm_calls WHERE project_id = ${scope.projectId}`);
    const row = WorkRowSchema.parse(result.rows[0]);
    return {
      project: { spent: row.projectDrawn - row.projectInFlight, inFlight: row.projectInFlight, granted: row.granted },
      task: scope.taskId === null ? null : { spent: row.taskDrawn - row.taskInFlight, inFlight: row.taskInFlight },
    };
  }

  /** The requests drawn in `scope`, by the call site that drew them, most first. */
  async workBySite(scope: WorkScope): Promise<RequestsAtSite[]> {
    const task = scope.taskId === null ? sql`` : sql`AND task_id = ${scope.taskId}::uuid`;
    const result = await this.db.execute(sql`
      SELECT call_site AS "callSite", COUNT(*)::int AS requests
      FROM llm_calls WHERE project_id = ${scope.projectId} ${task}
      GROUP BY call_site ORDER BY requests DESC, call_site`);
    return z.array(SiteRowSchema).parse(result.rows);
  }
}
