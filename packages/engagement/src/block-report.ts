import { blockedExitOf, projectBlockCause } from "@ashara/shared";
import type { BlockedExit, ProjectBlockCause, ProjectId, StoredBlockedReason } from "@ashara/shared";

// The Liaison's reports on blocks (story s-loop-never-stop-m1, migration 040): the client hears,
// once and in plain words, that a project is paused and what the team needs, that it resumed,
// and that a task is paused and how it gets going again. Nothing internal reaches the client: no
// error class, no component name, no stored reason text. Reports are read from recorded block
// episodes, so a block written before a crash is still reported after the restart; the store
// posts each at most once. A project blocked because its check disputes passed their bound
// (ADR-074 addendum 2 d65 c) is one of these blocks: its report names the disputed check. So is a
// project blocked because the review of a plan's checks kept finding problems in them (d71 c).

/** What paused a project, as recorded on its block episode; a check dispute's and a suite review's block carry their own. */
type ProjectBlockKind = "budget_cap" | "configuration" | "fault" | "planning_stopped" | "replan_bound";

/** The dispute that passed its bound, as recorded when the project was blocked on it. */
interface BlockingDispute {
  readonly taskTitle: string;
  readonly checkName: string;
  readonly reason: string;
  /** Disputes the check task had drawn when the project was blocked. */
  readonly disputes: number;
}

/** The review that passed its bound, as recorded when the project was blocked on it. */
interface BlockingReview {
  /** How many reviews had named the check task past the bound when the project was blocked. */
  readonly times: number;
  /** What the last review found, as it stated each problem. */
  readonly problems: readonly string[];
}

