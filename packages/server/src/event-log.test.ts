import { describe, expect, test } from "vitest";
import { createEventLog } from "./event-log.js";

const REFUSED = /^Event line "[a-z_]+" does not match its schema: /;

const AT = Date.UTC(2026, 9, 16, 8, 30, 0, 125);

function capture(): { lines: string[]; refused: string[]; log: ReturnType<typeof createEventLog> } {
  const lines: string[] = [];
  const refused: string[] = [];
  return {
    lines,
    refused,
    log: createEventLog(
      { now: () => AT },
      (line) => lines.push(line),
      (error) => refused.push(error.message),
    ),
  };
}

function body(line: string): Record<string, unknown> {
  expect(line.startsWith("[event] ")).toBe(true);
  const parsed: unknown = JSON.parse(line.slice("[event] ".length));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError(`not a JSON object: ${line}`);
  return Object.fromEntries(Object.entries(parsed));
}

describe("createEventLog", () => {
  test("each line is the event led by the injected clock's ISO-8601 UTC timestamp", () => {
    const { lines, log } = capture();
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 2, reason: "gate red", detail: undefined });
    log.emit({ event: "ladder_attempt", site: "intake", attempt: 1, capability: "Strong", model: "m", outcome: "valid" });
    log.emit({ event: "cycle_complete", tasksProcessed: 2, completed: 1, failed: 1, refused: 0, interrupted: 0 });

    expect(lines).toHaveLength(3);
    expect(body(lines[0])).toEqual({ timestamp: "2026-10-16T08:30:00.125Z", event: "task_failed", taskId: "t-1", attempt: 2, reason: "gate red" });
    expect(Object.keys(body(lines[1]))[0]).toBe("timestamp");
    expect(body(lines[2])).toEqual({
      timestamp: "2026-10-16T08:30:00.125Z",
      event: "cycle_complete",
      tasksProcessed: 2,
      completed: 1,
      failed: 1,
      refused: 0,
      interrupted: 0,
    });
  });

  test("a project's event names its project and no attempt", () => {
    const { lines, log } = capture();
    log.emit({ event: "cell_teardown_failed", projectId: "p-1", cellId: "c-1", exitCode: 1, stderr: "busy" });
    expect(body(lines[0])).toEqual({
      timestamp: "2026-10-16T08:30:00.125Z",
      event: "cell_teardown_failed",
      projectId: "p-1",
      cellId: "c-1",
      exitCode: 1,
      stderr: "busy",
    });
  });

  test("an event naming no attempt, or a value JSON cannot hold, does not compile", () => {
    const { lines, refused, log } = capture();
    // @ts-expect-error an attempt's event names its task and its attempt
    log.emit({ event: "task_failed", taskId: "t-1", reason: "names no attempt" });
    // @ts-expect-error a Date is no JSON value
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, at: new Date(AT) });
    // @ts-expect-error a project's event names its project
    log.emit({ event: "acceptance_sweep", taskId: "t-1", attempt: 1 });
    expect(lines).toEqual([]);
    expect(refused).toHaveLength(3);
  });

  test("an event its schema still refuses is handed to refuse, never thrown, and nothing is written", () => {
    const { lines, refused, log } = capture();
    expect(() => log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, cost: Number.NaN })).not.toThrow();
    log.emit({ event: "cycle_complete", tasksProcessed: -1, completed: 0, failed: 0, refused: 0, interrupted: 0 });
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, timestamp: "forged" });
    log.emit({ event: "task_failed", taskId: "t-1", attempt: 1, timestamp: undefined });
    expect(lines).toEqual([]);
    expect(refused).toHaveLength(4);
    for (const message of refused) expect(message).toMatch(REFUSED);
  });
});
