import { SPEND_CAP_ERROR_CLASS } from "@ashara/shared";
import type { ProjectId, StoredBlockedReason } from "@ashara/shared";

// The Liaison's reports on project halts (story s-loop-never-stop-m1, migrations 040, 048; story
// s-independent-verify-m1 W7): the client hears, once, that a project is paused, the cause as it
// was recorded, and what happens next; and that it resumed. The cause is never a sentence asserted
// as observed fact (M2 trial M3: a fixed sentence told the client a false cause): a halt recorded
// with an error chain is told as Ashara's record of its kind, in the client's words, naming the
// record that holds the chain, which stays with the operator (W11b D3: the raw chain told the
// client internal class names); a bound halt quotes what its review, dispute or given-up tasks
// recorded; and a halt with none recorded says so. Reports are read from recorded block
// episodes, so a halt written before a crash is still reported after the restart; the store posts
// each at most once. No task is reported on its own: no task waits on a person (W6).

/** What paused a project, as recorded on its block episode; the kinds below carry their own detail. */
type ProjectBlockKind = "budget_cap" | "configuration" | "fault" | "planning_stopped" | "replan_bound" | "infrastructure";

/** The cause recorded on a block episode: the error's class and its described chain, each null when none was written. */
interface RecordedCause {
  readonly errorClass: string | null;
  readonly reason: string | null;
}

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
  /** Why it was given up, its blocked_reason as stored. */
  readonly cause: StoredBlockedReason;
}

/** A recorded halt or resumption the client has not been told about. */
type DueBlockReport =
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: ProjectBlockKind;
      readonly cause: RecordedCause;
    }
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

/** Longest part of one recorded cause the client is shown; the rest is cut, and the cut is stated. */
const MAX_CAUSE_CHARS = 2000;

function cut(text: string): string {
  return text.length <= MAX_CAUSE_CHARS ? text : `${text.slice(0, MAX_CAUSE_CHARS)} [${text.length - MAX_CAUSE_CHARS} more characters not shown]`;
}

/**
 * Whose spending limit a budget_cap halt records, from its recorded error class (SPEND_CAP_ERROR_CLASS),
 * never from its message: the deployment's, binding every project, or the project's own (smoke1 D4).
 * A class that is neither is not guessed at: the report says which limit is not on record.
 */
type SpendLimit = "deployment" | "project" | "unrecorded";

function spendLimitOf(cause: RecordedCause): SpendLimit {
  switch (cause.errorClass) {
    case SPEND_CAP_ERROR_CLASS.deployment:
      return "deployment";
    case SPEND_CAP_ERROR_CLASS.project:
      return "project";
    default:
      return "unrecorded";
  }
}

/** The halt as the report tells it: its recorded kind, and for a budget_cap halt whose limit was reached. */
type ToldHalt = { readonly kind: Exclude<ProjectBlockKind, "budget_cap"> } | { readonly kind: "budget_cap"; readonly limit: SpendLimit };

function toldHalt(kind: ProjectBlockKind, cause: RecordedCause): ToldHalt {
  return kind === "budget_cap" ? { kind, limit: spendLimitOf(cause) } : { kind };
}

function spendLimitReached(limit: SpendLimit): string {
  switch (limit) {
    case "deployment":
      return "the spending limit set for all of Ashara's work, across every project it runs, was reached, so the next step of the work was not paid for";
    case "project":
      return "the spending limit set for this project was reached, so the next step of the work was not paid for";
    case "unrecorded":
      return "a spending limit set for this work was reached, so the next step of the work was not paid for; which limit it was is not on record";
  }
}

/**
 * What the episode's recorded kind says paused the project, in the client's words: only what every
 * halt recorded with that kind is by definition (ProjectBlockCategory), stated as Ashara's own
 * record, so a misrecorded kind reads as Ashara's record and not as an observed fact (M2 trial M3).
 */
function recordedKind(halt: ToldHalt): string {
  switch (halt.kind) {
    case "budget_cap":
      return spendLimitReached(halt.limit);
    case "configuration":
      return "a step of the work needed something Ashara's own setup does not provide, for a reason other than a spending limit";
    case "fault":
      return "a step of Ashara's own work on this project failed, or Ashara's own record of the project did not hold together";
    case "planning_stopped":
      return "every attempt to make the plan failed";
    case "replan_bound":
      return "the plan has been revised for your changes as many times as the team revises it before its operator looks the project over";
    case "infrastructure":
      return "the machines Ashara runs the work on kept failing while they ran this project's work";
  }
}

/**
 * The cause in the client's words, from the episode's recorded kind; the record's own text (the error
 * class and its chain) stays in project_blocks for the operator, and the report names that record
 * (W11b D3). A halt with no cause recorded says so.
 */
function recordedCause(episodeId: string, halt: ToldHalt, cause: RecordedCause): string {
  if (cause.reason === null && cause.errorClass === null) return "No cause was recorded for this pause.";
  return (
    `Ashara recorded the cause as this: ${recordedKind(halt)}. ` +
    `Ashara keeps the technical detail in its own record of this pause, record ${episodeId}.`
  );
}

const WAITS_ON_OPERATOR = "Until then nothing more is done on this project. The team is waiting on its operator for this, and you will be told when work resumes.";

