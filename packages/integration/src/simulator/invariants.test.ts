import { describe, expect, it } from "vitest";
import type { FaultRecord } from "./faults.js";
import { TRANSPORT_RESPONSES } from "./faults.js";
import { cellRoleViolations, checkCharges, checkSnapshot, checkTotality, misreadRejections } from "./invariants.js";
import type { ChargeWindow, Charges, Snapshot } from "./invariants.js";
import { MISREAD_REJECTION_MARKER } from "./product.js";

const OWNER = "0ed5677b-4330-4dec-be2e-586c7d953682";
const OTHER = "3ee4bc78-d595-4ff8-991f-4b0aed2c67c3";
const items = [
  { id: "env", title: "Define the environment", workKind: "environment", ownerRoleId: OWNER },
  { id: "impl", title: "Deliver b1", workKind: "implementation", ownerRoleId: OWNER },
];
const cell = (task: string, role: string): { labels: Record<string, string> } => ({ labels: { "ashara.task": task, "ashara.role": role } });

describe("I3's cell clause", () => {
  it("takes the owner's cell and Z0's verifier and CI cells (seed 272: a post-merge verifier cell is no role violation)", () => {
    expect(cellRoleViolations(items, [cell("impl", OWNER), cell("impl", "verifier"), cell("impl", "ci"), cell("env", "environment-check")])).toEqual([]);
  });

  it("names a cell of another roster role, an unknown role, and a Z0 role outside its work kind", () => {
    const found = cellRoleViolations(items, [cell("impl", OTHER), cell("impl", "reviewer"), cell("impl", "environment-check"), { labels: { "ashara.task": "env" } }]);
    expect(found.map((violation) => violation.key)).toEqual([
      `cell-role:Deliver b1:${OTHER}`,
      "cell-role:Deliver b1:reviewer",
      "cell-role:Deliver b1:environment-check",
      "cell-role:Define the environment:none",
    ]);
  });
});

describe("I3's review clause", () => {
  it("names a misread rejection that was recorded, and nothing else a review found", () => {
    const findings = [
      { checkTaskId: "impl", problem: "Check c1 cannot pass on correct work." },
      { checkTaskId: "impl", problem: `Check c2 asks for behaviour no cited item names (${MISREAD_REJECTION_MARKER}).` },
    ];
    expect(misreadRejections(findings, items).map((violation) => violation.key)).toEqual(["misread-rejection:Deliver b1"]);
    expect(misreadRejections(findings.slice(0, 1), items)).toEqual([]);
  });
});

