import { TERMINAL_KINDS, VisionChangeRefused, VisionUnreadable, plannedBehaviourKeys, readVisionVersion, recordPlannedBehaviour, restartClientReadings } from "@ashara/engagement";
import type { StoredVision, VisionVersion } from "@ashara/engagement";
import type { AssignmentVision } from "@ashara/workplace";
import { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL } from "./engagement-vision-acl.js";
import type { InterfaceEntry, VisionGuarantee } from "./engagement-vision-acl.js";
import type { VisionItem } from "../decomposition-types.js";

/**
 * Anti-Corruption Layer: Engagement.
 *
 * With engagement-vision-acl.ts (Engagement's vision language alone) and engagement-predicates-acl.ts
 * (Engagement's published predicates alone), the only file in @ashara/delivery that imports from
 * @ashara/engagement.
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
  ClientChangeOutcome,
  IntakeOutcome,
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonBurnWarnings,
  LiaisonClientChanges,
  LiaisonClientReceipts,
  LiaisonClientStops,
  LiaisonTerminalReports,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
  TaskQuestion,
  TaskQuestionPosting,
  TerminalKind,
} from "@ashara/engagement";

// A client correction applied to a project, as Engagement hands it to Delivery's hold in the
// correction's own transaction (Engagement's port HoldCorrection).
export type { AppliedCorrection } from "@ashara/engagement/ports";

// The kinds of terminal message the loop asks the Liaison to tell, each where it can become due.
export { TERMINAL_KINDS };

// The behaviour a plan adds beyond what the contract states is recorded on it, in the plan's own
// transaction, as Engagement's Inferred assumptions under the keys plannedBehaviourKeys gave the plan.
export { VisionChangeRefused, VisionUnreadable, recordPlannedBehaviour, restartClientReadings };
export type { StoredVision };

/** The stored vision read as planning input, before any counted attempt. */
export interface PlanningVision {
  readonly version: number;
  /** The client's tender, verbatim. */
  readonly visionText: string;
  readonly northStar: string;
  readonly items: VisionItem[];
  /** The product's public interface as the vision states it, each entry by its key; empty on a version that recorded none. */
  readonly interface: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  /**
   * The keys behaviour a plan adds would take on the contract when recorded on this version, in
   * order; throws VisionChangeRefused for a version whose assumptions are not keyed.
   */
  readonly assumptionKeys: (count: number) => readonly string[];
}

/**
 * The north star decomposition plans toward: the vision's summary, its guarantees and exclusions, the
 * client's answers and the assumptions work proceeds on. The decomposition prompt itself stays in
 * DecompositionEngine; this is only its input.
 */
function northStarOf(vision: VisionVersion): string {
  const answers = vision.assumptions.flatMap((a) =>
    a.status === "Stated" && a.clientAnswer !== null ? [{ ...a.clientAnswer, decision: a.statement }] : [],
  );
  const assumptions = vision.assumptions.flatMap((a) =>
    a.status === "Stated" ? [] : [a.status === null ? a.statement : `${a.statement} (${a.status})`],
  );
  const sections = [vision.summary];
  if (vision.interface.length > 0) sections.push(`Interface:\n${vision.interface.map((entry) => `- ${entry.id}: ${entry.text}`).join("\n")}`);
  if (vision.guarantees.length > 0) sections.push(`Guarantees:\n${vision.guarantees.map((g) => `- ${g.id}: ${g.statement}`).join("\n")}`);
  if (vision.exclusions.length > 0) sections.push(`Exclusions:\n${vision.exclusions.map((x) => `- ${x.id}: ${x.text}`).join("\n")}`);
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
 * Every item of the vision a planned task can trace to: each guarantee, by its key, with where it is
 * observed and what would refute it, then each assumption work proceeds on, by its key, a Stated one
 * by the decision the client's answer made, each with its status, standing with the client and kind.
 * A version written before guarantees reads each assumption a client could observe as a guarantee
 * under the assumption's own key, so that one item stands for it, a guarantee every plan must cite.
 * The summary is not an item: it restates the whole tender, so a task tracing to it would trace to
 * nothing in particular.
 */
function visionItemsOf(vision: VisionVersion): VisionItem[] {
  const guaranteeIds = new Set(vision.guarantees.map((g) => g.id));
  return [
    ...vision.guarantees.map((g: VisionGuarantee): VisionItem => ({
      type: "guarantee",
      id: g.id,
      text: g.statement,
      observation: g.observation,
      interface: [...g.interface],
      refutedBy: [...g.refutedBy],
    })),
    ...vision.assumptions.filter((a) => !guaranteeIds.has(a.id)).map((a): VisionItem => ({
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
  return {
    version: vision.version,
    visionText: vision.visionText,
    northStar: northStarOf(vision),
    items: visionItemsOf(vision),
    interface: vision.interface.map((entry: InterfaceEntry) => ({ id: entry.id, text: entry.text })),
    assumptionKeys: (count) => plannedBehaviourKeys(stored, count),
  };
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

/**
 * The vision rendered for the Assignment, in Delivery's words: each assumption by its key, its statement, and a note
 * of what the record says of it (its standing with the client and its kind), so Workplace renders
 * text and knows no Engagement vocabulary. Throws VisionUnreadable, and AssumptionUnkeyed for an
 * assumption keyed only by its place.
 */
export function assignmentIntentOf(stored: StoredVision): AssignmentVision {
  const vision = readVisionVersion(stored);
  return {
    version: vision.version,
    visionText: vision.visionText,
    assumptions: vision.assumptions.map((a) => {
      if (!a.keyed) throw new AssumptionUnkeyed(vision.projectId, vision.version, a.id);
      return { key: a.id, statement: a.statement, note: `${ASSUMPTION_STANDING_LABEL[a.standing]}; ${ASSUMPTION_KIND_LABEL[a.kind]}` };
    }),
    // The entries as planning reads them (planningVisionOf), so the keys a blocked finish names are the ones tasks cite.
    interfaceEntries: vision.interface.map((entry: InterfaceEntry) => ({ key: entry.id, text: entry.text })),
  };
}