/** What has to be raised for a budget_cap halt to end: the limit that was reached, as recorded. */
function limitToRaise(limit: SpendLimit): string {
  switch (limit) {
    case "deployment":
      return "The spending limit for all of Ashara's work has to be raised before more is spent on any project, this one included.";
    case "project":
      return "The budget set for this project has to be raised before more is spent.";
    case "unrecorded":
      return "The spending limit that was reached has to be raised before more is spent.";
  }
}

/** What happens next after a halt: who or what ends it. The cause is stated apart, from the record. */
function nextStep(halt: ToldHalt): string {
  switch (halt.kind) {
    case "budget_cap":
      return `${limitToRaise(halt.limit)} ${WAITS_ON_OPERATOR}`;
    case "configuration":
      return `Ashara's own setup has to be corrected. ${WAITS_ON_OPERATOR}`;
    case "fault":
      return `The team has to repair it. ${WAITS_ON_OPERATOR}`;
    case "planning_stopped":
      return `The team has to look into it before planning is tried again. ${WAITS_ON_OPERATOR}`;
    case "replan_bound":
      return `Your latest change is recorded, and the plan is revised for it once the operator has looked the project over. ${WAITS_ON_OPERATOR}`;
    case "infrastructure":
      // Not a claim about the cause, which is the record's own text above: only what ends this
      // halt (infrastructure-halts.ts, the substrate probe each cycle) and that it is not charged.
      return (
        `This pause is not charged as an attempt at the work. Ashara checks the machines it runs the work on again ` +
        `on every round of work and resumes this project by itself as soon as they answer; you will be told when it does.`
      );
  }
}

/** What the client reads when a project is paused: that it is, the recorded cause, and what happens next. */
function projectBlockedReport(episodeId: string, kind: ProjectBlockKind, cause: RecordedCause): string {
  const opening = kind === "planning_stopped" ? "Ashara could not turn this project's vision into a plan, so work on this project has stopped." : "Work on this project is paused.";
  const halt = toldHalt(kind, cause);
  return [opening, recordedCause(episodeId, halt, cause), nextStep(halt)].join("\n\n");
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

/** The text a given-up task's stored reason recorded of why: the record's own words, never a sentence per source. */
function observedCause(cause: StoredBlockedReason): string {
  switch (cause.source) {
    case "failure_router":
      return [cause.reason, ...(cause.detail === undefined ? [] : [cause.detail])].join(" ");
    case "replan":
      return cause.replanContext.detail;
    case "environment_unavailable":
      return `${cause.unavailable} unavailable: ${cause.reason}`;
    case "environment_change_needed":
      return `${cause.reason} (recipe files: ${cause.paths.join(", ")})`;
    case "check_disputed":
      return `check "${cause.checkName}" disputed: ${cause.reason}`;
    case "orphan_unreconciled":
      return `${cause.step} failed: ${cause.reason}`;
    case "acceptance_failed":
      return cause.mainCommit === null
        ? `the acceptance run could not read main: ${cause.reason}`
        : `the acceptance run on main ${cause.mainCommit} did not pass: ${cause.reason}`;
    case "api": {
      // The route stores the caller's own fields beside `source` (passthrough): quoted as written.
      const written = Object.fromEntries(Object.entries(cause).filter(([key]) => key !== "source"));
      return Object.keys(written).length === 0
        ? "it was moved by hand through Ashara's API; no cause beyond that is recorded"
        : `it was moved by hand through Ashara's API, with this recorded: ${JSON.stringify(written)}`;
    }
    case "task_failed":
    case "orchestrator_error":
    case "environment_undefined":
    case "checks_stale":
    case "checks_rewrite_bound":
    case "suite_review_unresolved":
    case "owner_unresolved":
    case "dependency_unsatisfiable":
    case "merge_unrecorded":
    case "superseded":
      return cause.reason;
  }
}

/** Plain words: which work the team gave up again and the recorded cause of each, and what can resume the project. */
function planRepairBoundReport(abandoned: readonly BlockingAbandonment[]): string {
  return [
    `Work on this project has stopped: the team cannot deliver it as planned. The plan has already been revised around ` +
      `work it gave up as many times as the team revises it on its own, and it gave up again:`,
    abandoned.map((task) => `- "${task.title}", after ${plural(task.attempts, "attempt")}. As recorded: ${cut(observedCause(task.cause))}`).join("\n"),
    `Nothing more is built until the scope changes or the operator looks the project over; you will be told when work ` +
      `resumes. If you can say more about what this part should do, or what can be left out, send a change describing it.`,
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

function blockedBody(due: Extract<DueBlockReport, { readonly subject: "project-blocked" }>): string {
  switch (due.kind) {
    case "check_dispute":
      return disputeBoundReport(due.dispute);
    case "suite_review":
      return suiteReviewBoundReport(due.review);
    case "plan_repair":
      return planRepairBoundReport(due.abandoned);
    default:
      return projectBlockedReport(due.episodeId, due.kind, due.cause);
  }
}

export class BlockReports implements LiaisonBlockReports {
  constructor(private readonly store: BlockReportStore) {}

  /** A store failure throws through and fails the cycle. */
  async runPending(): Promise<readonly BlockReportOutcome[]> {
    const outcomes: BlockReportOutcome[] = [];
    for (const due of await this.store.dueReports()) {
      switch (due.subject) {
        case "project-blocked": {
          const kind = await this.store.postProjectReport(due.episodeId, "blocked", blockedBody(due));
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
