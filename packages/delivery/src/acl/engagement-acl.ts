import { VisionUnreadable, readVisionVersion } from "@ashara/engagement";
import type { StoredVision, VisionVersion } from "@ashara/engagement";
import type { AgentBrief } from "@ashara/workplace";
import { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL } from "./engagement-vision-acl.js";
import type { ScopeSide } from "./engagement-vision-acl.js";
import type { VisionItem } from "../decomposition-types.js";

/**
 * Anti-Corruption Layer: Engagement.
 *
 * With engagement-vision-acl.ts (Engagement's vision language alone), the only file in @ashara/delivery that
 * imports from @ashara/engagement.
 * Delivery talks to the client only through Engagement: the loop asks the
 * Liaison to act on the client's stops, to answer the client's changes, to take in pending tenders, to read the
 * client's answers into the vision, to report
 * recorded planning outcomes to the client, and to record the stack a merged
 * Sprint 0 task chose as an assumption in the vision and report it, and to
 * report each project halt and resumption and each delivered project, to warn the client when a
 * project's model requests run ahead of its finished work, and reads back what happened.
 * Delivery reads the client's vision only as Engagement's published VisionVersion, and turns it
 * into its own planning input and into the neutral items an Assignment carries, so no other context
 * reads Engagement's vocabulary.
 */

export type {
  AnswerOutcome,
  IntakeOutcome,
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonBurnWarnings,
  LiaisonClientChanges,
  LiaisonClientStops,
  LiaisonDeliveredReports,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
} from "@ashara/engagement";

export { VisionUnreadable };
export type { StoredVision };

/** The stored vision read as planning input, before any counted attempt. */
export interface PlanningVision {
  readonly version: number;
  /** The client's tender, verbatim. */
  readonly visionText: string;
  readonly northStar: string;
  readonly items: VisionItem[];
}

const SCOPE_SIDE_LEAD: Readonly<Record<ScopeSide, string>> = { in: "In scope: ", out: "Out of scope: ", unclassified: "" };

/**
 * The north star decomposition plans toward: the vision's summary, its scope, the client's answers
 * and the assumptions work proceeds on. The decomposition prompt itself stays in DecompositionEngine;
 * this is only its input.
 */
function northStarOf(vision: VisionVersion): string {
  const answers = vision.assumptions.flatMap((a) =>
    a.status === "Stated" && a.clientAnswer !== null ? [{ ...a.clientAnswer, decision: a.statement }] : [],
  );
  const assumptions = vision.assumptions.flatMap((a) =>
    a.status === "Stated" ? [] : [a.status === null ? a.statement : `${a.statement} (${a.status})`],
  );
  const sections = [vision.summary];
  if (vision.scope.length > 0) sections.push(`Scope:\n${vision.scope.map((s) => `- ${SCOPE_SIDE_LEAD[s.side]}${s.text}`).join("\n")}`);
  if (answers.length > 0) {
    sections.push(
      `Client clarifications (Stated by the client; these override any assumption):\n` +
        answers.map((a) => `- ${a.question} -> ${a.answer} (decision: ${a.decision})`).join("\n"),
    );
  }
  if (assumptions.length > 0) {
    sections.push(`Assumptions work proceeds on until the client says otherwise:\n${assumptions.map((a) => `- ${a}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Every item of the vision a planned task can trace to: each scope
 * boundary (S<n>), then each assumption work proceeds on, by its key in the vision, a Stated one by
 * the decision the client's answer made, each with its status, standing with the client and kind.
 * The summary is not an item: it restates the whole tender, so a task tracing to it would trace to
 * nothing in particular.
 */
function visionItemsOf(vision: VisionVersion): VisionItem[] {
  return [
    ...vision.scope.map((line, i): VisionItem => ({ type: "scope", id: `S${i + 1}`, text: line.text, side: line.side })),
    ...vision.assumptions.map((a): VisionItem => ({
      type: "assumption",
      id: a.id,
      text: a.statement,
      status: a.status ?? "Inferred",
      standing: a.standing,
      kind: a.kind,
    })),
  ];
}

/** The stored vision as planning input; throws VisionUnreadable, the project's own record. */
export function planningVisionOf(stored: StoredVision): PlanningVision {
  const vision = readVisionVersion(stored);
  return { version: vision.version, visionText: vision.visionText, northStar: northStarOf(vision), items: visionItemsOf(vision) };
}

/** A change the client's answer made: their question, their words and what work now proceeds on. */
interface StatedChange {
  readonly question: string;
  readonly answer: string;
  readonly decision: string;
}

/** The change the answer `answerId` made, as a Stated assumption of the vision carries it; null when none does. */
export function statedChangeOf(stored: StoredVision, answerId: string): StatedChange | null {
  const stated = readVisionVersion(stored).assumptions.find((a) => a.status === "Stated" && a.clientAnswer?.messageId === answerId);
  if (stated === undefined || stated.clientAnswer === null) return null;
  return { question: stated.clientAnswer.question, answer: stated.clientAnswer.answer, decision: stated.statement };
}

/** An assumption the vision holds without a key of its own: a worker could not be told which one it may not contradict. */
class AssumptionUnkeyed extends Error {
  constructor(
    readonly projectId: string,
    readonly visionVersion: number,
    readonly assumptionId: string,
  ) {
    super(
      `project ${projectId} vision v${visionVersion}: assumption ${assumptionId} holds no key of its own; ` +
        `an Assignment names every assumption by the key the vision records`,
    );
    this.name = "AssumptionUnkeyed";
  }
}

/** The project's vision as an Assignment carries it: the client's text and every assumption, by key, in neutral words. */
interface AssignmentIntent {
  readonly version: number;
  readonly visionText: string;
  readonly assumptions: AgentBrief["assumptions"];
}

/**
 * The vision rendered for the Assignment, in Delivery's words: each assumption by its key, its statement, and a note
 * of what the record says of it (its standing with the client and its kind), so Workplace renders
 * text and knows no Engagement vocabulary. Throws VisionUnreadable, and AssumptionUnkeyed for an
 * assumption keyed only by its place.
 */
export function assignmentIntentOf(stored: StoredVision): AssignmentIntent {
  const vision = readVisionVersion(stored);
  return {
    version: vision.version,
    visionText: vision.visionText,
    assumptions: vision.assumptions.map((a) => {
      if (!a.keyed) throw new AssumptionUnkeyed(vision.projectId, vision.version, a.id);
      return { key: a.id, statement: a.statement, note: `${ASSUMPTION_STANDING_LABEL[a.standing]}; ${ASSUMPTION_KIND_LABEL[a.kind]}` };
    }),
  };
}
