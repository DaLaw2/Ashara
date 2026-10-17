import { describe, expect, test } from "vitest";
import { createLogger, jsonLineSink, logRecordSchema } from "@ashara/shared";
import type { LogRecord } from "@ashara/shared";
import { createEventLog } from "./event-log.js";

const REFUSED = /^Event line "[a-z_]+" does not match its schema: /;

const AT = Date.UTC(2026, 9, 16, 8, 30, 0, 125);
const TS = "2026-10-16T08:30:00.125Z";

/** The event log on a logger writing the exact lines stdout would carry; each line is parsed back as a record. */
function capture(): { records: () => LogRecord[]; log: ReturnType<typeof createEventLog> } {
  const lines: string[] = [];
  const logger = createLogger({ sink: jsonLineSink((line) => lines.push(line)), clock: { now: () => AT }, minLevel: "debug" });
  return {
    records: () =>
      lines.map((line) => {
        expect(line.endsWith("\n")).toBe(true);
        return logRecordSchema.parse(JSON.parse(line));
      }),
    log: createEventLog(logger),
  };
}

describe("createEventLog", () => {
  test("each event is one JSON line, a log record named by its context, timestamped by the injected clock", () => {
    const { records, log } = capture();
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 2, reason: "gate red", detail: undefined });
    log.emit({ event: "ladder_attempt", site: "intake", attempt: 1, capability: "Strong", model: "m", outcome: "valid" });
    log.emit({ event: "cycle_complete", tasksProcessed: 2, completed: 1, failed: 1, refused: 0, interrupted: 0 });

    const [failed, ladder, cycle] = records();
    expect(records()).toHaveLength(3);
    expect(failed).toMatchObject({ ts: TS, level: "info", event: "quality.task-failed", fields: { taskId: "t-1", attempt: 2, reason: "gate red" } });
    expect(failed.fields).not.toHaveProperty("detail");
    expect(ladder).toMatchObject({ ts: TS, event: "model-access.ladder-attempt", fields: { site: "intake", capability: "Strong", outcome: "valid" } });
    expect(cycle).toMatchObject({
      ts: TS,
      level: "info",
      event: "delivery.cycle-complete",
      fields: { tasksProcessed: 2, completed: 1, failed: 1, refused: 0, interrupted: 0 },
    });
  });

  test("a project's event names its project and no attempt", () => {
    const { records, log } = capture();
    log.emit({ event: "cell_teardown_failed", projectId: "p-1", cellId: "c-1", exitCode: 1, stderr: "busy" });
    expect(records()[0]).toMatchObject({
      event: "quality.cell-teardown-failed",
      fields: { projectId: "p-1", cellId: "c-1", exitCode: 1, stderr: "busy" },
    });
  });

  test("an event naming no attempt, or a value JSON cannot hold, does not compile", () => {
    const { records, log } = capture();
    // @ts-expect-error an attempt's event names its task and its attempt
    log.emit({ event: "task_failed", taskId: "t-1", reason: "names no attempt" });
    // @ts-expect-error a Date is no JSON value
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, at: new Date(AT) });
    // @ts-expect-error a project's event names its project
    log.emit({ event: "acceptance_sweep", taskId: "t-1", attempt: 1 });
    expect(records().map((r) => r.event)).toEqual(["server.event-refused", "server.event-refused", "server.event-refused"]);
  });

  test("an event its schema still refuses is logged at error, never thrown, and no event record is written", () => {
    const { records, log } = capture();
    expect(() => log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, cost: Number.NaN })).not.toThrow();
    log.emit({ event: "cycle_complete", tasksProcessed: -1, completed: 0, failed: 0, refused: 0, interrupted: 0 });
    const refused = records();
    expect(refused).toHaveLength(2);
    for (const record of refused) {
      expect(record).toMatchObject({ level: "error", event: "server.event-refused" });
      expect(record.msg).toMatch(REFUSED);
      expect(record.error).toMatchObject({ chain: { name: "EventLineInvalid" } });
    }
  });
});
