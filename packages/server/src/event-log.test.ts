import { describe, expect, test } from "vitest";
import { createEventLog } from "./event-log.js";

const REFUSED = /^Event line "[a-z_]+" does not match its schema: /;

const AT = Date.UTC(2026, 9, 16, 8, 30, 0, 125);

function capture(): { lines: string[]; log: ReturnType<typeof createEventLog> } {
  const lines: string[] = [];
  return { lines, log: createEventLog({ now: () => AT }, (line) => lines.push(line)) };
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

  test("an event that fails its schema is refused and nothing is written", () => {
    const { lines, log } = capture();
    expect(() => log.emit({ event: "task_failed", reason: "names no task" })).toThrow(REFUSED);
    expect(() => log.emit({ event: "cycle_complete", tasksProcessed: -1, completed: 0, failed: 0, refused: 0, interrupted: 0 })).toThrow(REFUSED);
    expect(() => log.emit({ event: "task_failed", taskId: "t-1", timestamp: "forged" })).toThrow(REFUSED);
    expect(() => log.emit({ event: "task_failed", taskId: "t-1", timestamp: undefined })).toThrow(REFUSED);
    expect(() => log.emit({ event: "task_failed", taskId: "t-1", cost: Number.NaN })).toThrow(REFUSED);
    expect(lines).toEqual([]);
  });
});
