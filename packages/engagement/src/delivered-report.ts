import type { ProjectId } from "@ashara/shared";
import type { AcceptedAssumptionStanding } from "./vision-language/vision-assumption.js";
import type { VisionSource } from "./vision-language/vision-source.js";

// The Liaison's delivered report (story s-independent-verify-m1 W7, design §2.8; eighth run E3):
// once a project is accepted on its sweep of main, the client is told, once, what was delivered:
// each goal task and how its record says it closed, and which items of what they asked for no
// stored check covers. Every sentence is rendered from a record (past-designs sweep #1): a close
// whose kind was not recorded is said to be so, and "not checked" is stated as not checked, never
// folded into "delivered" or into what passed: the opening claims only the run that happened.

/** How a goal task's record says it closed. */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /** Its checks passed on main at `commit` with nothing of its own merged; `by` is the task whose merge made that commit. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  | { readonly kind: "no-record" };

/**
 * An item of the vision the plan was reviewed against: a scope line, or an assumption with where it
 * stood with the client at acceptance (d95 a), never as the plan's copy of the vision recorded it.
 */
type AcceptedVisionItem =
  | Extract<VisionSource, { readonly type: "scope" }>
  | {
      readonly type: "assumption";
      readonly id: string;
      readonly text: string;
      readonly kind: Extract<VisionSource, { readonly type: "assumption" }>["kind"];
      readonly standing: AcceptedAssumptionStanding;
    };

/**
 * Every item of the vision the plan was reviewed against, each with whether an acceptance line of a
 * check task whose stored checks the sweep ran cites it; or none recorded.
 */
type VisionCoverage =
  | { readonly kind: "recorded"; readonly items: ReadonlyArray<{ readonly source: AcceptedVisionItem; readonly checked: boolean }> }
  | { readonly kind: "unrecorded" };

/** An accepted project whose delivered report the client has not been sent. */
interface DueDeliveredReport {
  readonly sweepId: string;
  readonly projectId: ProjectId;
  /** The commit on main the acceptance sweep passed on. */
  readonly mainCommit: string;
  readonly goals: ReadonlyArray<{ readonly title: string; readonly close: GoalClose }>;
  /** The completed tasks whose stored checks the sweep ran, by title. */
  readonly checked: readonly string[];
  /** The completed tasks with no stored check, by title: nothing of theirs ran in the sweep. */
  readonly unchecked: readonly string[];
  /** Goal tasks given up, which the plan was repaired around, by title. */
  readonly givenUp: readonly string[];
  readonly vision: VisionCoverage;
}

/** Engagement's persistence port for delivered reports. */
export interface DeliveredReportStore {
  dueReports(): Promise<readonly DueDeliveredReport[]>;
  /** Posts the report on the accepted sweep unless one is posted. */
  postReport(sweepId: string, body: string): Promise<"posted" | "already-posted">;
}

interface DeliveredReportOutcome {
  readonly kind: "posted" | "already-posted";
  readonly projectId: ProjectId;
}

/** What the core loop asks of the Liaison each cycle (no LLM call). */
export interface LiaisonDeliveredReports {
  runPending(): Promise<readonly DeliveredReportOutcome[]>;
}

function closeLine(title: string, close: GoalClose): string {
  switch (close.kind) {
    case "merged":
      return `- "${title}": built and merged, commit ${close.commit}.`;
    case "already-delivered":
      return (
        `- "${title}": already delivered when its turn came; nothing of its own was merged. Its checks, and every ` +
        `check of the work before it, passed on commit ${close.commit}` +
        (close.by === null ? ", which no task's merge is recorded as making." : `, the merge of "${close.by}".`)
      );
    case "unrecorded-kind":
      return `- "${title}": closed on commit ${close.commit}; whether it was merged or already delivered there is not on record.`;
    case "no-record":
      return `- "${title}": closed with no commit on record.`;
  }
}

/**
 * Whether the item is part of what the client asked for (W11c D3): a line the vision records as out
 * of scope is not, nor is an assumption recorded as the team's own design choice, which the client
 * was told their acceptance does not depend on. Everything else is, an unclassified one included.
 */
function askedFor(source: AcceptedVisionItem): boolean {
  return source.type === "scope" ? source.side !== "out" : source.kind !== "internal-design";
}

type StatedStanding = Extract<AcceptedAssumptionStanding, "stated" | "confirmed" | "changed">;

