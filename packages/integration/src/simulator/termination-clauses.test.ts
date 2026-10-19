import { describe, expect, it } from "vitest";
import { PortCount, checkLiveness, checkLoops, checkWork } from "./termination.js";
import type { LoopRecords } from "./termination.js";

/** The clauses of W1-W4 on records written here, each one no directed run reaches (termination.test.ts, termination-plants.test.ts and termination-unbounded.test.ts run the rest). */
const task = (over: Partial<LoopRecords["checkTasks"][number]> = {}): LoopRecords["checkTasks"][number] => ({
  id: "ct1", title: "checks", status: "Completed", namings: 0, disputes: 0, reviewReopens: 0, disputeReopens: 0, ...over,
});
const records = (over: Partial<LoopRecords> = {}): LoopRecords => ({ checkTasks: [task()], revisions: 1, requests: 10, grownAfterFreeze: [], ...over });
const keys = (found: ReadonlyArray<{ readonly key: string }>): string[] => found.map((v) => v.key).sort();

describe("W2 and W3 on loop records", () => {
  it("passes a review round that left its count and spent the measure", () => {
    const before = records();
    const after = records({ checkTasks: [task({ namings: 1, reviewReopens: 1, status: "Pending" })], requests: 12 });
    expect(checkLoops(2, after, before, new Map())).toEqual([]);
  });

  it("names a count that fell between two snapshots, as across a restart", () => {
    expect(keys(checkLoops(3, records({ checkTasks: [task({ disputes: 1 })] }), null, new Map([["ct1:disputes", 2]])))).toEqual(["W2:count-fell:checks:disputes"]);
  });

  it("names a finding recorded after the review's check set froze", () => {
    expect(keys(checkLoops(4, records({ grownAfterFreeze: [{ title: "review", findings: 1 }] }), null, new Map()))).toEqual(["W3:grew-after-freeze:review"]);
  });

  it("names a round that left the measure no smaller and no reopened check task fewer", () => {
    // The disputes left grow back with no plan revision to pay for it, and nothing else moved.
    const before = records({ checkTasks: [task({ disputes: 1, disputeReopens: 1, status: "Pending" })] });
    const after = records({ checkTasks: [task({ disputes: 0, disputeReopens: 3, status: "Pending" })] });
    expect(keys(checkLoops(5, after, before, new Map()))).toEqual(["W2:dispute-uncounted:checks", "W3:no-decrease"]);
  });
});

describe("W1 on requests", () => {
  it("names a request the port answered that no llm_calls row records", () => {
    const port = new PortCount();
    port.record("t1");
    port.record("t1");
    const found = checkWork(9, port, [{ total: 1, tasks: new Map([["t1", { title: "task one", requests: 1 }]]) }]);
    expect(keys(found.map((each) => each.violation))).toEqual(["W1:unrecorded", "W1:unrecorded:task one"]);
  });
});

describe("W4 on a project's end", () => {
  it("names a project the dollars ended, or that stalled, and passes a typed halt", () => {
    expect(keys(checkLiveness(1, { kind: "halted", cause: "spend_cap", detail: "budget_cap" }, false, 120))).toEqual(["W4:spend-cap"]);
    expect(keys(checkLiveness(1, { kind: "halted", cause: "undeliverable", detail: "plan_repair" }, true, 120))).toEqual(["W4:stalled"]);
    expect(checkLiveness(1, { kind: "halted", cause: "work_budget", detail: "work_budget" }, false, 120)).toEqual([]);
  });
});
