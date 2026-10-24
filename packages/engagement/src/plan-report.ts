import { z } from "zod";
import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { projectBlockCause } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import type { PlanTaskCounts } from "@ashara/delivery/reads";
import { registerOf, registerParagraph } from "./early-warning.js";
import type { RiskRecordReader } from "./early-warning.js";
import { REPORT_SUBJECT } from "./report-subjects.js";
import type { PlanReportSubject } from "./report-subjects.js";

// The Liaison's report on a project's first plan: Delivery records the planning outcome on the project, and the
// Liaison, the only writer to the client, tells the client about it. Reports are
// read from recorded outcomes, not handed over in memory, so one written before a
// crash is still reported after the restart; the store posts each at most once. A revision
// of the plan for a client's change is reported the same way, once each, naming
// every answer it took in: each of them was promised the client would
// be told what changed. The report of a first planning that stopped is the report of that halt, a
// terminal message (terminal-report.ts): its words are here, and it carries the guarantee table.

/** A revision written before the first plan was reported; `summary` as Delivery recorded it, parsed here. */
interface RevisionBeforeReport {
  readonly revisionId: string;
  readonly revision: number;
  readonly summary: unknown;
  /** The client answers recorded as taken in by the revision; its summary must name exactly these many. */
  readonly answersTaken: number;
}

/** Ordering hints between tasks that decomposition dropped; unrecorded for a plan written before they were recorded. */
type DroppedOrderingHints = { readonly kind: "recorded"; readonly count: number } | { readonly kind: "unrecorded" };

/** A recorded planning outcome the client has not been told about. */
type DuePlanReport =
  | {
      readonly subject: typeof REPORT_SUBJECT.firstPlan;
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly tasks: PlanTaskCounts;
      readonly droppedOrderingHints: DroppedOrderingHints;
      /**
       * Revisions written before this report, oldest first. The epics and counts above are the plan
       * they left standing, never the work they replaced.
       */
      readonly revisions: readonly RevisionBeforeReport[];
      /** The behaviour the plan that stands adds beyond what the contract states, each recorded as an assumption under its key. */
      readonly assumptions: readonly PlannedAssumption[];
    }
  /** A first plan the store could not read back (a work item that does not parse). */
  | { readonly subject: "first-plan-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** Behaviour a plan adds that no item of the contract states, as the assumption the contract records it under. */
interface PlannedAssumption {
  readonly key: string;
  readonly statement: string;
}

/** A revision of the plan the client has not been told about; `summary` as Delivery recorded it, parsed here. */
interface DuePlanRevisionReport {
  readonly revisionId: string;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly summary: unknown;
  /** The client answers recorded as taken in by the revision; its summary must name exactly these many. */
  readonly answersTaken: number;
}

/** Engagement's persistence port for planning reports; each report reissues the register of guarantees at risk. */
export interface PlanReportStore extends RiskRecordReader {
  /** Each due report read on its own: one whose rows do not read is its UnreadSubject. */
  dueReports(): Promise<ReadonlyArray<DuePlanReport | UnreadSubject>>;
  /**
   * Posts the report unless one on this subject already exists for the project, recording each of
   * `revisionIds` as reported by it, in the same write.
   */
  postReport(projectId: ProjectId, subject: PlanReportSubject, body: string, revisionIds: readonly string[]): Promise<"posted" | "already-posted">;
  /** Each due revision report read on its own: one whose row does not read is its UnreadSubject. */
  dueRevisionReports(): Promise<ReadonlyArray<DuePlanRevisionReport | UnreadSubject>>;
  /** Posts the report on the revision, in reply to the answer that asked for it, unless one exists. */
  postRevisionReport(revisionId: string, body: string): Promise<"posted" | "already-posted">;
  /**
   * Blocks the project and records why; a project already
   * blocked keeps its first cause. A blocked project's first plan is not due.
   */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

type PlanReportOutcome =
  | {
      readonly kind: "posted" | "already-posted";
      readonly projectId: ProjectId;
      readonly subject: PlanReportSubject | "plan-revision";
    }
  /** The project's record cannot be reported truthfully: nothing is posted and the project is blocked. */
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  | StepFaulted;

/** What the core loop asks of the Liaison after Delivery's planning step. */
export interface LiaisonPlanReports {
  runPending(): Promise<readonly PlanReportOutcome[]>;
}

/**
 * A first plan that cannot be reported truthfully: no epic, no task decomposed
 * from the client's goal, not exactly one environment setup task, not exactly one
 * product scaffold task, not exactly one check task per decomposed task, a task whose producer is not recorded (so it can
 * be neither counted toward the goal nor described as setup), a task already started (the report says none
 * is), or no record of the ordering hints the plan dropped. The counts are of the plan that stands:
 * superseded work is not in them.
 */
class PlanReportUnfounded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly epics: number,
    readonly tasks: PlanTaskCounts,
    readonly dropped: DroppedOrderingHints,
  ) {
    const droppedText = dropped.kind === "recorded" ? `${dropped.count} dropped ordering hint(s)` : "no record of dropped ordering hints";
    super(
      `project ${projectId} is recorded as planned with ${epics} epic(s), ${tasks.decomposition} decomposed task(s), ` +
        `${tasks.sprint0} Sprint 0 task(s), ${tasks.scaffolds} product scaffold task(s), ${tasks.checks} check task(s), ` +
        `${tasks.reviews} check review task(s), ` +
        `${tasks.unrecorded} task(s) of unrecorded origin, ${tasks.started} task(s) already started ` +
        `and ${droppedText}; ` +
        `no report is posted`,
    );
    this.name = "PlanReportUnfounded";
  }
}