/** What the client's answer made of a Stated assumption, as its record says, in the client's words. */
const STATED_BY_CLIENT: Readonly<Record<StatedStanding, string>> = {
  stated: "your answer",
  confirmed: "you confirmed this when asked",
  changed: "your answer, which changed what we had assumed",
};

/** How the client saw an Inferred assumption at acceptance, as the records say, in the client's words. */
const SEEN_BY_CLIENT: Readonly<Record<Exclude<AcceptedAssumptionStanding, StatedStanding>, string>> = {
  asked: "which you were asked about and have not answered",
  answered: "which you were asked about; your reply neither confirmed nor changed it",
  "answer-unread": "which you were asked about; your reply had not been read when the project was accepted",
  reported: "which was reported to you",
  "not-shown": "which was never shown to you",
};

function isStated(standing: AcceptedAssumptionStanding): standing is StatedStanding {
  return standing === "stated" || standing === "confirmed" || standing === "changed";
}

function coverageLine(source: AcceptedVisionItem): string {
  if (source.type === "scope") {
    return source.side === "unclassified"
      ? `- ${source.text} (recorded without saying whether it is in or out of scope)`
      : `- ${source.text}`;
  }
  const unclassified = source.kind === "unclassified" ? " (not recorded as what you see or as how it is built)" : "";
  if (isStated(source.standing)) return `- ${source.text} (${STATED_BY_CLIENT[source.standing]})${unclassified}`;
  return `- Ashara's assumption, ${SEEN_BY_CLIENT[source.standing]}: ${source.text}${unclassified}`;
}

function coverageSection(vision: VisionCoverage): string {
  if (vision.kind === "unrecorded") {
    return "Which parts of what you asked for the checks cover is not on record for this plan, so none of it is stated as checked.";
  }
  const asked = vision.items.filter((item) => askedFor(item.source));
  if (asked.length === 0) return "The plan's record holds no item of what you asked for, so none of it is stated as checked.";
  const uncovered = asked.filter((item) => !item.checked);
  if (uncovered.length === 0) {
    return "Every item of what you asked for is named by an acceptance criterion of a task whose stored checks passed on main.";
  }
  return [
    `These items of what you asked for are named by no acceptance criterion of a task whose stored checks passed on ` +
      `main, so nothing confirms them either way:`,
    ...uncovered.map((item) => coverageLine(item.source)),
  ].join("\n");
}

/** What ran on main, and only that: the environment's test and the stored checks of the tasks named. */
function opening(due: DueDeliveredReport): string {
  const ran =
    due.checked.length === 0
      ? `the environment's test passed on main, commit ${due.mainCommit}; no stored check of any task ran with it`
      : `the environment's test and the stored checks of ${plural(due.checked.length, "completed task")} passed together on main, commit ${due.mainCommit}`;
  return `Your project is delivered. Every task of the plan is settled, and ${ran}.`;
}

/** Completed tasks with no stored check: done, but nothing confirmed them, kept apart from what passed. */
function uncheckedSection(unchecked: readonly string[]): string[] {
  if (unchecked.length === 0) return [];
  return [
    [
      `These tasks are done but not checked by a stored check: none was written for them, so nothing in the run above confirms them:`,
      ...unchecked.map((title) => `- "${title}"`),
    ].join("\n"),
  ];
}

function givenUpSection(givenUp: readonly string[]): string[] {
  if (givenUp.length === 0) return [];
  return [[`These tasks were given up, and the plan was revised around them:`, ...givenUp.map((title) => `- "${title}"`)].join("\n")];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The client's delivered report, every line from the records. */
function deliveredReport(due: DueDeliveredReport): string {
  return [
    opening(due),
    `What was delivered:\n${due.goals.map((goal) => closeLine(goal.title, goal.close)).join("\n")}`,
    ...uncheckedSection(due.unchecked),
    ...givenUpSection(due.givenUp),
    coverageSection(due.vision),
    `Nothing more is built on this project; it waits until you stop it.`,
  ].join("\n\n");
}

export class DeliveredReports implements LiaisonDeliveredReports {
  constructor(private readonly store: DeliveredReportStore) {}

  /** A store failure throws through and fails the cycle. */
  async runPending(): Promise<readonly DeliveredReportOutcome[]> {
    const outcomes: DeliveredReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      const kind = await this.store.postReport(due.sweepId, deliveredReport(due));
      outcomes.push({ kind, projectId: due.projectId });
    }
    return outcomes;
  }
}
