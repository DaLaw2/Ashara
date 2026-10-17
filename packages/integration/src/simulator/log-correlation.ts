import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LogRecord } from "@ashara/shared";
import type { Database } from "./database.js";
import type { Violation } from "./invariants.js";

/*
 * L1, log correlation: a record names the work it is
 * about by its scope, never by text in its message. Judged here:
 * - a record emitted while a cycle runs carries the cycle's number: the design asks it of warn and
 *   error records, and every level is held to it, since all a cycle runs is awaited inside its scope;
 * - every record of a dispatched attempt's trace (dev_sessions.trace_id) carries the attempt's task
 *   and attempt number;
 * - every finance.call-admitted record names an llm_calls row of the run by its callId, and that
 *   row's trace_id is the record's trace;
 * - every llm_calls and dev_sessions row carries a trace;
 * - a run that dispatched logged at least one record.
 */

/** The rows a trace is joined on, read by the observer outside every seam. */
export interface CorrelationRows {
  readonly calls: ReadonlyArray<{ readonly id: string; readonly traceId: string | null }>;
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly taskId: string; readonly traceId: string | null }>;
}

const callRow = z.object({ id: z.string(), traceId: z.string().nullable() });
const sessionRow = z.object({ id: z.string(), taskId: z.string(), traceId: z.string().nullable() });

export async function readCorrelationRows(db: Database): Promise<CorrelationRows> {
  const calls = z.array(callRow).parse((await db.execute(sql`SELECT id::text, trace_id AS "traceId" FROM llm_calls`)).rows);
  const sessions = z
    .array(sessionRow)
    .parse((await db.execute(sql`SELECT id::text, task_id::text AS "taskId", trace_id AS "traceId" FROM dev_sessions`)).rows);
  return { calls, sessions };
}

/** The L1 violation of one record logged while a cycle ran, or null: the record must carry the cycle. */
export function uncorrelatedInCycle(step: number, record: LogRecord): Violation | null {
  if (record.cycle !== undefined) return null;
  return {
    invariant: "L1",
    step,
    statement: `${record.level} record "${record.event}" was logged while cycle ${step} ran, with no cycle in its scope: ${record.msg.slice(0, 200)}`,
    key: `L1:outside-cycle:${record.event}`,
  };
}

/** L1 over the run's kept records and its rows, judged once the run ends. */
export function checkLogCorrelation(step: number, records: readonly LogRecord[], rows: CorrelationRows, dispatched: boolean): Violation[] {
  const violations = new Map<string, Violation>();
  const add = (key: string, statement: string): void => {
    if (!violations.has(key)) violations.set(key, { invariant: "L1", step, statement, key: `L1:${key}` });
  };

  if (dispatched && records.length === 0) add("no-records", "the run dispatched, and its instances logged no record");

  const unTraced = rows.calls.filter((call) => call.traceId === null).length;
  if (unTraced > 0) add("call-without-trace", `${unTraced} llm_calls row(s) carry no trace_id`);
  const sessionsUnTraced = rows.sessions.filter((session) => session.traceId === null).length;
  if (sessionsUnTraced > 0) add("session-without-trace", `${sessionsUnTraced} dev_sessions row(s) carry no trace_id`);

  const callTraces = new Map(rows.calls.map((call) => [call.id, call.traceId]));
  for (const record of records) {
    if (record.event !== "finance.call-admitted") continue;
    if (record.callId === undefined) {
      add("admitted-without-call", `a finance.call-admitted record carries no callId (trace ${record.traceId})`);
      continue;
    }
    if (!callTraces.has(record.callId)) {
      add("admitted-call-unknown", `finance.call-admitted names call ${record.callId}, which no llm_calls row of the run is`);
      continue;
    }
    const rowTrace = callTraces.get(record.callId);
    if (rowTrace !== null && rowTrace !== record.traceId) {
      add("admitted-trace-differs", `llm_calls ${record.callId} carries trace ${String(rowTrace)}, its finance.call-admitted record ${record.traceId}`);
    }
  }

  const attemptTasks = new Map<string, string>();
  for (const session of rows.sessions) if (session.traceId !== null) attemptTasks.set(session.traceId, session.taskId);
  for (const record of records) {
    const taskId = attemptTasks.get(record.traceId);
    if (taskId === undefined) continue;
    if (record.taskId !== taskId || record.attempt === undefined) {
      add(
        `attempt-uncorrelated:${record.event}`,
        `record "${record.event}" of the dispatched attempt trace ${record.traceId} (task ${taskId}) carries task ${String(record.taskId)} and attempt ${String(record.attempt)}`,
      );
    }
  }
  return [...violations.values()];
}
