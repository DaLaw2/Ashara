import { describe, expect, it } from "vitest";
import type { LogRecord } from "@ashara/shared";
import type { CorrelationRows, WrittenAt } from "./log-correlation.js";
import { LogCorrelationJudge, judgingSink } from "./log-correlation.js";

const BOOT = "00000000-0000-4000-8000-000000000000";

function record(fields: Partial<LogRecord> & Pick<LogRecord, "event">): LogRecord {
  return { traceId: "t-scope", parentTraceId: "t-root", ts: "2026-10-17T00:00:00.000Z", level: "info", boot: BOOT, msg: "m", ...fields };
}

const CALL = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const OUTSIDE: WrittenAt = { step: 5, cycleRunning: false };
const NO_ROWS: CorrelationRows = { calls: [], sessions: [] };

/** L1's keys over `records`, each written at `at`. */
function keys(records: readonly LogRecord[], rows: CorrelationRows, dispatched = true, at: WrittenAt = OUTSIDE): string[] {
  const judge = new LogCorrelationJudge();
  for (const r of records) judge.observe(r, at);
  return judge.verdict(5, rows, dispatched).map((violation) => violation.key);
}

describe("L1, log correlation", () => {
  it("a record logged while a cycle runs must carry the cycle, a warn and an error as much as an info", () => {
    const inCycle: WrittenAt = { step: 3, cycleRunning: true };
    expect(keys([record({ event: "delivery.x", level: "warn" })], NO_ROWS, false, inCycle)).toEqual(["L1:outside-cycle:delivery.x"]);
    expect(keys([record({ event: "delivery.x", level: "error" })], NO_ROWS, false, inCycle)).toEqual(["L1:outside-cycle:delivery.x"]);
    expect(keys([record({ event: "delivery.x", level: "info" })], NO_ROWS, false, inCycle)).toEqual(["L1:outside-cycle:delivery.x"]);
    expect(keys([record({ event: "delivery.x", level: "warn", cycle: 3 })], NO_ROWS, false, inCycle)).toEqual([]);
  });

  it("a record logged outside every cycle must carry a scope root's trace, never only the logger's root trace", () => {
    expect(keys([record({ event: "server.listening", traceId: "t-root", parentTraceId: undefined })], NO_ROWS, false)).toEqual([
      "L1:root-trace:server.listening",
    ]);
    expect(keys([record({ event: "server.listening" })], NO_ROWS, false)).toEqual([]);
  });

  it("passes a run whose admitted calls, sessions and attempt records join", () => {
    const records = [
      record({ event: "finance.call-admitted", traceId: "t-attempt", callId: CALL, taskId: TASK, attempt: 1, cycle: 1 }),
      record({ event: "delivery.cycle-complete", traceId: "t-cycle", cycle: 1 }),
    ];
    const rows = { calls: [{ id: CALL, traceId: "t-attempt" }], sessions: [{ id: "s", taskId: TASK, traceId: "t-attempt" }] };
    expect(keys(records, rows)).toEqual([]);
  });

  it("judges an attempt that ended before its session row was written by its own records' task and attempt", () => {
    const records = [
      record({ event: "delivery.dispatch-started", traceId: "t-attempt", taskId: TASK, attempt: 1 }),
      record({ event: "delivery.dispatch-threw", traceId: "t-attempt" }),
    ];
    expect(keys(records, NO_ROWS)).toEqual(["L1:attempt-uncorrelated:delivery.dispatch-threw"]);
  });

  it("judges every record written, not only the ones the run keeps for its reader", () => {
    const judge = new LogCorrelationJudge();
    const kept: LogRecord[] = [];
    const sink = judgingSink(judge, () => OUTSIDE, kept, 400);
    sink.write(record({ event: "server.listening", traceId: "t-root", parentTraceId: undefined }));
    for (let i = 0; i < 400; i++) sink.write(record({ event: "delivery.fine" }));
    expect(kept).toHaveLength(400);
    expect(kept.some((r) => r.event === "server.listening")).toBe(false);
    expect(judge.verdict(5, NO_ROWS, true).map((v) => v.key)).toEqual(["L1:root-trace:server.listening"]);
  });

  it("finds a dispatched attempt's record without its task or attempt, an admitted call with no row or another trace, an untraced row and an empty log", () => {
    const session = { id: "s", taskId: TASK, traceId: "t-attempt" };

    expect(keys([record({ event: "finance.call-admitted", traceId: "t-attempt", callId: CALL })], { calls: [{ id: CALL, traceId: "t-attempt" }], sessions: [session] })).toEqual([
      "L1:attempt-uncorrelated:finance.call-admitted",
    ]);
    expect(keys([record({ event: "finance.call-admitted", callId: CALL })], NO_ROWS)).toEqual(["L1:admitted-call-unknown"]);
    expect(keys([record({ event: "finance.call-admitted", traceId: "t-a", callId: CALL })], { calls: [{ id: CALL, traceId: "t-b" }], sessions: [] })).toEqual([
      "L1:admitted-trace-differs",
    ]);
    expect(keys([record({ event: "finance.call-admitted" })], NO_ROWS)).toEqual(["L1:admitted-without-call"]);
    expect(keys([record({ event: "x.y" })], { calls: [{ id: CALL, traceId: null }], sessions: [{ ...session, traceId: null }] })).toEqual([
      "L1:call-without-trace",
      "L1:session-without-trace",
    ]);
    expect(keys([], NO_ROWS)).toEqual(["L1:no-records"]);
    expect(keys([], NO_ROWS, false)).toEqual([]);
  });
});
