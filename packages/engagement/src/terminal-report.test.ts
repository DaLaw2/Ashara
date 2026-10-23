import { afterEach, describe, expect, test, vi } from "vitest";
import { UnreadSubject, parseProjectId } from "@ashara/shared";
import type { TerminalKind } from "./predicates.js";
import { listEachKind } from "./terminal-report.js";
import type { KindListings } from "./terminal-report.js";

// The due listing lists each kind of terminal on its own: a kind whose listing fails is that kind's
// fault alone, logged at warn, and every other kind asked for is still listed, in the listing's order.

const projectId = parseProjectId("00000000-0000-4000-8000-000000000031", "test");

/** A listing of one owed terminal per kind, each named by its kind; `failing` throws instead. */
function listings(failing: readonly TerminalKind[], asked: TerminalKind[]): KindListings {
  const one = (kind: TerminalKind) => async () => {
    asked.push(kind);
    if (failing.includes(kind)) throw new Error(`the ${kind} query failed`);
    return [new UnreadSubject(`${kind}:x`, projectId, null)];
  };
  return { stopped: one("stopped"), halted: one("halted"), "planning-stopped": one("planning-stopped"), declined: one("declined"), delivered: one("delivered") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listEachKind", () => {
  test("one kind's listing that throws leaves every other kind listed, and its fault is logged at warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked: TerminalKind[] = [];
    const due = await listEachKind(["stopped", "halted", "planning-stopped", "declined", "delivered"], listings(["halted"], asked));
    expect(due.map((each) => (each instanceof UnreadSubject ? each.id : "listed"))).toEqual(["stopped:x", "planning-stopped:x", "declined:x", "delivered:x"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/the halted terminals could not be listed.*the halted query failed/);
  });

  test("only the kinds asked for are listed, each once, in the listing's order", async () => {
    const asked: TerminalKind[] = [];
    const due = await listEachKind(["delivered", "stopped"], listings([], asked));
    expect(asked).toEqual(["stopped", "delivered"]);
    expect(due).toHaveLength(2);
  });
});
