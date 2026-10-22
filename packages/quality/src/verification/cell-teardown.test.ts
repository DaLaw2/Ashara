import { describe, expect, test } from "vitest";
import type { Cell } from "@ashara/execution-infra";
import { CellTeardownFailed } from "@ashara/execution-infra";
import { recordingLogger } from "@ashara/shared/testing";
import { CellTeardown } from "./cell-teardown.js";

function cellFailing(error: Error | null): Cell {
  const cell: Pick<Cell, "teardown"> = {
    teardown: async () => {
      if (error !== null) throw error;
    },
  };
  return cell as Cell;
}

describe("CellTeardown", () => {
  test("a failed teardown is logged at warn and emitted with the cell, never thrown", async () => {
    const logger = recordingLogger();
    const events: Array<Record<string, unknown>> = [];
    const teardown = new CellTeardown({ logger, eventSink: { emit: (event) => void events.push(event) } });
    await teardown.teardownCell({ taskId: "t1", attempt: 2 }, cellFailing(new CellTeardownFailed("cell-9", 125, "busy")));
    expect(logger.records.map((record) => [record.level, record.event])).toEqual([["warn", "quality.cell-teardown-failed"]]);
    expect(logger.records[0]?.msg).toContain("[t1 attempt 2]");
    expect(events).toEqual([{ event: "cell_teardown_failed", taskId: "t1", attempt: 2, cellId: "cell-9", exitCode: 125, stderr: "busy" }]);
  });

  test("a sweep's cell is named by its project", async () => {
    const logger = recordingLogger();
    await new CellTeardown({ logger }).teardownCell({ projectId: "p1" }, cellFailing(new CellTeardownFailed("cell-1", null, "")));
    expect(logger.records[0]?.msg).toContain("[acceptance-p1]");
  });

  test("any other failure is not a teardown's to swallow: it is thrown", async () => {
    const teardown = new CellTeardown({ logger: recordingLogger() });
    await expect(teardown.teardownCell({ taskId: "t1", attempt: 1 }, cellFailing(new TypeError("bug")))).rejects.toThrow("bug");
  });

  test("a clean teardown logs and emits nothing", async () => {
    const logger = recordingLogger();
    const events: unknown[] = [];
    await new CellTeardown({ logger, eventSink: { emit: (event) => void events.push(event) } }).teardownCell({ taskId: "t1", attempt: 1 }, cellFailing(null));
    expect(logger.records).toEqual([]);
    expect(events).toEqual([]);
  });
});
