import type { ProjectId, StoredBlockedReason } from "@ashara/shared";

// The Liaison's reports on project halts (story s-loop-never-stop-m1, migrations 040, 048): the
// client hears, once and in plain words, that a project is paused, what caused it and what happens
// next, and that it resumed. Nothing internal reaches the client: no error class, no component
// name, no stored reason text. Reports are read from recorded block episodes, so a halt written
// before a crash is still reported after the restart; the store posts each at most once. A project
// halts as undeliverable after the plan was repaired its bound of times (d74 D, d76): its report
// names each task given up and why. One halted on infrastructure resumes by itself, and its report
// says so. No task is reported on its own: no task waits on a person (W6).

/** What paused a project, as recorded on its block episode; the kinds below carry their own detail. */
type ProjectBlockKind = "budget_cap" | "configuration" | "fault" | "planning_stopped" | "replan_bound";

/** The dispute that passed its bound, as recorded when the project was blocked on it (before migration 048). */
interface BlockingDispute {
  readonly taskTitle: string;
  readonly checkName: string;
  readonly reason: string;
  /** Disputes the check task had drawn when the project was blocked. */
  readonly disputes: number;
}

/** The review that passed its bound, as recorded when the project was blocked on it (before migration 048). */
interface BlockingReview {
  /** How many reviews had named the check task past the bound when the project was blocked. */
  readonly times: number;
  /** What the last review found, as it stated each problem. */
  readonly problems: readonly string[];
}

/** A task the team gave up again after the plan was repaired its bound of times, as recorded when the project halted. */
interface BlockingAbandonment {
  readonly title: string;
  /** Its dispatches, the failed ones that led to it being given up. */
  readonly attempts: number;
  /** The cause it was given up for, as its blocked_reason recorded it. */
  readonly cause: StoredBlockedReason["source"];
}

/** The task whose infrastructure faults halted the project, as recorded when it halted. */
interface BlockingFault {
  readonly taskTitle: string;
  /** The infrastructure faults its dispatches met. */
  readonly faults: number;
}

/** A recorded halt or resumption the client has not been told about. */
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
      readonly kind: "plan_repair";
      readonly abandoned: readonly BlockingAbandonment[];
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "check_dispute";
      readonly dispute: BlockingDispute;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "infrastructure";
      readonly fault: BlockingFault;
    }
  /** `how` the halt ended: an owner's unblock, or the substrate probe passing after an infrastructure halt. */
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId; readonly how: "unblocked" | "probe_passed" };

/** Engagement's persistence port for block reports. */
export interface BlockReportStore {
  dueReports(): Promise<readonly DueBlockReport[]>;
  /** Posts the report on a project's block episode, `on` the block or its resumption, unless one exists. */
  postProjectReport(episodeId: string, on: "blocked" | "resumed", body: string): Promise<"posted" | "already-posted">;
}

interface BlockReportOutcome {
  readonly kind: "posted" | "already-posted";
  readonly projectId: ProjectId;
  readonly subject: "project-blocked" | "project-resumed";
}

/** What the core loop asks of the Liaison each cycle, at the spend cap too (no LLM call). */
export interface LiaisonBlockReports {
  runPending(): Promise<readonly BlockReportOutcome[]>;
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

/** Plain words: what stopped, why, and what the client can do (a halt recorded before migration 048). */
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

/** Plain words: what stopped, what the review found, and what the client can do (a halt recorded before migration 048). */
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

/** Why a task was given up, in the client's words. */
function givenUpCause(cause: StoredBlockedReason["source"]): string {
  switch (cause) {
    case "failure_router":
      return "every attempt at it failed";
    case "check_disputed":
      return "its developer and the team could not settle whether a check written to confirm it can be passed by correct work";
    case "suite_review_unresolved":
      return "the review of the checks written for the plan kept finding problems in them";
    case "checks_stale":
    case "checks_rewrite_bound":
      return "the checks that decide whether it is done kept failing to hold on the project's build and test environment";
    case "environment_change_needed":
      return "it needed a change to the project's build and test environment that the team could not make for it";
    case "dependency_unsatisfiable":
      return "it depended on work that could not be done";
    case "environment_unavailable":
      return "the machines it ran on kept failing";
    case "environment_undefined":
      return "the project's build and test environment could not be set up for it";
    case "owner_unresolved":
      return "no one on the team was assigned the kind of work it is";
    case "api":
      return "the team stopped it by hand";
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "merge_unrecorded":
    case "superseded":
      return "it hit a problem the team could not resolve";
  }
}

/** Plain words: which work the team gave up again and why, and what can resume the project. */
function planRepairBoundReport(abandoned: readonly BlockingAbandonment[]): string {
  return [
    `Work on this project has stopped: the team cannot deliver it as planned. It could not complete ` +
      abandoned.map((task) => `"${task.title}" (after ${plural(task.attempts, "attempt")}: ${givenUpCause(task.cause)})`).join(", ") +
      `, and the plan has already been revised around work it gave up as many times as the team revises it on its own.`,
    `Nothing more is built until the scope changes or the operator looks the project over; you will be told when work ` +
      `resumes. If you can say more about what this part should do, or what can be left out, send a change describing it.`,
  ].join("\n\n");
}

/** Plain words: the machines failed under one task, and the project resumes by itself. */
function infrastructureReport(fault: BlockingFault): string {
  return [
    `Work on this project is paused: the machines Ashara runs the work on failed ${plural(fault.faults, "time")} while ` +
      `working on "${fault.taskTitle}". This is a fault on Ashara's side, not in your project, and it is not charged ` +
      `as an attempt at the work.`,
    `Ashara checks its machines again on every round of work and resumes this project by itself as soon as they work; ` +
      `you will be told when it does.`,
  ].join("\n\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function projectResumedReport(how: "unblocked" | "probe_passed"): string {
  return how === "probe_passed"
    ? "Work on this project has resumed: the machines Ashara runs the work on work again, and the work goes on from where it stopped."
    : "Work on this project has resumed: the team cleared what paused it, and the work goes on from where it stopped.";
}

export class BlockReports implements LiaisonBlockReports {
  constructor(private readonly store: BlockReportStore) {}

  /** A store failure throws through and fails the cycle. */
  async runPending(): Promise<readonly BlockReportOutcome[]> {
    const outcomes: BlockReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      switch (due.subject) {
        case "project-blocked": {
          const body =
            due.kind === "check_dispute"
              ? disputeBoundReport(due.dispute)
              : due.kind === "suite_review"
                ? suiteReviewBoundReport(due.review)
                : due.kind === "plan_repair"
                  ? planRepairBoundReport(due.abandoned)
                  : due.kind === "infrastructure"
                    ? infrastructureReport(due.fault)
                    : projectBlockedReport(due.kind);
          const kind = await this.store.postProjectReport(due.episodeId, "blocked", body);
          outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
          break;
        }
        case "project-resumed": {
          const kind = await this.store.postProjectReport(due.episodeId, "resumed", projectResumedReport(due.how));
          outcomes.push({ kind, projectId: due.projectId, subject: due.subject });
          break;
        }
      }
    }
    return outcomes;
  }
}
