import type { ProjectId } from "@ashara/shared";

// The Liaison's report on a project's first plan (story s-liaison-intake-m1,
// ADR-075): Delivery records the planning outcome on the project, and the
// Liaison, the only writer to the client, tells the client about it. Reports are
// read from recorded outcomes, not handed over in memory, so one written before a
// crash is still reported after the restart; the store posts each at most once.

type PlanReportSubject = "first-plan" | "planning-stopped";

/** A recorded planning outcome the client has not been told about. */
type DuePlanReport =
  | {
      readonly subject: "first-plan";
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly taskCount: number;
    }
  | { readonly subject: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number };

/** Engagement's persistence port for planning reports. */
export interface PlanReportStore {
  dueReports(): Promise<readonly DuePlanReport[]>;
  /** Posts the report unless one on this subject already exists for the project. */
  postReport(projectId: ProjectId, subject: PlanReportSubject, body: string): Promise<"posted" | "already-posted">;
}

type PlanReportOutcome = {
  readonly kind: "posted" | "already-posted";
  readonly projectId: ProjectId;
  readonly subject: PlanReportSubject;
};

/** What the core loop asks of the Liaison after Delivery's planning step. */
export interface LiaisonPlanReports {
  runPending(): Promise<readonly PlanReportOutcome[]>;
}

/**
 * A first plan recorded with no epic or no task. Decomposition cannot produce
 * one; reporting it would tell the client a plan exists that says nothing.
 */
class PlanReportUnfounded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly epics: number,
    readonly tasks: number,
  ) {
    super(`project ${projectId} is recorded as planned with ${epics} epic(s) and ${tasks} task(s); no report is posted`);
    this.name = "PlanReportUnfounded";
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Plain words, only what the plan holds: its epics and how many tasks. */
function firstPlanReport(epicTitles: readonly string[], taskCount: number): string {
  const epics = epicTitles.map((title) => `"${title}"`).join(", ");
  return [
    `Ashara has made the first plan for this project from its vision: ${plural(epicTitles.length, "epic")} (${epics}), ` +
      `split into ${plural(taskCount, "task")}.`,
    `When the plan was made, none of its tasks had been started.`,
  ].join("\n\n");
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

  async runPending(): Promise<readonly PlanReportOutcome[]> {
    const outcomes: PlanReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      const body = this.compose(due);
      const kind = await this.store.postReport(due.projectId, due.subject, body);
      outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
    }
    return outcomes;
  }

  private compose(due: DuePlanReport): string {
    if (due.subject === "planning-stopped") return planningStoppedReport(due.attempts);
    if (due.epicTitles.length === 0 || due.taskCount === 0) {
      throw new PlanReportUnfounded(due.projectId, due.epicTitles.length, due.taskCount);
    }
    return firstPlanReport(due.epicTitles, due.taskCount);
  }
}
