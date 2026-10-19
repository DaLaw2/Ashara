import type { BurnZone } from "@ashara/finance";
import type { ProjectId } from "@ashara/shared";
import type { VisionVersion } from "./vision.js";

// The early-warning register: the guarantees of the vision in force that the records show at risk,
// reissued whole on every progress report so the client hears of a risk while it can still be acted
// on. It informs and never gates: nothing that admits dispatch reads it.

/** What the records hold of the work on the vision's guarantees, as one project stands now. */
interface RiskStanding {
  /**
   * The plan's tasks that deliver what the client asked for, none superseded by a revision: whether
   * each is done, and the ids of the vision items it cites.
   */
  readonly tasks: ReadonlyArray<{ readonly done: boolean; readonly cites: readonly string[] }>;
  /** The ids of the vision items a stored check of a task no revision superseded decides. */
  readonly decided: readonly string[];
  /** The highest burn zone reported for the current plan revision; null when none is. */
  readonly burnZone: BurnZone | null;
}

/** The register's inputs as the records give them for one project. */
export type RiskRecords =
  | { readonly kind: "read"; readonly version: Pick<VisionVersion, "guarantees" | "assumptions">; readonly standing: RiskStanding }
  /** No vision version is recorded: no contract has been drafted, so no guarantee exists to be at risk. */
  | { readonly kind: "no-vision" }
  /** A record the register reads does not parse; `detail` names it, for the operator's log. */
  | { readonly kind: "unreadable"; readonly detail: string };

/** The port every progress report's store offers so the report can reissue the register. */
export interface RiskRecordReader {
  riskRecords(projectId: ProjectId): Promise<RiskRecords>;
}

/** Why a guarantee is at risk; each is one row of the design's register. */
type Risk =
  /** It rests on assumptions the client has not confirmed, and work citing it or them is not done. */
  | { readonly kind: "unconfirmed-assumption"; readonly assumptions: readonly string[] }
  /** Work citing it is done, and no stored check decides it. */
  | { readonly kind: "done-unchecked" }
  /** It is observed in stored data, which Ashara injects no fault into, so it reads unjudged at best. */
  | { readonly kind: "stored-data" }
  /** Its work is not done, and the project's requests have drawn past the budget forecast. */
  | { readonly kind: "burn"; readonly zone: BurnZone };

interface RegisterRow {
  readonly id: string;
  readonly statement: string;
  readonly risks: readonly [Risk, ...Risk[]];
}

type Register =
  | { readonly kind: "rows"; readonly rows: readonly RegisterRow[] }
  | { readonly kind: "no-vision" }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * The assumptions a guarantee rests on that the client has not Stated: the one it is sourced from
 * and every one that underpins it. A source assumption absent from the version is not evidence of
 * confirmation, so it is named too.
 */
function unconfirmedFooting(guarantee: VisionVersion["guarantees"][number], assumptions: VisionVersion["assumptions"]): string[] {
  const sourceId =
    guarantee.source.kind === "assumption" || (guarantee.source.kind === "legacy" && guarantee.source.from === "assumption") ? guarantee.source.id : null;
  const resting = assumptions.filter((a) => (a.id === sourceId || a.underpins.includes(guarantee.id)) && a.status !== "Stated").map((a) => a.id);
  const sourceMissing = sourceId !== null && !assumptions.some((a) => a.id === sourceId);
  return sourceMissing && sourceId !== null ? [sourceId, ...resting] : resting;
}

/** The guarantees at risk in the vision version given, each with every reason the records show. */
export function registerOf(records: RiskRecords): Register {
  if (records.kind !== "read") return records;
  const { version, standing } = records;
  const decided = new Set(standing.decided);
  const rows: RegisterRow[] = [];
  for (const guarantee of version.guarantees) {
    const footing = guarantee.basis === "assumed-unconfirmed" ? unconfirmedFooting(guarantee, version.assumptions) : [];
    const citing = standing.tasks.filter((task) => task.cites.includes(guarantee.id));
    const resting = standing.tasks.filter((task) => task.cites.some((id) => id === guarantee.id || footing.includes(id)));
    const risks: Risk[] = [];
    if (footing.length > 0 && resting.some((task) => !task.done)) risks.push({ kind: "unconfirmed-assumption", assumptions: footing });
    if (citing.some((task) => task.done) && !decided.has(guarantee.id)) risks.push({ kind: "done-unchecked" });
    if (guarantee.observation === "stored-data") risks.push({ kind: "stored-data" });
    if (standing.burnZone !== null && citing.some((task) => !task.done)) risks.push({ kind: "burn", zone: standing.burnZone });
    const [first, ...rest] = risks;
    if (first !== undefined) rows.push({ id: guarantee.id, statement: guarantee.statement, risks: [first, ...rest] });
  }
  return { kind: "rows", rows };
}

const NO_RISK_LINE = "No guarantee is at risk on the records.";

function riskWords(risk: Risk): string {
  switch (risk.kind) {
    case "unconfirmed-assumption":
      return `it rests on ${risk.assumptions.length === 1 ? "assumption" : "assumptions"} ${risk.assumptions.join(", ")}, which you have not confirmed, and work on it is not finished`;
    case "done-unchecked":
      return "work on it is finished, but no stored check decides it yet";
    case "stored-data":
      return "it is seen in the data you store, which Ashara cannot yet break on purpose to test, so it cannot be shown to hold";
    case "burn":
      return risk.zone === "red"
        ? "its work is not finished, and most of the model requests this project's work may use are spent"
        : "its work is not finished, and this project has used more of its budget than its finished work accounts for";
  }
}

/**
 * The register as the paragraph every progress report ends with; never empty. A register whose
 * records do not read says so, never that nothing is at risk, and the detail goes to the log.
 */
export function registerParagraph(projectId: ProjectId, register: Register): string {
  switch (register.kind) {
    case "no-vision":
      return "No contract has been drafted for this project yet, so no guarantee is on record to be at risk.";
    case "unreadable":
      console.warn(`[early-warning] project ${projectId}: the register of guarantees at risk does not read: ${register.detail}`);
      return "Which guarantees are at risk cannot be told from Ashara's records for this report; Ashara keeps the record that does not read for its operator.";
    case "rows":
      if (register.rows.length === 0) return NO_RISK_LINE;
      return (
        `Guarantees at risk, as Ashara's records stand now:\n` +
        register.rows.map((row) => `- ${row.id} (${row.statement}): ${row.risks.map(riskWords).join("; ")}.`).join("\n")
      );
  }
}
