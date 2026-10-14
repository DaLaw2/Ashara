import { z } from "zod";
import { projectBlockCause } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";

// The Liaison's report on a project's first plan (story s-liaison-intake-m1,
// ADR-075): Delivery records the planning outcome on the project, and the
// Liaison, the only writer to the client, tells the client about it. Reports are
// read from recorded outcomes, not handed over in memory, so one written before a
// crash is still reported after the restart; the store posts each at most once. A revision
// of the plan for a client's change (migration 042) is reported the same way, once each.

type PlanReportSubject = "first-plan" | "planning-stopped";

/** The plan's tasks by producer, as task_spec.origin records it. */
interface PlanTaskCounts {
  readonly decomposition: number;
  /** The task that sets up the project environment before any other. */
  readonly sprint0: number;
  /** The task that sets up the product's layout after the environment and before any check is written. */
  readonly scaffolds: number;
  /** The tasks in which the checks of a decomposed task are written, one per decomposed task. */
  readonly checks: number;
  /** The review that reads every check of the plan together before any of its work starts. */
  readonly reviews: number;
  readonly unrecorded: number;
  /** Tasks already dispatched: the report says none of the plan's tasks has started. */
  readonly started: number;
}

/** A revision written before the first plan was reported; `summary` as Delivery recorded it, parsed here. */
interface RevisionBeforeReport {
  readonly revisionId: string;
  readonly revision: number;
  readonly summary: unknown;
}

/** Ordering hints between tasks that decomposition dropped; unrecorded for a plan written before they were recorded. */
type DroppedOrderingHints = { readonly kind: "recorded"; readonly count: number } | { readonly kind: "unrecorded" };

