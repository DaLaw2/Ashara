import { describe, expect, test } from "vitest";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { BlockReports } from "./block-report.js";
import type { BlockReportStore } from "./block-report.js";
import { DeliveredReports } from "./delivered-report.js";
import type { DeliveredReportStore } from "./delivered-report.js";
import { guaranteeSection, guaranteeTableOf, tableVerdicts } from "./guarantee-report.js";
import { PlanReports } from "./plan-report.js";
import type { PlanReportStore } from "./plan-report.js";
import type { GuaranteeRecords, GuaranteeTable, TableVerdicts } from "./guarantee-report.js";
import type { Evidence } from "./vision-language/index.js";
import { readVisionVersion } from "./vision.js";

// The guarantee table every terminal message carries: every guarantee of the version in force,
// exactly once, on the delivered and halt reports alike (client-stop.test.ts holds the stop report to it); a halt of Ashara's own machines, whose
// sweep ran on no commit, holds every guarantee unjudged and says why, as does a message no sweep is
// on record for; records that do not hold together judge nothing and say so; and no review's reading
// of the checks ever makes a guarantee pass.

const projectId = parseProjectId("00000000-0000-4000-8000-000000000031", "test");
const MAIN = "d".repeat(40);
const TENDER = "A key-value store. Clients put and get values. A crash never loses an acknowledged put. A missing key exits 1.";

const quote = (text: string) => ({ kind: "tender", quote: text });
const GUARANTEES = [
  { id: "G1", statement: "A get returns the value of the last put of its key.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get returns another value"], source: quote("Clients put and get values.") },
  { id: "G2", statement: "An acknowledged put survives a crash.", observable: { interface: ["I1"], observation: "stored-data" }, refutedBy: ["a get misses an acknowledged put after a kill"], source: { kind: "assumption", id: "A1" } },
  { id: "G3", statement: "A get of a missing key exits 1.", observable: { interface: ["I1"], observation: "exit-status" }, refutedBy: ["a get of a missing key exits 0"], source: quote("A missing key exits 1.") },
  { id: "G4", statement: "A delete removes the key.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get after a delete returns the value"], source: quote("Clients put and get values.") },
];
const ASSUMPTIONS = [
  { key: "A1", statement: "A put is acknowledged once it is on disk.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked", underpins: ["G2"] },
  { key: "A2", statement: "The log is a single file.", rationale: "simplest", status: "Inferred", kind: "internal-design", disclosed: "reported" },
];

const VISION = readVisionVersion({
  projectId,
  version: 2,
  visionText: TENDER,
  summary: "A store.",
  scopeBoundaries: [],
  inferences: ASSUMPTIONS,
  openQuestions: [{ messageId: "q1", text: "Ack after disk?", assumptionKey: "A1" }],
  contractForm: "guarantees",
  interface: [{ id: "I1", text: "put KEY VALUE, get KEY, delete KEY", source: quote("Clients put and get values.") }],
  guarantees: GUARANTEES,
  exclusions: [{ id: "X1", text: "No authentication.", source: quote("Clients put and get values.") }],
});

const IDS = GUARANTEES.map((g) => g.id);

const passed = (cls: "witness" | "implementer-visible" | "review-only", id = "c1") => ({ checkId: id, outcome: "passed" as const, class: cls });
const NONE: Evidence = { checks: [], reviewLowers: false };

function recorded(byGuarantee: Readonly<Record<string, Evidence>>, mainCommit: string | null = MAIN): GuaranteeRecords {
  return { kind: "judged", sweep: { id: "sweep-1", mainCommit }, vision: VISION, evidence: { kind: "recorded", byGuarantee: new Map(Object.entries(byGuarantee)) }, revisions: [] };
}

/** The evidence a sweep records: G1 passed on a check its implementer saw, G3 failed, G4 only a review's reading. */
const SWEPT = recorded({
  G1: { checks: [passed("implementer-visible")], reviewLowers: false },
  G2: { checks: [passed("implementer-visible", "c2")], reviewLowers: false },
  G3: { checks: [{ checkId: "c3", outcome: "failed", class: "implementer-visible" }], reviewLowers: false },
  G4: { checks: [passed("review-only", "r4")], reviewLowers: false },
});

/** An infrastructure halt's terminal sweep: no commit of main could be swept, every guarantee's evidence empty. */
const UNSWEPT = recorded(Object.fromEntries(IDS.map((id) => [id, NONE])), null);