// What a revision did, as Delivery records it on plan_revisions.summary (delivery replan-port.ts).
const revisionWorkFields = {
  // Empty when a correction left nothing to plan again (a withdrawn guarantee, an assumption no check rests on).
  newTasks: z.array(z.string().min(1)),
  newCheckTasks: z.number().int().min(0),
  // Absent where a stored summary does not count its review tasks; never read as 0.
  newReviewTasks: z.number().int().min(0).max(1).optional(),
  newEnvironmentTask: z.boolean(),
  supersededTasks: z.array(z.string().min(1)),
  supersededOther: z.number().int().min(0),
  keptCompleted: z.number().int().min(0),
  // Absent on a summary written before plans recorded the behaviour they add.
  assumptions: z.array(z.object({ key: z.string().min(1), statement: z.string().min(1) })).optional(),
};

// A revision for the client's changes carries every change it took in, each with their words and
// the decision; a plan repair, the titles of the tasks the team gave up.
const RevisionChangeSchema = z.object({ answer: z.string().min(1), decision: z.string().min(1) });
const PlanRevisionSummarySchema = z.union([
  z.object({ changes: z.array(RevisionChangeSchema).min(1), ...revisionWorkFields }),
  z.object({ repaired: z.array(z.string().min(1)).min(1), ...revisionWorkFields }),
]);

type PlanRevisionSummary = z.infer<typeof PlanRevisionSummarySchema>;

/** A client change a revision took in: what the client said and what was decided. */
type RevisionChange = z.infer<typeof RevisionChangeSchema>;

/**
 * A revision's summary does not name exactly the client answers recorded as taken in by it: a change
 * it took in would go untold, or a change no answer asked for would be told. Nothing is reported.
 */
class RevisionChangesUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisionId: string,
    readonly answersTaken: number,
    readonly changesNamed: number,
  ) {
    super(
      `project ${projectId}: plan revision ${revisionId} is recorded as taking in ${answersTaken} client answer(s), ` +
        `but its summary names ${changesNamed} change(s); no report is posted`,
    );
    this.name = "RevisionChangesUnrecorded";
  }
}

/** The summary, parsed, with its changes checked against the answers recorded as taken in. */
function readRevision(projectId: ProjectId, revisionId: string, summary: unknown, answersTaken: number): PlanRevisionSummary {
  const parsed = PlanRevisionSummarySchema.safeParse(summary);
  if (!parsed.success) throw new PlanRevisionSummaryUnreadable(projectId, revisionId, z.prettifyError(parsed.error));
  const named = "changes" in parsed.data ? parsed.data.changes.length : 0;
  if (named !== answersTaken) throw new RevisionChangesUnrecorded(projectId, revisionId, answersTaken, named);
  return parsed.data;
}

