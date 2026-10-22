import { describe, expect, test, vi } from "vitest";
import { DEFAULT_WORK_BUDGETS } from "@ashara/finance";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { BlockReports } from "./block-report.js";
import { BurnWarnings } from "./burn-warning.js";
import { registerOf, registerParagraph } from "./early-warning.js";
import type { RiskRecords } from "./early-warning.js";
import { PlanReports } from "./plan-report.js";
import { basisOf } from "./vision-language/guarantee.js";
import type { VisionAssumption, VisionVersion } from "./vision.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000040", "test");

type RiskStanding = Extract<RiskRecords, { readonly kind: "read" }>["standing"];

const NO_RISK = "No guarantee is at risk on the records.";

function assumption(status: "Inferred" | "Stated"): VisionAssumption {
  return {
    id: "A1",
    keyed: true,
    statement: "Keys are case-sensitive.",
    status,
    kind: "client-visible",
    disclosed: status === "Inferred" ? "reported" : null,
    standing: status === "Inferred" ? "reported" : "stated",
    clientAnswer: null,
    underpins: ["G2"],
  };
}

/** G1 rests on the tender alone; G2 rests on A1 as well. */
function versionWith(a1: VisionAssumption): Pick<VisionVersion, "guarantees" | "assumptions"> {
  const guarantee = (id: string, statement: string) => {
    const source = { kind: "tender", quote: statement } as const;
    return { id, statement, interface: ["I1"], observation: "output", refutedBy: ["a lookup returns another value"], verification: "by-ashara", source, basis: basisOf({ id, source }, [a1]) } as const;
  };
  return { guarantees: [guarantee("G1", "A stored value is read back."), guarantee("G2", "Keys differing in case are distinct.")], assumptions: [a1] };
}

const read = (version: Pick<VisionVersion, "guarantees" | "assumptions">, standing: RiskStanding): RiskRecords => ({ kind: "read", version, standing });

const EMPTY: RiskRecords = read({ guarantees: [], assumptions: [] }, { tasks: [], decided: [], burnZone: null });

describe("registerOf", () => {
  test("lists the guarantee an Inferred assumption underpins while a task citing it is in progress, naming the assumption", () => {
    const standing = { tasks: [{ done: false, cites: ["G1", "G2"] }], decided: [], burnZone: null };

    const register = registerOf(read(versionWith(assumption("Inferred")), standing));

    expect(register).toEqual({
      kind: "rows",
      rows: [{ id: "G2", statement: "Keys differing in case are distinct.", risks: [{ kind: "unconfirmed-assumption", assumptions: ["A1"] }] }],
      verifiable: 2,
      total: 2,
      declined: false,
    });
    expect(registerParagraph(projectId, register)).toBe(
      "Guarantees at risk, as Ashara's records stand now:\n" +
        "- G2 (Keys differing in case are distinct.): it rests on assumption A1, which you have not confirmed, and work on it is not finished.\n" +
        "Ashara can verify 2 of the 2 guarantees of this contract with the checks it can run today.",
    );
  });

  test("lists nothing once the client has Stated the assumption", () => {
    const standing = { tasks: [{ done: false, cites: ["G2"] }], decided: [], burnZone: null };
    expect(registerOf(read(versionWith(assumption("Stated")), standing))).toEqual({ kind: "rows", rows: [], verifiable: 2, total: 2, declined: false });
  });

  test("lists a guarantee whose work is done with no stored check deciding it, and one past the burn forecast", () => {
    const standing = { tasks: [{ done: true, cites: ["G1"] }, { done: false, cites: ["G2"] }], decided: [], burnZone: "red" } as const;

    const register = registerOf(read(versionWith(assumption("Stated")), standing));

    expect(register).toEqual({
      kind: "rows",
      rows: [
        { id: "G1", statement: "A stored value is read back.", risks: [{ kind: "done-unchecked" }] },
        { id: "G2", statement: "Keys differing in case are distinct.", risks: [{ kind: "burn", zone: "red" }] },
      ],
      verifiable: 2,
      total: 2,
      declined: false,
    });
    expect(registerOf(read(versionWith(assumption("Stated")), { ...standing, decided: ["G1"], burnZone: null }))).toEqual({ kind: "rows", rows: [], verifiable: 2, total: 2, declined: false });
  });

  test("names a guarantee its drafter could not place apart from one about stored data, and counts the guarantees Ashara can verify", () => {
    const base = versionWith(assumption("Stated"));
    const [g1, g2] = base.guarantees;
    if (g1 === undefined || g2 === undefined) throw new Error("versionWith holds two guarantees");
    const version = {
      ...base,
      guarantees: [
        { ...g1, observation: "unclassified", verification: "undecided" },
        { ...g2, observation: "stored-data", verification: "not-by-ashara", unverifiableBecause: "outside-interface" },
      ],
    } as const;

    const register = registerOf(read(version, { tasks: [], decided: [], burnZone: null }));

    expect(register).toMatchObject({ verifiable: 0, total: 2, declined: true });
    const paragraph = registerParagraph(projectId, register);
    // A version Ashara declines: the register, which every report posted while it is in force ends with, says so.
    expect(paragraph).toMatch(/Ashara cannot verify any guarantee of this contract as written[^]*confirming it as written does not start it\.$/);
    expect(registerParagraph(projectId, registerOf(read(versionWith(assumption("Stated")), { tasks: [], decided: [], burnZone: null })))).not.toContain(
      "Ashara cannot verify any guarantee",
    );
    expect(paragraph).toContain("- G1 (A stored value is read back.): Ashara could not tell where you would see it hold or break");
    expect(paragraph).toContain("- G2 (Keys differing in case are distinct.): it is seen only outside what the product's interface shows");
    expect(paragraph).not.toContain("- G1 (A stored value is read back.): it is seen only outside");
    expect(paragraph).toContain("Ashara can verify 0 of the 2 guarantees of this contract with the checks it can run today.");
  });

  test("never reads a missing or unreadable record as no risk", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noVision = registerParagraph(projectId, registerOf({ kind: "no-vision" }));
    const unreadable = registerParagraph(projectId, registerOf({ kind: "unreadable", detail: "vision v1 does not parse" }));
    expect([noVision, unreadable]).not.toContain(NO_RISK);
    expect(unreadable).not.toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vision v1 does not parse"));
    warn.mockRestore();
  });
});

