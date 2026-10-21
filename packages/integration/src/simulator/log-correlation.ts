import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LogRecord, LogSink } from "@ashara/shared";
import type { Database } from "./database.js";
import type { Violation } from "./invariants.js";

/*
 * L1, log correlation: a record names the work it is
 * about by its scope, never by text in its message. Judged here, over every record a run's
 * instances logged, each observed as it is written:
 * - a record emitted while a cycle runs carries the cycle's number: the design asks it of warn and
 *   error records, and every level is held to it, since all a cycle runs is awaited inside its scope;
 * - a record emitted outside every cycle carries a trace of its own scope root (a request, an
 *   attempt, startup, boot, shutdown, a halt, the NOTIFY listener), never the logger's root trace,
 *   which no scope minted: a record under it has no trace to join;
 * - every record of an attempt's trace carries the attempt's task and attempt number, the trace
 *   known either by its dev_sessions row or by a record of it that carries both, so an attempt
 *   that ended before its session row was written is judged too;
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
  const calls = z
    .array(callRow)
    .parse((await db.execute(sql`SELECT id::text, trace_id AS "traceId" FROM llm_calls`)).rows);
  const sessions = z
    .array(sessionRow)
    .parse(
      (await db.execute(sql`SELECT id::text, task_id::text AS "taskId", trace_id AS "traceId" FROM dev_sessions`)).rows,
    );
  return { calls, sessions };
}

/** One distinct task-and-attempt a trace's records carried, and the first record that carried it. */
interface TraceCorrelation {
  readonly taskId: string | undefined;
  readonly attempt: number | undefined;
  readonly event: string;
}

/** When a record was written: the run's step, and whether a cycle of the live instance was running. */
export interface WrittenAt {
  readonly step: number;
  readonly cycleRunning: boolean;
}

/**
 * L1, judged as the run's records are written: each record is observed once, what the end of the
 * run's verdict needs of it is kept, and no bound on the records a run keeps for its reader
 * limits what is judged.
 */
export class LogCorrelationJudge {
  private readonly violations = new Map<string, Violation>();
  private observed = 0;
  /** Per trace, the distinct task-and-attempt pairs its records carried. */
  private readonly traces = new Map<string, Map<string, TraceCorrelation>>();
  /** Per finance.call-admitted record, the call it names and the trace it was logged in. */
  private readonly admitted: Array<{ readonly callId: string | undefined; readonly traceId: string }> = [];

  /** Judges `record` as it is written, at the run's `step`, inside a cycle or outside every cycle. */
  observe(record: LogRecord, at: WrittenAt): void {
    const { step } = at;
    this.observed += 1;
    if (at.cycleRunning && record.cycle === undefined) {
      this.add(
        step,
        `outside-cycle:${record.event}`,
        `${record.level} record "${record.event}" was logged while cycle ${step} ran, with no cycle in its ` +
          `scope: ${record.msg.slice(0, 200)}`,
      );
    }
    if (!at.cycleRunning && record.parentTraceId === undefined) {
      this.add(
        step,
        `root-trace:${record.event}`,
        `${record.level} record "${record.event}" was logged outside every cycle under its logger's root ` +
          `trace (boot ${record.boot}), in no scope root: ${record.msg.slice(0, 200)}`,
      );
    }
    if (record.event === "finance.call-admitted")
      this.admitted.push({ callId: record.callId, traceId: record.traceId });
    const key = `${String(record.taskId)}|${String(record.attempt)}`;
    let seen = this.traces.get(record.traceId);
    if (seen === undefined) {
      seen = new Map();
      this.traces.set(record.traceId, seen);
    }
    if (!seen.has(key)) seen.set(key, { taskId: record.taskId, attempt: record.attempt, event: record.event });
  }

  /** L1 over every record observed and the run's rows, judged once the run ends. */
  verdict(step: number, rows: CorrelationRows, dispatched: boolean): Violation[] {
    const violations = new Map(this.violations);
    const add = (key: string, statement: string): void => {
      if (!violations.has(`L1:${key}`))
        violations.set(`L1:${key}`, { invariant: "L1", step, statement, key: `L1:${key}` });
    };

    if (dispatched && this.observed === 0) add("no-records", "the run dispatched, and its instances logged no record");

    const unTraced = rows.calls.filter((call) => call.traceId === null).length;
    if (unTraced > 0) add("call-without-trace", `${unTraced} llm_calls row(s) carry no trace_id`);
    const sessionsUnTraced = rows.sessions.filter((session) => session.traceId === null).length;
    if (sessionsUnTraced > 0) add("session-without-trace", `${sessionsUnTraced} dev_sessions row(s) carry no trace_id`);

    const callTraces = new Map(rows.calls.map((call) => [call.id, call.traceId]));
    for (const record of this.admitted) {
      if (record.callId === undefined) {
        add("admitted-without-call", `a finance.call-admitted record carries no callId (trace ${record.traceId})`);
        continue;
      }
      if (!callTraces.has(record.callId)) {
        add(
          "admitted-call-unknown",
          `finance.call-admitted names call ${record.callId}, which no llm_calls row of the run is`,
        );
        continue;
      }
      const rowTrace = callTraces.get(record.callId);
      if (rowTrace !== null && rowTrace !== record.traceId) {
        add(
          "admitted-trace-differs",
          `llm_calls ${record.callId} carries trace ${String(rowTrace)}, its finance.call-admitted record ` +
            `${record.traceId}`,
        );
      }
    }

    const sessionTasks = new Map<string, string>();
    for (const session of rows.sessions)
      if (session.traceId !== null) sessionTasks.set(session.traceId, session.taskId);
    for (const [traceId, seen] of this.traces) {
      const carried = [...seen.values()];
      const expected =
        sessionTasks.get(traceId) ?? carried.find((c) => c.taskId !== undefined && c.attempt !== undefined)?.taskId;
      if (expected === undefined) continue;
      const source = sessionTasks.has(traceId) ? "its dev_sessions row" : "its own records";
      for (const c of carried) {
        if (c.taskId === expected && c.attempt !== undefined) continue;
        add(
          `attempt-uncorrelated:${c.event}`,
          `record "${c.event}" of the attempt trace ${traceId} (task ${expected}, by ${source}) carries task ` +
            `${String(c.taskId)} and attempt ${String(c.attempt)}`,
        );
      }
    }
    return [...violations.values()];
  }

  private add(step: number, key: string, statement: string): void {
    if (!this.violations.has(`L1:${key}`))
      this.violations.set(`L1:${key}`, { invariant: "L1", step, statement, key: `L1:${key}` });
  }
}

/**
 * The log port every composed instance writes to: `judge` observes every record as it is
 * written, while what was running (`at`) is still known; `kept` holds only the last `keep`, for
 * the run's reader.
 */
export function judgingSink(judge: LogCorrelationJudge, at: () => WrittenAt, kept: LogRecord[], keep: number): LogSink {
  return {
    write(record) {
      judge.observe(record, at());
      kept.push(record);
      if (kept.length > keep) kept.splice(0, kept.length - keep);
    },
  };
}