/**
 * A plan repair recorded before the first plan was reported. A repair revises around tasks the team
 * gave up, and no task runs before the first plan is reported, so this record cannot be described truthfully.
 */
class RepairBeforeFirstPlanReport extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisionId: string,
    readonly revision: number,
  ) {
    super(`project ${projectId}: plan revision ${revision} (${revisionId}) is a repair written before the first plan was reported; no report is posted`);
    this.name = "RepairBeforeFirstPlanReport";
  }
}

/** A revision's recorded summary does not say what it did, so it cannot be reported truthfully. */
class PlanRevisionSummaryUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisionId: string,
    readonly issues: string,
  ) {
    super(`project ${projectId}: plan revision ${revisionId}'s summary does not parse: ${issues}; no report is posted`);
    this.name = "PlanRevisionSummaryUnreadable";
  }
}

// The first plan's report states it when the plan holds exactly one review task (PlanReportUnfounded
// otherwise); a revision's, from the review tasks its summary records.
const REVIEW_SENTENCE =
  `Then a team member who wrote none of those checks reads them all together with what you asked for, and sends ` +
  `back any that cannot all be passed at once or that test something you did not ask for, before building starts.`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Plain words, only what the plan holds: its epics, the tasks toward what the
 * client asked for, the environment setup and the checks stated apart from them,
 * and any ordering between tasks the plan could not keep.
 */
function firstPlanReport(
  epicTitles: readonly string[],
  goalTasks: number,
  checkTasks: number,
  droppedHints: number,
  changes: readonly RevisionChange[],
  assumptions: readonly PlannedAssumption[],
): string {
  const epics = epicTitles.map((title) => `"${title}"`).join(", ");
  const paragraphs = [
    `Ashara has made the first plan for this project from its vision: ${plural(epicTitles.length, "epic")} (${epics}), ` +
      `split into ${plural(goalTasks, "task")} for what you asked for.`,
    // The client was told each correction changes the plan (answers.ts, the impact note); this is where they read what each changed.
    ...(changes.length === 0
      ? []
      : [
          changes.length === 1
            ? `This plan already takes in your message. The team revised the plan it had made before your message arrived, ` +
              `before any of that plan's work started. ${changeSentence(changes[0])}`
            : `This plan already takes in your ${changes.length} messages that changed it. The team revised the plan it had ` +
              `made before they arrived, before any of that plan's work started:\n` +
              changes.map((change) => `- ${changeSentence(change)}`).join("\n"),
        ]),
    `First, the team sets up the project environment: it chooses how the project is built and tested, ` +
      `before any of those tasks starts. Then a developer sets up the product's layout, which every later task builds on.`,
    `Before any of those tasks starts, team members who do not do them write the checks that decide whether each ` +
      `is done (${plural(checkTasks, "check task")}). A task counts as done only when its checks pass.`,
    REVIEW_SENTENCE,
    ...plannedParagraph(assumptions),
  ];
  if (droppedHints > 0) {
    paragraphs.push(
      `${plural(droppedHints, "ordering hint")} ${droppedHints === 1 ? "was" : "were"} dropped while planning: ` +
        `the plan does not keep that order between its tasks.`,
    );
  }
  paragraphs.push(`When the plan was made, none of its tasks had been started.`);
  return paragraphs.join("\n\n");
}

/**
 * The behaviour the plan adds that the client did not state, each as the assumption the contract now
 * records it under: the client reads it before any task resting on it starts, and can change it.
 */
function plannedParagraph(assumptions: readonly PlannedAssumption[]): string[] {
  if (assumptions.length === 0) return [];
  return [
    `The plan also builds behaviour your request does not state. The team has recorded ${assumptions.length === 1 ? "it as an assumption" : "each as an assumption"} ` +
      `of your contract, and no task resting on ${assumptions.length === 1 ? "it" : "them"} starts before this message:\n` +
      assumptions.map((assumption) => `- ${assumption.key}: ${assumption.statement}`).join("\n") +
      `\nIf ${assumptions.length === 1 ? "it is" : "any of them is"} not what you want, send a change saying what should be different.`,
  ];
}