/** The table paragraph's line for each guarantee, by id, as many times as it is there. */
function tableIds(body: string): string[] {
  const table = body.split("\n\n").find((part) => part.startsWith("Each guarantee of your contract") || part.startsWith("No check could run on a commit of main"));
  expect(table, body).toBeDefined();
  return (table ?? "").split("\n").flatMap((line) => {
    const id = /^- (G\d+): /.exec(line)?.[1];
    return id === undefined ? [] : [id];
  });
}

function tableLine(body: string, id: string): string {
  const line = body.split("\n").find((each) => each.startsWith(`- ${id}: `) && each.includes(" | verdict: "));
  expect(line, body).toBeDefined();
  return line ?? "";
}

describe("the guarantee table", () => {
  test("every guarantee of the version in force is in the table exactly once, in its order, and among the verdicts exactly once", () => {
    const table = guaranteeTableOf(SWEPT);
    expect(tableIds(guaranteeSection(table))).toEqual(IDS);
    expect(tableVerdicts(table).verdicts.map((v) => v.guaranteeId)).toEqual(IDS);
  });

  test("evidence that misses a guarantee of the version, or names one it does not hold, is refused, never read as no evidence", () => {
    const { G4: _dropped, ...missing } = Object.fromEntries(IDS.map((id) => [id, NONE]));
    expect(() => guaranteeTableOf(recorded(missing))).toThrow(/none for G4/);
    expect(() => guaranteeTableOf(recorded({ ...Object.fromEntries(IDS.map((id) => [id, NONE])), G9: NONE }))).toThrow(/G9, which vision v2 does not hold/);
  });

  test("each verdict follows the evidence: pass on an executed check, fail on a failed one, stored data unjudged, a review's reading never a pass", () => {
    const table = guaranteeTableOf(SWEPT);
    expect(tableVerdicts(table).verdicts.map((v) => [v.guaranteeId, v.verdict, v.reason, v.basis, v.evidenceClass])).toEqual([
      ["G1", "pass", null, "client-stated", "implementer-visible"],
      ["G2", "unjudged", "stored-data-unjudged", "assumed-unconfirmed", "implementer-visible"],
      ["G3", "fail", null, "client-stated", "implementer-visible"],
      ["G4", "unjudged", "review-only", "client-stated", "review-only"],
    ]);
    const body = guaranteeSection(table);
    expect(tableLine(body, "G1")).toBe(
      "- G1: A get returns the value of the last put of its key. | verdict: pass | basis: what your tender states | evidence: checked by a check its implementer could see",
    );
    expect(tableLine(body, "G4")).toContain("| verdict: unjudged, only a review of the checks speaks for it, and a review never makes a guarantee pass |");
    expect(tableLine(body, "G2")).toContain("| basis: an assumption you have not confirmed, so it is at risk |");
  });

  test("review-only evidence never renders pass, whatever its outcome, alone or beside a passing executed check a review lowers", () => {
    for (const evidence of [
      { checks: [passed("review-only")], reviewLowers: false },
      { checks: [passed("review-only"), passed("review-only", "r2")], reviewLowers: false },
      { checks: [passed("implementer-visible"), passed("review-only", "r2")], reviewLowers: true },
      { checks: [passed("witness"), { checkId: "r2", outcome: "failed" as const, class: "review-only" as const }], reviewLowers: false },
    ]) {
      const table = guaranteeTableOf(recorded({ G1: evidence, G2: NONE, G3: NONE, G4: NONE }));
      const [g1] = tableVerdicts(table).verdicts;
      expect(g1?.verdict, JSON.stringify(evidence)).toBe("unjudged");
      expect(tableLine(guaranteeSection(table), "G1")).not.toContain("| verdict: pass |");
    }
  });

  test("the punch list comes first: failures, then every unjudged guarantee with why", () => {
    const table = guaranteeTableOf(
      recorded({
        G1: { checks: [passed("implementer-visible")], reviewLowers: false },
        G2: NONE,
        G3: { checks: [{ checkId: "c3", outcome: "failed", class: "witness" }], reviewLowers: false },
        G4: { checks: [passed("witness")], reviewLowers: true },
      }),
    );
    const [punch] = guaranteeSection(table).split("\n\n");
    expect(punch).toBe(
      [
        "The punch list, what is not shown to hold, failures first:",
        "- G3: fail, a check deciding it failed on this commit",
        "- G2: unjudged, it is about stored data, and the faults that would show stored data surviving them are not run",
        "- G4: unjudged, a review of the checks found they may not decide it",
      ].join("\n"),
    );
  });

  test("the assumptions, exclusions and Basis of Design follow the table, never as verdicts", () => {
    const parts = guaranteeSection(guaranteeTableOf(SWEPT)).split("\n\n");
    expect(parts.slice(2)).toEqual([
      "The assumptions the guarantees rest on:\n- A1: A put is acknowledged once it is on disk. (underpins G2; not confirmed by you)",
      "What is left out, so that silence is never read as a promise:\n- X1: No authentication.",
      "Basis of Design, the team's own design choices, which are not judged here and which your acceptance does not depend on:\n- A2: The log is a single file.",
    ]);
  });

  test("a sweep recorded before evidence per guarantee judges every guarantee on none: a legacy one is not checkable as written", () => {
    const legacy = readVisionVersion({
      projectId,
      version: 1,
      visionText: TENDER,
      summary: "A store.",
      scopeBoundaries: [{ text: "put and get", side: "in" }],
      inferences: [{ key: "A10", statement: "A damaged non-final record is fatal corruption.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "reported" }],
      openQuestions: [],
      contractForm: "scope-lines",
      interface: [],
      guarantees: [],
      exclusions: [],
    });
    const table = guaranteeTableOf({ kind: "judged", sweep: { id: "sweep-0", mainCommit: MAIN }, vision: legacy, evidence: { kind: "unrecorded" }, revisions: [] });
    expect(tableVerdicts(table).verdicts.map((v) => [v.guaranteeId, v.verdict, v.reason])).toEqual([
      ["S1", "unjudged", "not-checkable-as-written"],
      ["A10", "unjudged", "not-checkable-as-written"],
    ]);
    expect(guaranteeSection(table)).toContain("Which checks decided each guarantee is not on record for that sweep, so none is judged as holding.");
  });

  test("a message no sweep is on record for holds every guarantee of the version in force unjudged for want of a sweep on a commit, naming no sweep", () => {
    const table = guaranteeTableOf({ kind: "judged", sweep: null, vision: VISION, evidence: { kind: "unrecorded" }, revisions: [] });
    const verdicts = tableVerdicts(table);
    expect(verdicts.sweepId).toBeNull();
    expect(verdicts.verdicts.map((v) => [v.guaranteeId, v.verdict, v.reason, v.evidenceClass])).toEqual(IDS.map((id) => [id, "unjudged", "no-sweep-on-commit", "none"]));
    const section = guaranteeSection(table);
    expect(section).toContain("No check could run on a commit of main for this report: no sweep of main is on record for it, so each guarantee of your contract (vision v2) is unjudged.");
    expect(section).not.toContain("Which checks decided each guarantee is not on record");
    expect(tableIds(section)).toEqual(IDS);
  });

  test("records that do not read as a table judge no guarantee, say so, and persist no verdict", () => {
    const table: GuaranteeTable = { kind: "unreadable", sweepId: "sweep-4" };
    expect(guaranteeSection(table)).toBe(
      "Ashara's records of this project's guarantees at sweep sweep-4 do not hold together, so no guarantee is judged in this message: none is told as holding, and none as failing. Its operator is told why.",
    );
    expect(tableVerdicts(table)).toEqual({ sweepId: "sweep-4", verdicts: [] });
  });

  test("no vision at the sweep is said so, and persists no verdict", () => {
    const table: GuaranteeTable = guaranteeTableOf({ kind: "no-contract", sweep: { id: "sweep-2", mainCommit: MAIN } });
    expect(guaranteeSection(table)).toBe("No contract is on record for this project at sweep sweep-2, so no guarantee is judged.");
    expect(tableVerdicts(table)).toEqual({ sweepId: "sweep-2", verdicts: [] });
  });
});

type ContractRevision = NonNullable<Extract<GuaranteeRecords, { kind: "judged" }>["revisions"]>[number];

describe("the appendix of the contract's revisions", () => {
  const PRIOR_G3 = "A get of a missing key prints nothing.";
  const PROPOSED_G1 = "A get returns some value that was put for its key.";
  const V1 = readVisionVersion({
    projectId,
    version: 1,
    visionText: TENDER,
    summary: "A store.",
    scopeBoundaries: [],
    inferences: ASSUMPTIONS,
    openQuestions: [{ messageId: "q1", text: "Ack after disk?", assumptionKey: "A1" }],
    contractForm: "guarantees",
    interface: [{ id: "I1", text: "put KEY VALUE, get KEY, delete KEY", source: quote("Clients put and get values.") }],
    guarantees: [...GUARANTEES.slice(0, 2), { ...GUARANTEES[2], statement: PRIOR_G3 }, ...GUARANTEES.slice(3), { ...GUARANTEES[0], id: "G5", statement: "A list prints every key." }],
    exclusions: [{ id: "X1", text: "No authentication.", source: quote("Clients put and get values.") }],
  });
  const op = (action: "amend" | "withdraw", key: string, statement: string | null) =>
    ({ target: "guarantee", action, key, direction: "narrows", labelled: null, read: null, statement }) as const;
  const APPLIED: ContractRevision = {
    status: "applied",
    author: "client",
    direction: "narrows",
    basedOn: V1,
    wrote: VISION,
    ops: [op("amend", "G3", null), op("withdraw", "G5", null)],
  };
  const PROPOSAL: ContractRevision = { status: "proposed", author: "ashara", direction: "narrows", basedOn: VISION, ops: [op("amend", "G1", PROPOSED_G1)] };
  const revised = (revisions: readonly ContractRevision[]): GuaranteeRecords =>
    SWEPT.kind === "judged" ? { ...SWEPT, revisions } : expect.unreachable("the sweep's records are judged");
  const HEAD = "Appendix, how your contract has been revised:";

  test("a proposed Ashara narrowing leaves the prior guarantee in the table and is told only in the appendix", () => {
    const body = guaranteeSection(guaranteeTableOf(revised([PROPOSAL])));
    expect(tableLine(body, "G1")).toContain("- G1: A get returns the value of the last put of its key. | verdict: pass |");
    const head = body.indexOf(HEAD);
    expect(head).toBeGreaterThan(body.indexOf("- G1: A get returns the value"));
    expect(body.slice(0, head)).not.toContain(PROPOSED_G1);
    expect(body.slice(head)).toContain(PROPOSED_G1);
    expect(body.slice(head).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      `- G1 (as it stands: A get returns the value of the last put of its key.) | Ashara proposes to amend it to: ${PROPOSED_G1}`,
    ]);
  });

  test("the narrowings Ashara proposed list only the operations of its proposal that narrow", () => {
    const widening = { ...op("amend", "G2", "A put is acknowledged and kept."), direction: "widens" } as const;
    const neutral = { ...op("amend", "G4", "A deleted key reads as missing."), direction: "neutral" } as const;
    const body = guaranteeSection(guaranteeTableOf(revised([{ ...PROPOSAL, ops: [widening, op("amend", "G1", PROPOSED_G1), neutral] }])));
    const head = body.indexOf(HEAD);
    expect(body.slice(head).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      `- G1 (as it stands: A get returns the value of the last put of its key.) | Ashara proposes to amend it to: ${PROPOSED_G1}`,
    ]);
  });

  test("every guarantee an applied revision superseded is listed with what replaced it, or that nothing did", () => {
    const parts = guaranteeSection(guaranteeTableOf(revised([APPLIED]))).split("\n\n");
    expect(parts.at(-1)).toBe(
      [
        HEAD,
        "Guarantees an earlier version of your contract held, each with what replaced it:",
        `- G3 (vision v1): ${PRIOR_G3} | replaced in vision v2 by your change with G3: A get of a missing key exits 1.`,
        "- G5 (vision v1): A list prints every key. | withdrawn in vision v2 by your change; nothing replaces it",
      ].join("\n"),
    );
  });

  test("a contract with no revision, or none the appendix lists, prints no appendix heading", () => {
    expect(guaranteeSection(guaranteeTableOf(SWEPT))).not.toContain("Appendix");
    const clientProposal: ContractRevision = { ...PROPOSAL, author: "client" };
    const assumptionOnly: ContractRevision = { ...APPLIED, ops: [{ ...op("amend", "A1", "A put is acknowledged at once."), target: "assumption" }] };
    expect(guaranteeSection(guaranteeTableOf(revised([clientProposal, assumptionOnly])))).not.toContain("Appendix");
  });

  test("a revision naming a guarantee its versions do not hold is refused, never read as no change", () => {
    expect(() => guaranteeTableOf(revised([{ ...APPLIED, ops: [op("withdraw", "G9", null)] }]))).toThrow(/G9, which vision v1 does not hold/);
  });
});

