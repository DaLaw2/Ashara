import { describe, expect, test } from "vitest";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { ClientStops } from "./client-stop.js";
import type { ClientStopStore } from "./client-stop.js";
import { guaranteeTableOf, tableVerdicts } from "./guarantee-report.js";
import type { GuaranteeRecords, TableVerdicts } from "./guarantee-report.js";
import { readVisionVersion } from "./vision.js";

// The client's stop is answered once its terminal sweep is recorded, and the answer carries that
// sweep's guarantee table: every guarantee of the version in force once, its verdicts posted with it.

const projectId = parseProjectId("00000000-0000-4000-8000-000000000032", "test");
const MAIN = "e".repeat(40);
const TENDER = "A key store. Clients put and get keys. A missing key exits 1.";
const quote = (text: string) => ({ kind: "tender", quote: text });

const VISION = readVisionVersion({
  projectId,
  version: 1,
  visionText: TENDER,
  summary: "A store.",
  scopeBoundaries: [],
  inferences: [],
  openQuestions: [],
  contractForm: "guarantees",
  interface: [{ id: "I1", text: "put KEY VALUE, get KEY", source: quote("Clients put and get keys.") }],
  guarantees: [
    { id: "G1", statement: "A get returns the last put.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get returns another value"], source: quote("Clients put and get keys.") },
    { id: "G2", statement: "A get of a missing key exits 1.", observable: { interface: ["I1"], observation: "exit-status" }, refutedBy: ["it exits 0"], source: quote("A missing key exits 1.") },
  ],
  exclusions: [],
});

const SWEPT: GuaranteeRecords = {
  kind: "judged",
  sweep: { id: "sweep-1", mainCommit: MAIN },
  vision: VISION,
  judged: {
    evidence: "recorded",
    verdicts: [
      { guaranteeId: "G1", verdict: { kind: "pass", evidence: "implementer-visible" }, evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: { kind: "unjudged", reason: "no-executed-evidence" }, evidenceClass: "none" },
    ],
  },
  revisions: [],
};

describe("the stop report", () => {
  test("holds the table of the stop's sweep, every guarantee once, and posts its verdicts", async () => {
    const posted: Array<{ stopId: string; body: string; verdicts: TableVerdicts }> = [];
    const store: ClientStopStore = {
      openStops: async () => [],
      recordStop: async () => expect.unreachable("no stop is open"),
      dueStopReports: async () => [{ stopId: "stop-1", projectId, merged: [{ title: "Store keys", commit: MAIN, kind: "merged" }], paused: false, guarantees: guaranteeTableOf(SWEPT) }],
      postStopReport: async (stopId, body, verdicts) => {
        posted.push({ stopId, body, verdicts });
        return "posted";
      },
    };
    expect(await new ClientStops(store, memoryStepContainment(() => true)).reportPending()).toEqual([{ kind: "posted", stopId: "stop-1", projectId }]);
    const [{ stopId, body, verdicts } = { stopId: "", body: "", verdicts: null }] = posted;
    expect(stopId).toBe("stop-1");
    expect(body.startsWith("Work on this project has stopped at your request.")).toBe(true);
    const table = body.split("\n\n").find((part) => part.startsWith("Each guarantee of your contract")) ?? "";
    expect(table.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, 4))).toEqual(["G1", "G2"]);
    expect(body).toContain("- G2: unjudged, no check deciding it ran and passed");
    expect(verdicts).toEqual(tableVerdicts(guaranteeTableOf(SWEPT)));
  });

  test("a stop is taken at once; its report waits for the cycle's terminal sweeps", async () => {
    const store: ClientStopStore = {
      openStops: async () => [{ id: "stop-1", projectId }],
      recordStop: async () => ({ kind: "stopped", reportDue: true }),
      dueStopReports: async () => expect.unreachable("taking the stops reads no report"),
      postStopReport: async () => expect.unreachable("no report is posted before the terminal sweeps"),
    };
    expect(await new ClientStops(store, memoryStepContainment(() => true)).runPending()).toEqual([{ kind: "stopped", reportDue: true, stopId: "stop-1", projectId }]);
  });
});