/** One change in plain words: what the client said, and what work proceeds on because of it. */
function changeSentence(change: RevisionChange): string {
  return `Because you said "${change.answer}", work proceeds on: ${change.decision}`;
}

function quotedList(titles: readonly string[]): string {
  return titles.map((title) => `- ${title}`).join("\n");
}

/** What a revision's record says of a review of its checks, and nothing beyond it. */
function revisionReviewSentence(newReviewTasks: number | undefined): string {
  if (newReviewTasks === undefined) {
    return `The record of this revision does not say whether a team member who wrote none of those checks reviews them together before building starts.`;
  }
  return newReviewTasks === 1 ? REVIEW_SENTENCE : `No team member reviews those checks together before building starts.`;
}

/** Plain words: what the client said, what the team now does, what was set aside and what stays done. */
function planRevisionReport(summary: PlanRevisionSummary): string {
  const paragraphs =
    "changes" in summary
      ? summary.changes.length === 1
        ? [`The team has revised the plan for this project for your message. ${changeSentence(summary.changes[0])}`]
        : [
            `The team has revised the plan for this project for your ${summary.changes.length} messages that changed it:\n` +
              summary.changes.map((change) => `- ${changeSentence(change)}`).join("\n"),
          ]
      : [
          `The team could not complete ${summary.repaired.length === 1 ? "this task" : "these tasks"} after repeated attempts ` +
            `and has given ${summary.repaired.length === 1 ? "it" : "them"} up:\n${quotedList(summary.repaired)}\n` +
            `So the team has revised the plan for the work still to do; what you asked for has not changed.`,
        ];
  // eslint-disable-next-line no-restricted-syntax -- policy default: a summary written before plans recorded the behaviour they add records none it adds
  paragraphs.push(...plannedParagraph(summary.assumptions ?? []));
  if (summary.newEnvironmentTask) {
    paragraphs.push(
      "changes" in summary
        ? `${summary.changes.length === 1 ? "This change affects" : "These changes affect"} how the project is built and tested, so the team first sets up the project environment again.`
        : `What went wrong needs a change to how the project is built and tested, so the team first sets up the project environment again.`,
    );
  }
  paragraphs.push(
    ...(summary.newTasks.length === 0
      ? [`No new task is needed for this: nothing it changed is left for the team to build or check again.`]
      : [
          `The team will now do ${plural(summary.newTasks.length, "task")}:\n${quotedList(summary.newTasks)}`,
          `Before any of them starts, team members who do not do them write the checks that decide whether each is done ` +
            `(${plural(summary.newCheckTasks, "check task")}).`,
          revisionReviewSentence(summary.newReviewTasks),
        ]),
  );
  const setAside = summary.supersededTasks.length + summary.supersededOther;
  paragraphs.push(
    summary.supersededTasks.length > 0
      ? `Work planned earlier and not finished is set aside and will not be done as planned:\n${quotedList(summary.supersededTasks)}` +
          (summary.supersededOther > 0 ? `\nwith ${plural(summary.supersededOther, "related check or setup task")}.` : "")
      : setAside > 0
        ? `${plural(setAside, "check or setup task")} planned earlier and not finished ${setAside === 1 ? "is" : "are"} set aside.`
        : `Nothing planned earlier was set aside.`,
    summary.keptCompleted > 0
      ? `${plural(summary.keptCompleted, "task")} already finished ${summary.keptCompleted === 1 ? "stays" : "stay"} done, and the new work builds on ${summary.keptCompleted === 1 ? "it" : "them"}.`
      : `No work had been finished yet.`,
  );
  return paragraphs.join("\n\n");
}

/**
 * What the client reads when planning gives up, before the guarantee table its terminal message
 * carries (terminal-report.ts). The error chain stays in Delivery's planning record and the warn
 * log, never in the client channel.
 */
export function planningStoppedReport(attempts: number): string {
  return [
    `Ashara could not turn this project's vision into a plan after ${attempts} attempts, so work on this project has stopped.`,
    `No tasks were planned and nothing was built.`,
  ].join("\n\n");
}