/** A recorded planning outcome the client has not been told about. */
type DuePlanReport =
  | {
      readonly subject: "first-plan";
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly tasks: PlanTaskCounts;
      readonly droppedOrderingHints: DroppedOrderingHints;
      /**
       * Revisions written before this report, oldest first. The epics and counts above are the plan
       * they left standing, never the work they replaced (W11b D1).
       */
      readonly revisions: readonly RevisionBeforeReport[];
    }
  | { readonly subject: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number }
  /** A first plan the store could not read back (a work item that does not parse). */
  | { readonly subject: "first-plan-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** A revision of the plan the client has not been told about; `summary` as Delivery recorded it, parsed here. */
interface DuePlanRevisionReport {
  readonly revisionId: string;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly summary: unknown;
}

type ReportableDue = Exclude<DuePlanReport, { readonly subject: "first-plan-unreadable" }>;

/** Engagement's persistence port for planning reports. */
export interface PlanReportStore {
  dueReports(): Promise<readonly DuePlanReport[]>;
  /**
   * Posts the report unless one on this subject already exists for the project, recording each of
   * `revisionIds` as reported by it in the same write.
   */
  postReport(projectId: ProjectId, subject: PlanReportSubject, body: string, revisionIds: readonly string[]): Promise<"posted" | "already-posted">;
  dueRevisionReports(): Promise<readonly DuePlanRevisionReport[]>;
  /** Posts the report on the revision, in reply to the answer that asked for it, unless one exists. */
  postRevisionReport(revisionId: string, body: string): Promise<"posted" | "already-posted">;
  /**
   * Blocks the project and records why (migration 025); a project already
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
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

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

// What a revision did, as Delivery records it on plan_revisions.summary (planning replan.ts).
const revisionWorkFields = {
  newTasks: z.array(z.string().min(1)).min(1),
  newCheckTasks: z.number().int().min(0),
  newEnvironmentTask: z.boolean(),
  supersededTasks: z.array(z.string().min(1)),
  supersededOther: z.number().int().min(0),
  keptCompleted: z.number().int().min(0),
};

// A revision for a client's change carries their words and the decision; a plan repair (migration
// 045), the titles of the tasks the team gave up.
const PlanRevisionSummarySchema = z.union([
  z.object({ answer: z.string().min(1), decision: z.string().min(1), ...revisionWorkFields }),
  z.object({ repaired: z.array(z.string().min(1)).min(1), ...revisionWorkFields }),
]);

type PlanRevisionSummary = z.infer<typeof PlanRevisionSummarySchema>;

/** A client change taken in before the first plan was reported: what the client said and what was decided. */
interface ChangeBeforeReport {
  readonly answer: string;
  readonly decision: string;
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

// Every plan and every revision carries one review task (planning decomposition.ts), so both reports state it.
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
  changes: readonly ChangeBeforeReport[],
): string {
  const epics = epicTitles.map((title) => `"${title}"`).join(", ");
  const paragraphs = [
    `Ashara has made the first plan for this project from its vision: ${plural(epicTitles.length, "epic")} (${epics}), ` +
      `split into ${plural(goalTasks, "task")} for what you asked for.`,
    // The client was told their answer changes the plan (answers.ts); this is where they read what it changed.
    ...changes.map(
      (change) =>
        `This plan already takes in your answer. Because you said "${change.answer}", the team revised the plan it had ` +
        `made before your answer arrived, before any of that plan's work started. Work proceeds on: ${change.decision}`,
    ),
    `First, the team sets up the project environment: it chooses how the project is built and tested, ` +
      `before any of those tasks starts. Then a developer sets up the product's layout, which every later task builds on.`,
    `Before any of those tasks starts, team members who do not do them write the checks that decide whether each ` +
      `is done (${plural(checkTasks, "check task")}). A task counts as done only when its checks pass.`,
    REVIEW_SENTENCE,
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

function quotedList(titles: readonly string[]): string {
  return titles.map((title) => `- ${title}`).join("\n");
}

/** Plain words: what the client said, what the team now does, what was set aside and what stays done. */
function planRevisionReport(summary: PlanRevisionSummary): string {
  const paragraphs =
    "answer" in summary
      ? [`Because you said "${summary.answer}", the team has revised the plan for this project. Work now proceeds on: ${summary.decision}`]
      : [
          `The team could not complete ${summary.repaired.length === 1 ? "this task" : "these tasks"} after repeated attempts ` +
            `and has given ${summary.repaired.length === 1 ? "it" : "them"} up:\n${quotedList(summary.repaired)}\n` +
            `So the team has revised the plan for the work still to do; what you asked for has not changed.`,
        ];
  if (summary.newEnvironmentTask) {
    paragraphs.push(
      "answer" in summary
        ? `This change affects how the project is built and tested, so the team first sets up the project environment again.`
        : `What went wrong needs a change to how the project is built and tested, so the team first sets up the project environment again.`,
    );
  }
  paragraphs.push(
    `The team will now do ${plural(summary.newTasks.length, "task")}:\n${quotedList(summary.newTasks)}`,
    `Before any of them starts, team members who do not do them write the checks that decide whether each is done ` +
      `(${plural(summary.newCheckTasks, "check task")}).`,
    REVIEW_SENTENCE,
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
 * What the client reads when planning gives up. The error chain stays in
 * projects.plan_last_error and the warn log, never in the client channel.
 */
function planningStoppedReport(attempts: number): string {
  return [
    `Ashara could not turn this project's vision into a plan after ${attempts} attempts, so work on this project has stopped.`,
    `No tasks were planned and nothing was built.`,
  ].join("\n\n");
}

export class PlanReports implements LiaisonPlanReports {
  constructor(private readonly store: PlanReportStore) {}

  /**
   * One project's bad record blocks that project, and the other projects are
   * still reported on. Any other failure, a store failure included, throws
   * through and fails the cycle.
   */
  async runPending(): Promise<readonly PlanReportOutcome[]> {
    const outcomes: PlanReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      if (due.subject === "first-plan-unreadable") {
        outcomes.push(await this.block(due.projectId, due.cause));
        continue;
      }
      let body: string;
      try {
        body = this.compose(due);
      } catch (err) {
        if (!(err instanceof PlanReportUnfounded) && !(err instanceof PlanRevisionSummaryUnreadable) && !(err instanceof RepairBeforeFirstPlanReport)) {
          throw err;
        }
        outcomes.push(await this.block(due.projectId, projectBlockCause(err)));
        continue;
      }
      const revisionIds = due.subject === "first-plan" ? due.revisions.map((r) => r.revisionId) : [];
      const kind = await this.store.postReport(due.projectId, due.subject, body, revisionIds);
      outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
    }
    // A project blocked above is not told what the team will now do (W11b D2). The store lists only
    // active projects' revisions; this keeps that so within the pass that blocked it.
    const blocked = new Set(outcomes.filter((o) => o.kind === "project-blocked").map((o) => o.projectId));
    for (const due of await this.store.dueRevisionReports()) {
      if (blocked.has(due.projectId)) continue;
      const parsed = PlanRevisionSummarySchema.safeParse(due.summary);
      if (!parsed.success) {
        const err = new PlanRevisionSummaryUnreadable(due.projectId, due.revisionId, z.prettifyError(parsed.error));
        outcomes.push(await this.block(due.projectId, projectBlockCause(err)));
        continue;
      }
      const kind = await this.store.postRevisionReport(due.revisionId, planRevisionReport(parsed.data));
      outcomes.push({ kind, projectId: due.projectId, subject: "plan-revision" });
    }
    return outcomes;
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<PlanReportOutcome> {
    const result = await this.store.blockProject(projectId, cause);
    console.warn(
      `[liaison-report] project ${projectId}: ${cause.errorClass}, no report posted; project ${result}: ${cause.reason}`,
    );
    return { kind: "project-blocked", projectId, cause };
  }

  private compose(due: ReportableDue): string {
    if (due.subject === "planning-stopped") return planningStoppedReport(due.attempts);
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
    const changes = due.revisions.map((revision): ChangeBeforeReport => {
      const parsed = PlanRevisionSummarySchema.safeParse(revision.summary);
      if (!parsed.success) throw new PlanRevisionSummaryUnreadable(due.projectId, revision.revisionId, z.prettifyError(parsed.error));
      if (!("answer" in parsed.data)) throw new RepairBeforeFirstPlanReport(due.projectId, revision.revisionId, revision.revision);
      return { answer: parsed.data.answer, decision: parsed.data.decision };
    });
    return firstPlanReport(due.epicTitles, tasks.decomposition, tasks.checks, dropped.count, changes);
  }
}
