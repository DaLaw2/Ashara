import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { ClientStops } from "./client-stop.js";
import type { ClientStopStore } from "./client-stop.js";
import { guaranteeTableOf } from "./guarantee-report.js";
import type { GuaranteeRecords } from "./guarantee-report.js";
import type { DueStopReport } from "./stop-report.js";
import { TerminalMessage, TerminalReports } from "./terminal-report.js";
import type { TerminalReportStore } from "./terminal-report.js";
import { readVisionVersion } from "./vision.js";

// The client's stop is answered once its terminal sweep is recorded, by a terminal message that
// carries that sweep's guarantee table: every guarantee of the version in force once, its verdicts
// posted with it. A stop of a project already accepted says the acceptance stands.

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

const STOP: DueStopReport = { stopId: "stop-1", projectId, merged: [{ title: "Store keys", commit: MAIN, kind: "merged" }], paused: false, accepted: false };

/** The terminal step over one due stop report, returning what it posted. */
async function postStop(stop: DueStopReport): Promise<TerminalMessage[]> {
  const posted: TerminalMessage[] = [];
  const store: TerminalReportStore = {
    dueTerminals: async () => [{ kind: "listed", event: { kind: "stopped", projectId, stop }, table: guaranteeTableOf(SWEPT) }],
    postTerminal: async (message) => {
      posted.push(message);
      return "posted";
    },
    recordDeliveredFailure: async () => expect.unreachable("no delivered report is due"),
  };
  const outcomes = await new TerminalReports(store, { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) }, memoryStepContainment(() => true)).runPending();
  expect(outcomes).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
  return posted;
}

describe("the stop report", () => {
  test("holds the table of the stop's sweep, every guarantee once, and posts its verdicts", async () => {
    const [message, ...rest] = await postStop(STOP);
    expect(rest).toEqual([]);
    const { subject, body, verdicts } = message ?? expect.unreachable("one message is posted");
    expect(subject).toEqual({ kind: "stopped", stopId: "stop-1" });
    expect(body.startsWith("Work on this project has stopped at your request.")).toBe(true);
    const table = body.split("\n\n").find((part) => part.startsWith("Each guarantee of your contract")) ?? "";
    expect(table.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, 4))).toEqual(["G1", "G2"]);
    expect(body).toContain("- G2: unjudged, no check deciding it ran and passed");
    expect(verdicts).toEqual(TerminalMessage.of({ kind: "declined", projectId }, guaranteeTableOf(SWEPT)).verdicts);
    expect(body).not.toContain("accepted");
  });

  test("a stop of a project already accepted says its acceptance stands, with the table", async () => {
    const [message] = await postStop({ ...STOP, accepted: true });
    const { body } = message ?? expect.unreachable("one message is posted");
    expect(body).toContain("This project had already been accepted when your request arrived: its acceptance stands");
    expect(body.indexOf("its acceptance stands")).toBeLessThan(body.indexOf("Each guarantee of your contract"));
  });

  test("a stop recorded before acceptance was recorded on it says that is not on record", async () => {
    const [message] = await postStop({ ...STOP, accepted: null });
    expect(message?.body).toContain("Whether this project had already been accepted when your request arrived is not on record.");
  });

  test("a stop is taken at once; its report waits for the cycle's terminal sweeps", async () => {
    const store: ClientStopStore = {
      openStops: async () => [{ id: "stop-1", projectId }],
      recordStop: async () => ({ kind: "stopped", reportDue: true }),
    };
    expect(await new ClientStops(store, memoryStepContainment(() => true)).runPending()).toEqual([{ kind: "stopped", reportDue: true, stopId: "stop-1", projectId }]);
  });
});