describe("every progress report reissues the register", () => {
  test("a plan report with no risk ends with the no-risk line", async () => {
    const posted: string[] = [];
    const tasks = { decomposition: 1, sprint0: 1, scaffolds: 1, checks: 1, reviews: 1, unrecorded: 0, started: 0 };
    const reports = new PlanReports(
      {
        dueReports: async () => [{ subject: "first-plan", projectId, epicTitles: ["Store"], tasks, droppedOrderingHints: { kind: "recorded", count: 0 }, revisions: [] }],
        postReport: async (_projectId, _subject, body) => {
          posted.push(body);
          return "posted";
        },
        guaranteesWithoutSweep: async () => expect.unreachable("no planning-stopped report is due"),
        dueRevisionReports: async () => [],
        postRevisionReport: async () => "posted",
        blockProject: async () => "blocked",
        riskRecords: async () => EMPTY,
      },
      memoryStepContainment(() => true),
    );

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.split("\n\n").at(-1)).toBe(NO_RISK);
  });

  test("a burn warning with no risk ends with the no-risk line", async () => {
    const posted: string[] = [];
    const warnings = new BurnWarnings(
      {
        projectBurns: async () => [{ projectId, planRevision: 1, drawnRequests: 225, grantedRequests: 0, plannedTasks: 4, completedTasks: 1, reported: [] }],
        postWarning: async (warning) => {
          posted.push(warning.body);
          return "posted";
        },
        riskRecords: async () => EMPTY,
      },
      DEFAULT_WORK_BUDGETS,
      memoryStepContainment(() => false),
    );

    await warnings.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.split("\n\n").at(-1)).toBe(NO_RISK);
  });

  test("a block report with no risk ends with the no-risk line", async () => {
    const posted: string[] = [];
    const reports = new BlockReports(
      {
        dueReports: async () => [{ subject: "project-resumed", episodeId: "e1", projectId, how: "unblocked" }],
        postProjectReport: async (_episodeId, _on, body) => {
          posted.push(body);
          return "posted";
        },
        riskRecords: async () => EMPTY,
      },
      memoryStepContainment(() => true),
    );

    await reports.runPending();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.split("\n\n").at(-1)).toBe(NO_RISK);
  });

  test("a burn warning counts its own zone toward the register before the zone is recorded", async () => {
    const posted: string[] = [];
    const standing = { tasks: [{ done: false, cites: ["G1"] }], decided: [], burnZone: null };
    const warnings = new BurnWarnings(
      {
        projectBurns: async () => [{ projectId, planRevision: 1, drawnRequests: 225, grantedRequests: 0, plannedTasks: 4, completedTasks: 1, reported: [] }],
        postWarning: async (warning) => {
          posted.push(warning.body);
          return "posted";
        },
        riskRecords: async () => read(versionWith(assumption("Stated")), standing),
      },
      DEFAULT_WORK_BUDGETS,
      memoryStepContainment(() => false),
    );

    await warnings.runPending();

    expect(posted[0]).toContain("- G1 (A stored value is read back.): its work is not finished, and this project has used more of its budget");
  });
});
