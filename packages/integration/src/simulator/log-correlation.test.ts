import { describe, expect, it } from "vitest";
import type { LogRecord } from "@ashara/shared";
import { checkLogCorrelation, uncorrelatedInCycle } from "./log-correlation.js";

const BOOT = "00000000-0000-4000-8000-000000000000";

function record(fields: Partial<LogRecord> & Pick<LogRecord, "event">): LogRecord {
  return { traceId: "t-root", ts: "2026-10-17T00:00:00.000Z", level: "info", boot: BOOT, msg: "m", ...fields };
}

const CALL = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

describe("L1, log correlation", () => {
  it("a record logged while a cycle runs must carry the cycle, a warn and an error as much as an info", () => {
    expect(uncorrelatedInCycle(3, record({ event: "delivery.x", level: "warn" }))?.key).toBe("L1:outside-cycle:delivery.x");
    expect(uncorrelatedInCycle(3, record({ event: "delivery.x", level: "error" }))?.invariant).toBe("L1");
    expect(uncorrelatedInCycle(3, record({ event: "delivery.x", level: "info" }))?.invariant).toBe("L1");
    expect(uncorrelatedInCycle(3, record({ event: "delivery.x", level: "warn", cycle: 3 }))).toBeNull();
  });

  it("passes a run whose admitted calls, sessions and attempt records join", () => {
    const records = [
      record({ event: "finance.call-admitted", traceId: "t-attempt", callId: CALL, taskId: TASK, attempt: 1, cycle: 1 }),
      record({ event: "delivery.cycle-complete", traceId: "t-cycle", cycle: 1 }),
    ];
    const rows = { calls: [{ id: CALL, traceId: "t-attempt" }], sessions: [{ id: "s", taskId: TASK, traceId: "t-attempt" }] };
    expect(checkLogCorrelation(5, records, rows, true)).toEqual([]);
  });

  it("finds a dispatched attempt's record without its task or attempt, an admitted call with no row or another trace, an untraced row and an empty log", () => {
    const keys = (records: readonly LogRecord[], rows: Parameters<typeof checkLogCorrelation>[2], dispatched = true): string[] =>
      checkLogCorrelation(5, records, rows, dispatched).map((violation) => violation.key);
    const session = { id: "s", taskId: TASK, traceId: "t-attempt" };

    expect(keys([record({ event: "finance.call-admitted", traceId: "t-attempt", callId: CALL })], { calls: [{ id: CALL, traceId: "t-attempt" }], sessions: [session] })).toEqual([
      "L1:attempt-uncorrelated:finance.call-admitted",
    ]);
    expect(keys([record({ event: "finance.call-admitted", callId: CALL })], { calls: [], sessions: [] })).toEqual(["L1:admitted-call-unknown"]);
    expect(keys([record({ event: "finance.call-admitted", traceId: "t-a", callId: CALL })], { calls: [{ id: CALL, traceId: "t-b" }], sessions: [] })).toEqual([
      "L1:admitted-trace-differs",
    ]);
    expect(keys([record({ event: "finance.call-admitted" })], { calls: [], sessions: [] })).toEqual(["L1:admitted-without-call"]);
    expect(keys([record({ event: "x.y" })], { calls: [{ id: CALL, traceId: null }], sessions: [{ ...session, traceId: null }] })).toEqual([
      "L1:call-without-trace",
      "L1:session-without-trace",
    ]);
    expect(keys([], { calls: [], sessions: [] })).toEqual(["L1:no-records"]);
    expect(keys([], { calls: [], sessions: [] }, false)).toEqual([]);
  });
});