/** A recorded block, resumption or task block the client has not been told about. */
type DueBlockReport =
  | { readonly subject: "project-blocked"; readonly episodeId: string; readonly projectId: ProjectId; readonly kind: ProjectBlockKind }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "suite_review";
      readonly review: BlockingReview;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "check_dispute";
      readonly dispute: BlockingDispute;
    }
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId }
  | {
      readonly subject: "task-blocked";
      readonly projectId: ProjectId;
      readonly taskId: string;
      readonly title: string;
      readonly reason: StoredBlockedReason | undefined;
      /** Open tasks that depend on it, directly or through others: the work its block holds back. */
      readonly waiting: number;
    }
  /** A blocked task the store could not read back (its blocked_reason does not parse). */
  | { readonly subject: "task-blocked-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** Engagement's persistence port for block reports. */
export interface BlockReportStore {
  dueReports(): Promise<readonly DueBlockReport[]>;
  /** Posts the report on a project's block episode, `on` the block or its resumption, unless one exists. */
  postProjectReport(episodeId: string, on: "blocked" | "resumed", body: string): Promise<"posted" | "already-posted">;
  /** Posts the report on the task's current block unless one exists, or nothing when it is not Blocked any more. */
  postTaskReport(taskId: string, body: string): Promise<"posted" | "already-posted" | "not-blocked">;
  /** Blocks the project and records why (migration 025); a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

type BlockReportOutcome =
  | {
      readonly kind: "posted" | "already-posted" | "not-blocked";
      readonly projectId: ProjectId;
      readonly subject: "project-blocked" | "project-resumed" | "task-blocked";
    }
  /** The project's record cannot be reported truthfully: nothing is posted and the project is blocked. */
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle, at the spend cap too (no LLM call). */
export interface LiaisonBlockReports {
  runPending(): Promise<readonly BlockReportOutcome[]>;
}

/** A dispute past the bound, as Delivery hands it to the Liaison. */
interface DisputeBound {
  readonly projectId: ProjectId;
  readonly taskTitle: string;
  readonly checkTaskId: string;
  readonly checkName: string;
  readonly reason: string;
  /** Disputes the check task has drawn, this one included. */
  readonly disputes: number;
  readonly bound: number;
}

/**
 * What the core loop asks of the Liaison when a check's disputes pass their bound: past it nothing
 * in the team settles the check, so the project is blocked for its owner. The block's one report is
 * posted by runPending, like every other block's.
 */
export interface LiaisonCheckDisputes {
  blockOnDisputes(bound: DisputeBound): Promise<"blocked" | "already-blocked">;
}

/** A review of a plan's suites that named one check task past its bound, as Delivery hands it to the Liaison. */
interface SuiteReviewBound {
  readonly projectId: ProjectId;
  readonly reviewTaskId: string;
  readonly checkTaskId: string;
  /** Reviews that have named the check task, this one included. */
  readonly times: number;
  readonly bound: number;
  /** The problems this review found, as it stated them. */
  readonly problems: readonly string[];
}

/**
 * What the core loop asks of the Liaison when the review of a plan's suites names one check task
 * past its bound (ADR-074 addendum 2 d71 c): nothing in the team settles the checks, so the project
 * is blocked for its owner. Its one report is posted by runPending, from the record.
 */
export interface LiaisonSuiteReviews {
  blockOnSuiteReview(bound: SuiteReviewBound): Promise<"blocked" | "already-blocked">;
}

/** The project's cause on record: the review task, the check task past its bound, and what was found. */
class SuiteReviewBoundReached extends Error {
  constructor(readonly bound: SuiteReviewBound) {
    super(
      `review task ${bound.reviewTaskId} named check task ${bound.checkTaskId} in ${bound.times} review(s), past the ` +
        `bound of ${bound.bound}; it is not reopened again. The review found:\n` +
        bound.problems.map((problem) => `- ${problem}`).join("\n"),
    );
    this.name = "SuiteReviewBoundReached";
  }
}

/** The project's cause on record: which check task, how often, and the last dispute. */
class CheckDisputeBoundReached extends Error {
  constructor(readonly bound: DisputeBound) {
    super(
      `check task ${bound.checkTaskId}'s check ${JSON.stringify(bound.checkName)} was disputed ${bound.disputes} time(s), ` +
        `past the bound of ${bound.bound}; it is not reopened again. The last dispute: ${bound.reason}`,
    );
    this.name = "CheckDisputeBoundReached";
  }
}

const NO_MORE_WORK = "Until then nothing more is done on this project. The team is waiting on its operator for this, and you will be told when work resumes.";

/** What the client reads when a project is paused: what stopped, and what the team needs. */
function projectBlockedReport(kind: ProjectBlockKind): string {
  switch (kind) {
    case "budget_cap":
      return ["Work on this project is paused: the budget set for it has been reached.", "The budget has to be raised before more is spent. " + NO_MORE_WORK].join("\n\n");
    case "configuration":
      return [
        "Work on this project is paused: a step of the work needs something in Ashara's own setup that is missing or not allowed, " +
          "such as a model whose price is not known.",
        "The team has to correct that setup. " + NO_MORE_WORK,
      ].join("\n\n");
    case "fault":
      return [
        "Work on this project is paused: Ashara found a problem on its own side, in what it has recorded about this project " +
          "or in a step it could not finish.",
        "The team has to repair it. " + NO_MORE_WORK,
      ].join("\n\n");
    case "planning_stopped":
      return [
        "Ashara again could not turn this project's vision into a plan, so work on this project has stopped.",
        "The team has to look into it before planning is tried again. " + NO_MORE_WORK,
      ].join("\n\n");
    case "replan_bound":
      return [
        "Work on this project is paused: you changed what is built again, and the plan has already been revised for " +
          "your changes as many times as the team revises it before its operator looks over the project.",
        "Your latest change is recorded, and the plan is revised for it once the operator has looked the project over. " +
          NO_MORE_WORK,
      ].join("\n\n");
  }
}

/** Plain words: what stopped, why, and what the client can do. */
function disputeBoundReport(dispute: BlockingDispute): string {
  return [
    `Work on this project is paused. While building "${dispute.taskTitle}", the developer found that one of the checks ` +
      `written to confirm it ("${dispute.checkName}") cannot be passed by correct work, and the team has not been able ` +
      `to settle this after ${dispute.disputes} attempts.`,
    `The developer's last explanation: ${dispute.reason}`,
    `Nothing more will be built until this is resolved. If you can say what this part should do, send a change describing it: ` +
      `the team takes it in when work resumes, and you will be told when it does.`,
  ].join("\n\n");
}

/** Plain words: what stopped, what the review found, and what the client can do. */
function suiteReviewBoundReport(review: BlockingReview): string {
  return [
    `Work on this project is paused. Before building starts, the team reviews all the checks written to confirm the ` +
      `work, together with what you asked for. The review keeps finding checks that cannot all be passed at once, or ` +
      `that test something you did not ask for, and the team has not been able to settle this after ${review.times} reviews.`,
    `What the last review found:\n${review.problems.map((problem) => `- ${problem}`).join("\n")}`,
    `Nothing will be built until this is resolved. If you can say what the product should do in these cases, send a ` +
      `change describing it: the team takes it in when work resumes, and you will be told when it does.`,
  ].join("\n\n");
}

function projectResumedReport(): string {
  return "Work on this project has resumed: the team cleared what paused it, and the work goes on from where it stopped.";
}

/** What paused one task, in the client's words. */
function taskCause(reason: StoredBlockedReason | undefined): string {
  if (reason === undefined) return "it hit a problem the team has to look at";
  switch (reason.source) {
    case "environment_unavailable":
      return "the machines it runs on were not available";
    case "environment_undefined":
      return "the project's build and test environment is not ready for it";
    case "checks_stale":
    case "checks_rewrite_bound":
      return "the checks that decide whether it is done no longer hold on the project's current build and test environment";
    case "check_disputed":
      return "its developer found that one of the checks written to confirm it cannot be passed by correct work, and that check cannot be looked at again by the team on its own";
    case "suite_review_unresolved":
      return "the review of the checks written for the plan found problems in them, and those checks cannot be sent back to be written again by the team on its own";
    case "environment_change_needed":
      return "its work needs a change to the project's build and test environment, which this task may not make";
    case "owner_unresolved":
      return "no member of the project team can take it on";
    case "dependency_unsatisfiable":
      return "it depends on work that was given up, or on work that in turn waits on it";
    case "merge_unrecorded":
      return "its work is built and in place, but the team's record of it could not be saved";
    case "api":
      return "the team paused it by hand";
    case "superseded":
      return "a change you asked for replaced it";
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_router":
    case "operator_unblock":
      return "it hit a problem the team has to look at";
  }
}

/** How the task gets going again, in the client's words. */
function taskExit(exit: BlockedExit): string {
  switch (exit.kind) {
    case "environment-built":
      return "It resumes by itself once the project's build and test environment is ready.";
    case "roster-revision":
      return "It resumes by itself once the project team is changed.";
    case "merge-recorded":
      return "It is marked done by itself once that record is saved; nothing has to be redone.";
    case "operator":
      return "The team is waiting on its operator to resolve this.";
  }
}

/** What the block does to the rest of the project, from its dependency graph (third run N10). */
function taskImpact(waiting: number): string {
  if (waiting === 0) return "The rest of the project goes on.";
  const tasks = waiting === 1 ? "1 other task depends" : `${waiting} other tasks depend`;
  return `${tasks} on it, directly or through other tasks, and ${waiting === 1 ? "waits" : "wait"} until it goes on.`;
}

function taskBlockedReport(title: string, reason: StoredBlockedReason | undefined, waiting: number): string {
  return [
    `The task "${title}" is paused: ${taskCause(reason)}.`,
    `${taskExit(blockedExitOf(reason))} ${taskImpact(waiting)}`,
  ].join("\n\n");
}

export class BlockReports implements LiaisonBlockReports, LiaisonCheckDisputes, LiaisonSuiteReviews {
  constructor(private readonly store: BlockReportStore) {}

  /** Blocks the project on the review; its one report is posted by runPending, from the record. */
  async blockOnSuiteReview(bound: SuiteReviewBound): Promise<"blocked" | "already-blocked"> {
    const cause: ProjectBlockCause = { ...projectBlockCause(new SuiteReviewBoundReached(bound)), category: "suite_review" };
    const result = await this.store.blockProject(bound.projectId, cause);
    console.warn(`[liaison-suite-review] project ${bound.projectId} ${result}: ${cause.reason}`);
    return result;
  }

  /** Blocks the project on the dispute; its one report is posted by runPending, from the record. */
  async blockOnDisputes(bound: DisputeBound): Promise<"blocked" | "already-blocked"> {
    const cause: ProjectBlockCause = { ...projectBlockCause(new CheckDisputeBoundReached(bound)), category: "check_dispute" };
    const result = await this.store.blockProject(bound.projectId, cause);
    console.warn(`[liaison-check-dispute] project ${bound.projectId} ${result}: ${cause.reason}`);
    return result;
  }

  /**
   * One project's unreadable task blocks that project, and the other projects are still reported
   * on. Any other failure, a store failure included, throws through and fails the cycle.
   */
  async runPending(): Promise<readonly BlockReportOutcome[]> {
    const outcomes: BlockReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      switch (due.subject) {
        case "task-blocked-unreadable": {
          const result = await this.store.blockProject(due.projectId, due.cause);
          console.warn(
            `[liaison-block-report] project ${due.projectId}: ${due.cause.errorClass}, no task report posted; ` +
              `project ${result}: ${due.cause.reason}`,
          );
          outcomes.push({ kind: "project-blocked", projectId: due.projectId, cause: due.cause });
          break;
        }
        case "project-blocked": {
          const body =
            due.kind === "check_dispute"
              ? disputeBoundReport(due.dispute)
              : due.kind === "suite_review"
                ? suiteReviewBoundReport(due.review)
                : projectBlockedReport(due.kind);
          const kind = await this.store.postProjectReport(due.episodeId, "blocked", body);
          outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
          break;
        }
        case "project-resumed": {
          const kind = await this.store.postProjectReport(due.episodeId, "resumed", projectResumedReport());
          outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
          break;
        }
        case "task-blocked": {
          const kind = await this.store.postTaskReport(due.taskId, taskBlockedReport(due.title, due.reason, due.waiting));
          outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
          break;
        }
      }
    }
    return outcomes;
  }
}