describe("every terminal message carries the table", () => {
  test("an infrastructure halt's report holds the table, every guarantee once and unjudged because no check ran on a commit, and posts those verdicts", async () => {
    const posted: Array<{ body: string; verdicts: TableVerdicts | null }> = [];
    const store: BlockReportStore = {
      dueReports: async () => [
        {
          subject: "project-blocked",
          episodeId: "e1",
          projectId,
          kind: "infrastructure",
          cause: { errorClass: "InfrastructureFaultBudgetSpent", reason: "the substrate did not answer", spend: null, work: null },
          guarantees: guaranteeTableOf(UNSWEPT),
        },
      ],
      postProjectReport: async (_episodeId, _on, body, verdicts) => {
        posted.push({ body, verdicts });
        return "posted";
      },
      riskRecords: async () => ({ kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } }),
    };
    await new BlockReports(store, memoryStepContainment(() => true)).runPending();
    expect(posted).toHaveLength(1);
    const [{ body, verdicts } = { body: "", verdicts: null }] = posted;
    expect(body).toContain("the machines Ashara runs the work on kept failing");
    expect(tableIds(body)).toEqual(IDS);
    for (const id of IDS) expect(tableLine(body, id)).toContain("| verdict: unjudged, no check could run on a commit of main for this report |");
    expect(body).toContain("No check could run on a commit of main for this report; why is in Ashara's record of that attempt, sweep sweep-1.");
    expect(verdicts?.verdicts.map((v) => [v.guaranteeId, v.verdict, v.reason, v.evidenceClass])).toEqual(IDS.map((id) => [id, "unjudged", "no-sweep-on-commit", "none"]));
  });

  test("the report of a first planning that stopped holds the table, every guarantee unjudged with no sweep, and posts those verdicts", async () => {
    const posted: Array<{ subject: string; body: string; verdicts: TableVerdicts | null }> = [];
    const store: PlanReportStore = {
      dueReports: async () => [{ subject: "planning-stopped", projectId, attempts: 3 }],
      postReport: async (_projectId, subject, body, _revisionIds, verdicts) => {
        posted.push({ subject, body, verdicts });
        return "posted";
      },
      guaranteesWithoutSweep: async () => guaranteeTableOf({ kind: "judged", sweep: null, vision: VISION, evidence: { kind: "unrecorded" }, revisions: [] }),
      dueRevisionReports: async () => [],
      postRevisionReport: async () => expect.unreachable("no revision is due"),
      blockProject: async () => expect.unreachable("nothing is blocked"),
      riskRecords: async () => ({ kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } }),
    };
    await new PlanReports(store, memoryStepContainment(() => true)).runPending();
    expect(posted.map((each) => each.subject)).toEqual(["planning-stopped"]);
    const [{ body, verdicts } = { body: "", verdicts: null }] = posted;
    expect(body).toContain("Ashara could not turn this project's vision into a plan after 3 attempts");
    expect(tableIds(body)).toEqual(IDS);
    expect(verdicts?.sweepId).toBeNull();
    expect(verdicts?.verdicts.map((v) => [v.guaranteeId, v.verdict, v.reason])).toEqual(IDS.map((id) => [id, "unjudged", "no-sweep-on-commit"]));
  });

  test("a halt that ran no sweep on a commit holds every guarantee unjudged even where evidence is unrecorded", () => {
    const table = guaranteeTableOf({ kind: "judged", sweep: { id: "sweep-3", mainCommit: null }, vision: VISION, evidence: { kind: "unrecorded" }, revisions: [] });
    expect(tableVerdicts(table).verdicts.map((v) => v.reason)).toEqual(IDS.map(() => "no-sweep-on-commit"));
  });

  test("the delivered report holds the table after what was delivered, every guarantee once, and posts its verdicts", async () => {
    const posted: Array<{ body: string; verdicts: TableVerdicts | null }> = [];
    const store: DeliveredReportStore = {
      dueReports: async () => [
        {
          kind: "due",
          failures: 0,
          interfaceReadFailures: 0,
          recordFailures: 0,
          sweepId: "sweep-1",
          projectId,
          mainCommit: MAIN,
          targetProjectPath: "/work/target",
          goals: [{ title: "Store keys", close: { kind: "merged", commit: MAIN } }],
          checked: ["Store keys"],
          unchecked: [],
          givenUp: [],
          executed: { kind: "recorded", checks: [] },
          guarantees: guaranteeTableOf(SWEPT),
          reading: { kind: "not-needed" },
        },
      ],
      guaranteeTable: async () => expect.unreachable("the report carries the table it was listed with"),
      postReport: async (_sweepId, body, verdicts) => {
        posted.push({ body, verdicts });
        return "posted";
      },
      recordReportFailure: async () => expect.unreachable("no report failed"),
    };
    await new DeliveredReports(store, { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) }).runPending();
    const [{ body, verdicts } = { body: "", verdicts: null }] = posted;
    expect(tableIds(body)).toEqual(IDS);
    expect(body.indexOf("What was delivered:")).toBeLessThan(body.indexOf("The punch list"));
    expect(verdicts).toEqual(tableVerdicts(guaranteeTableOf(SWEPT)));
    expect(body).not.toContain("second review");
  });
});