describe("I10, charged only for agent work", () => {
  const charges = (dispatches: number, lessons: number, intakeAttempts: number): Charges => ({
    tasks: new Map([["impl", { title: "Deliver b1", dispatches, lessons }]]),
    projects: new Map([["p1", { intakeAttempts, planAttempts: 0, replanAttempts: 0 }]]),
  });
  const fault = (task: string | null, kind: FaultRecord["fault"], response: FaultRecord["response"] = null): FaultRecord => ({
    ticket: 1, instance: "sim-1", seam: kind === "provider-error" ? "model" : "podman", label: "run", fault: kind, task, response,
  });
  const window = (over: Partial<ChargeWindow>): ChargeWindow => ({
    step: 3, before: charges(0, 0, 0), after: charges(0, 0, 0), faults: [], consulted: new Set(), misbehaved: false, ...over,
  });
  const [, throttled, , , malformed] = TRANSPORT_RESPONSES;

  it("names an attempt and a lesson charged under a substrate fault its model did no work for", () => {
    const planted = window({ after: charges(1, 1, 0), faults: [fault("impl", "cell-start-failed")] });
    expect(checkCharges(planted).map((violation) => violation.key)).toEqual(["I10:dispatch:Deliver b1", "I10:lesson:Deliver b1"]);
  });

  it("leaves a charge alone once the model worked, or a provider's failure or a crash is in the lane", () => {
    const charged = { after: charges(1, 0, 0) };
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "cell-start-failed")], consulted: new Set(["impl"]) }))).toEqual([]);
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "git-failed"), fault("impl", "provider-error", throttled)] }))).toEqual([]);
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "git-failed"), fault("impl", "crash-before")] }))).toEqual([]);
    // A crash in another lane, or outside every lane, stops this one's attempt too.
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "db-query-failed"), fault(null, "crash-after")] }))).toEqual([]);
  });

  it("judges a killed transaction as the process death it is, and every other database fault as Ashara's (seed 77, two projects)", () => {
    const charged = { after: charges(1, 0, 0) };
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "db-transaction-killed")] }))).toEqual([]);
    expect(checkCharges(window({ ...charged, faults: [fault("impl", "git-failed"), fault(null, "db-transaction-killed")] }))).toEqual([]);
    expect(checkCharges(window({ after: charges(0, 0, 1), faults: [fault(null, "provider-error", malformed), fault(null, "db-transaction-killed")] }))).toEqual([]);
    for (const kind of ["db-unreachable", "db-query-failed"] as const) {
      expect(checkCharges(window({ ...charged, faults: [fault("impl", kind)] })).map((violation) => violation.key)).toEqual(["I10:dispatch:Deliver b1"]);
    }
  });

  it("names a read counted as failed under a request the provider rejected as Ashara built it, unless a model misbehaved", () => {
    const rejected = window({ after: charges(0, 0, 1), faults: [fault(null, "provider-error", malformed)] });
    expect(checkCharges(rejected).map((violation) => violation.key)).toEqual(["I10:intakeAttempts"]);
    expect(checkCharges({ ...rejected, misbehaved: true })).toEqual([]);
    expect(checkCharges(window({ after: charges(0, 0, 1), faults: [fault(null, "provider-error", throttled)] }))).toEqual([]);
  });
});

/** A snapshot of one project holding `items`, with nothing else on record. */
function plantedSnapshot(items: Snapshot["items"]): Snapshot {
  return {
    project: { status: "active", blockedCategory: null, blockedReason: null, planStopped: false, workspacePath: null, deliveredReported: false },
    items,
    episodes: [],
    checks: [],
    reviewFindings: [],
    spendUsd: 0,
    unrecordedCalls: 0,
    events: [],
    main: [],
    reports: { reports: [], episodes: [], burnWarnings: [], repairs: [], sweeps: [], revisionReports: [], reviewSpec: null, goalChecks: [], goalUndecided: [], passedSweeps: [] },
    textFacts: {
      visions: [], briefs: [], questions: [], answerReplies: [], tenderReports: [], delivered: [], sweepReplies: [],
      interfaceOnMain: { kind: "not-held" }, reviewSpec: null, firstPlan: { report: null, items: [], revisions: [] },
    },
  };
}

describe("C9: a state with no exit", () => {
  const task = (status: string, blockedReason: unknown): Snapshot["items"][number] => ({
    id: "impl", title: "Deliver b1", status, level: "Task", workKind: "implementation", origin: null, checksFor: null, blockedReason,
    mergeCommit: null, mergeKind: null, ownerRoleId: OWNER, dispatchCount: 1, infrastructureFaults: 0,
  });

  it("names a Blocked task whose reason no exit of the loop reads (I2)", () => {
    const stranded = plantedSnapshot([task("Blocked", { source: "planted-no-such-source" })]);
    const keys = checkSnapshot(4, stranded, { spendCapUsd: 25, cells: [], final: false }).map((violation) => violation.key);
    expect(keys).toEqual(["I2:Deliver b1:none"]);
  });

  it("names every non-terminal state of a run that made no progress (I8)", () => {
    const stalled = plantedSnapshot([task("Pending", null)]);
    expect(checkTotality(9, stalled, 6).map((violation) => violation.key)).toEqual(["I8:Pending"]);
    expect(checkTotality(9, plantedSnapshot([task("Completed", null)]), 6)).toEqual([]);
  });
});
