import { afterEach, describe, expect, test, vi } from "vitest";
import { ORPHANED_SESSION_RESOLVER, terminalizeOrphanedSessions } from "./session-reconcile.js";

// A session a crash left non-terminal has no surviving agent; the next process start is the only
// place it can be closed.
describe("terminalizeOrphanedSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("closes every non-terminal session as abandoned, by the published resolver, and reports the count", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const resolutions: unknown[] = [];

    const reconcile = await terminalizeOrphanedSessions({
      failStale: async (resolution) => {
        resolutions.push(resolution);
        return 6;
      },
    });

    expect(reconcile).toEqual({ kind: "terminalized", count: 6 });
    expect(resolutions).toEqual([expect.objectContaining({ outcome: "abandoned", resolvedBy: ORPHANED_SESSION_RESOLVER })]);
  });

  test("a store failure does not refuse the start, and is returned as failed, never as nothing to close", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("db unreachable");

    const reconcile = await terminalizeOrphanedSessions({ failStale: () => Promise.reject(cause) });

    expect(reconcile).toEqual({ kind: "failed", error: cause });
    expect(warn).toHaveBeenCalledOnce();
  });
});