export class PlanReports implements LiaisonPlanReports {
  constructor(
    private readonly store: PlanReportStore,
    /** Each report's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * One project's bad record blocks that project, and the other projects are
   * still reported on. Any other failure, a store failure included, is that
   * report's, contained to it (containEach).
   */
  async runPending(): Promise<readonly PlanReportOutcome[]> {
    const dueReports = await this.store.dueReports();
    const outcomes = await containEach(
      this.containment,
      "plan-report",
      dueReports,
      (due) => ({ id: `${due.subject}:${due.projectId}`, projectId: due.projectId }),
      async (due): Promise<PlanReportOutcome> => {
        if (due.subject === "first-plan-unreadable") return this.block(due.projectId, due.cause);
        let body: string;
        try {
          body = this.compose(due);
        } catch (err) {
          if (
            !(err instanceof PlanReportUnfounded) &&
            !(err instanceof PlanRevisionSummaryUnreadable) &&
            !(err instanceof RevisionChangesUnrecorded) &&
            !(err instanceof RepairBeforeFirstPlanReport)
          ) {
            throw err;
          }
          return this.block(due.projectId, projectBlockCause(err));
        }
        const revisionIds = due.revisions.map((r) => r.revisionId);
        const kind = await this.store.postReport(due.projectId, due.subject, await this.withRegister(due.projectId, body), revisionIds);
        return { kind, projectId: due.projectId, subject: due.subject };
      },
    );
    // A project blocked above is not told what the team will now do. The store lists only
    // active projects' revisions; this keeps that so within the pass that blocked it.
    const blocked = new Set(outcomes.filter((o) => o.kind === "project-blocked").map((o) => o.projectId));
    const revisions = (await this.store.dueRevisionReports()).filter((due) => !blocked.has(due.projectId));
    const revised = await containEach(
      this.containment,
      "plan-revision-report",
      revisions,
      (due) => ({ id: due.revisionId, projectId: due.projectId }),
      async (due): Promise<PlanReportOutcome> => {
        let summary: PlanRevisionSummary;
        try {
          summary = readRevision(due.projectId, due.revisionId, due.summary, due.answersTaken);
        } catch (err) {
          if (!(err instanceof PlanRevisionSummaryUnreadable) && !(err instanceof RevisionChangesUnrecorded)) throw err;
          return this.block(due.projectId, projectBlockCause(err));
        }
        const kind = await this.store.postRevisionReport(due.revisionId, await this.withRegister(due.projectId, planRevisionReport(summary)));
        return { kind, projectId: due.projectId, subject: "plan-revision" };
      },
    );
    return [...outcomes, ...revised];
  }

  /** The report's body with the register of guarantees at risk as its last paragraph. */
  private async withRegister(projectId: ProjectId, body: string): Promise<string> {
    const register = registerOf(await this.store.riskRecords(projectId));
    return `${body}\n\n${registerParagraph(projectId, register)}`;
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<PlanReportOutcome> {
    const result = await this.store.blockProject(projectId, cause);
    console.warn(
      `[liaison-report] project ${projectId}: ${cause.errorClass}, no report posted; project ${result}: ${cause.reason}`,
    );
    return { kind: "project-blocked", projectId, cause };
  }

  private compose(due: Extract<DuePlanReport, { readonly subject: typeof REPORT_SUBJECT.firstPlan }>): string {
    const { tasks, droppedOrderingHints: dropped } = due;
    if (
      due.epicTitles.length === 0 ||
      tasks.decomposition === 0 ||
      tasks.sprint0 !== 1 ||
      tasks.scaffolds !== 1 ||
      tasks.checks !== tasks.decomposition ||
      tasks.reviews !== 1 ||
      tasks.unrecorded > 0 ||
      tasks.started > 0 ||
      dropped.kind === "unrecorded"
    ) {
      throw new PlanReportUnfounded(due.projectId, due.epicTitles.length, tasks, dropped);
    }
    const changes = due.revisions.flatMap((revision): readonly RevisionChange[] => {
      const summary = readRevision(due.projectId, revision.revisionId, revision.summary, revision.answersTaken);
      if (!("changes" in summary)) throw new RepairBeforeFirstPlanReport(due.projectId, revision.revisionId, revision.revision);
      return summary.changes;
    });
    return firstPlanReport(due.epicTitles, tasks.decomposition, tasks.checks, dropped.count, changes, due.assumptions);
  }
}
