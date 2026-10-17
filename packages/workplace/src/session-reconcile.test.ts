import { afterEach, describe, expect, test, vi } from "vitest";
import { ORPHANED_SESSION_RESOLVER, terminalizeOrphanedSessions } from "./session-reconcile.js";

// A session a crash left non-terminal has no surviving agent; the next process start is the only
// place it can be closed.
describe("terminalizeOrphanedSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("closes the sessions of tasks found InProgress as crash orphans, by the published resolver, and every other as an ended dispatch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: unknown[][] = [];

    const reconcile = await terminalizeOrphanedSessions(
      {
        failStale: async (orphaned, ended, inProgressTaskIds) => {
          calls.push([orphaned, ended, inProgressTaskIds]);
          return { orphaned: 2, ended: 1 };
        },
      },
      ["task-a"],
    );

    expect(reconcile).toEqual({ kind: "terminalized", orphaned: 2, ended: 1 });
    expect(calls).toEqual([
      [
        expect.objectContaining({ outcome: "abandoned", resolvedBy: ORPHANED_SESSION_RESOLVER }),
        expect.objectContaining({ outcome: "abandoned", resolvedBy: expect.not.stringMatching(/^startup-reconciler$/) }),
        ["task-a"],
      ],
    ]);
  });

  test("a store failure does not refuse the start, and is returned as failed, never as nothing to close", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("db unreachable");

    const reconcile = await terminalizeOrphanedSessions({ failStale: () => Promise.reject(cause) }, []);

    expect(reconcile).toEqual({ kind: "failed", error: cause });
    expect(warn).toHaveBeenCalledOnce();
  });
});
