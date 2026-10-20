import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import type { SpendAtCap, WorkAtBudget } from "@ashara/finance";
import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/delivery/work-item";
import { registerOf, registerParagraph } from "./early-warning.js";
import type { RiskRecordReader } from "./early-warning.js";
import { guaranteeSection, tableVerdicts } from "./guarantee-report.js";
import type { GuaranteeTable, TableVerdicts } from "./guarantee-report.js";

// The Liaison's reports on project halts: the client hears, once, that a project is paused, the cause as it
// was recorded, and what happens next; and that it resumed. The cause is never a sentence asserted
// as observed fact, since a fixed sentence can name a cause nobody observed: a halt recorded
// with an error chain is told as Ashara's record of its kind, in the client's words, naming the
// record that holds the chain, which stays with the operator because the raw chain names Ashara's
// internal classes; a plan-repair halt tells each given-up task's recorded reason as its category
// in the client's words, naming the task's record, which holds the stored text (stored reasons are
// Ashara's internal wording); and a halt with none recorded says so. Reports are read from recorded block
// episodes, so a halt written before a crash is still reported after the restart; the store posts
// each at most once. No task is reported on its own: no task waits on a person. A halt's report
// carries the guarantee table of the halt's terminal sweep; under a halt of Ashara's own machines
// that sweep ran on no commit, and a halt whose sweep is not on record is told all the same: either
// way every guarantee reads unjudged, saying so.

/** What paused a project, as recorded on its block episode; the kinds below carry their own detail. */
type ProjectBlockKind =
  | "budget_cap"
  | "configuration"
  | "fault"
  | "planning_stopped"
  | "replan_bound"
  | "infrastructure"
  | "replan_stopped"
  | "replan_provider_failed"
  | "model_failed"
  | "provider_failed"
  | "work_budget";

/**
 * The cause recorded on a block episode: the error's class and its described chain, each null when
 * none was written, on a budget_cap halt the amounts its cap was judged on, null when not recorded,
 * and on a work_budget halt the work ledger as it stood, null on every other kind.
 */
interface RecordedCause {
  readonly errorClass: string | null;
  readonly reason: string | null;
  readonly spend: SpendAtCap | null;
  readonly work: WorkAtBudget | null;
}

/** The dispute that passed its bound, as recorded when the project was blocked on it; only older records hold this halt kind. */
interface BlockingDispute {
  readonly taskTitle: string;
  readonly checkName: string;
  readonly reason: string;
  /** Disputes the check task had drawn when the project was blocked. */
  readonly disputes: number;
}

/** The review that passed its bound, as recorded when the project was blocked on it; only older records hold this halt kind. */
interface BlockingReview {
  /** How many reviews had named the check task past the bound when the project was blocked. */
  readonly times: number;
  /** What the last review found, as it stated each problem. */
  readonly problems: readonly string[];
}

/** A task the team gave up again after the plan was repaired its bound of times, as recorded when the project halted. */
interface BlockingAbandonment {
  /** The task's work item: the record that holds why it was given up, in Ashara's own words. */
  readonly workItemId: string;
  readonly title: string;
  /**
   * Its dispatch count: the attempts charged to its retry bound. A dispatch refunded because it did
   * no chargeable work (a model call refused before it was sent, stale checks, a dispute, an
   * environment change) is not counted, though its session is on record.
   */
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
      readonly guarantees: GuaranteeTable;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "suite_review";
      readonly review: BlockingReview;
      readonly guarantees: GuaranteeTable;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "plan_repair";
      readonly abandoned: readonly BlockingAbandonment[];
      readonly guarantees: GuaranteeTable;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "check_dispute";
      readonly dispute: BlockingDispute;
      readonly guarantees: GuaranteeTable;
    }
  /** `how` the halt ended: an owner's unblock, or the substrate probe passing after an infrastructure halt. */
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId; readonly how: "unblocked" | "probe_passed" };

/** Engagement's persistence port for block reports; each report reissues the register of guarantees at risk. */
export interface BlockReportStore extends RiskRecordReader {
  /** Every report due, each read on its own: one whose record does not read as a report is its UnreadSubject. */
  dueReports(): Promise<ReadonlyArray<DueBlockReport | UnreadSubject>>;
  /**
   * Posts the report on a project's block episode, `on` the block (with its table's verdicts) or its
   * resumption (with none), unless one exists.
   */
  postProjectReport(episodeId: string, on: "blocked" | "resumed", body: string, verdicts: TableVerdicts | null): Promise<"posted" | "already-posted">;
}

interface BlockReportOutcome {
  readonly kind: "posted" | "already-posted";
  readonly projectId: ProjectId;
  readonly subject: "project-blocked" | "project-resumed";
}

/** What the core loop asks of the Liaison each cycle, at the spend cap too (no LLM call). */
export interface LiaisonBlockReports {
  runPending(): Promise<ReadonlyArray<BlockReportOutcome | StepFaulted>>;
}

/**
 * Whose spending limit a budget_cap halt records, from its recorded error class (SPEND_CAP_ERROR_CLASS),
 * never from its message: the deployment's, binding every project, or the project's own.
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

/** The halt as the report tells it: its recorded kind, and for a budget_cap halt whose limit stopped the work and the amounts it was judged on. */
type ToldHalt =
  | { readonly kind: Exclude<ProjectBlockKind, "budget_cap" | "work_budget"> }
  | { readonly kind: "budget_cap"; readonly limit: SpendLimit; readonly spend: SpendAtCap | null }
  | { readonly kind: "work_budget"; readonly work: WorkAtBudget | null };

function toldHalt(kind: ProjectBlockKind, cause: RecordedCause): ToldHalt {
  if (kind === "budget_cap") return { kind, limit: spendLimitOf(cause), spend: cause.spend };
  if (kind === "work_budget") return { kind, work: cause.work };
  return { kind };
}

function requests(count: number): string {
  return `${count} model request${count === 1 ? "" : "s"}`;
}

/**
 * What the work ledger recorded when it stopped the work: the budget, the requests drawn against it,
 * and which steps of the work drew them, by the call site Ashara records each request under; or that
 * the figures are not on record.
 */
function workFigures(work: WorkAtBudget | null): string {
  if (work === null) return "How many model requests had been drawn against that budget, and by which steps of the work, is not on record.";
  const granted = work.grantedRequests > 0 ? `, ${requests(work.grantedRequests)} of it granted by the operator` : "";
  const reserve = work.reserveRequests > 0 ? ` ${requests(work.reserveRequests)} of the budget are set aside for checking and accepting the finished work.` : "";
  const sites = work.bySite.length === 0 ? "none is on record" : work.bySite.map((site) => `"${site.callSite}" ${site.requests}`).join(", ");
  return (
    `When it stopped the work, ${requests(work.spentRequests)} had been sent and ${work.inFlightRequests} more were under way, ` +
    `against a budget of ${requests(work.budgetRequests)}${granted}.${reserve} The requests drawn, by the step of the work that drew them: ${sites}.`
  );
}

/**
 * A spend cap refuses a call whose worst case would cross it, so the limit stops the work before
 * the recorded spend reaches it: the report says the limit left no room, never that it was reached.
 */
function spendLimitStopped(limit: SpendLimit): string {
  const stopped = "left no room for the next step of the work, so that step was not paid for";
  switch (limit) {
    case "deployment":
      return `the spending limit set for all of Ashara's work, across every project it runs, ${stopped}`;
    case "project":
      return `the spending limit set for this project ${stopped}`;
    case "unrecorded":
      return `a spending limit set for this work ${stopped}; which limit it was is not on record`;
  }
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** The amounts the limit was judged on, as recorded, or that they are not on record. */
function spendFigures(spend: SpendAtCap | null): string {
  if (spend === null) return "How much had been spent and set aside against that limit when it stopped the work is not on record.";
  const next =
    spend.nextCallUsd === null
      ? "which together had reached the limit"
      : `and the next step needed up to ${usd(spend.nextCallUsd)} set aside, more than the limit had room for`;
  return (
    `When it stopped the work, ${usd(spend.spentUsd)} had been spent and ${usd(spend.inFlightUsd)} was set aside for work ` +
    `under way, ${next}; the limit is ${usd(spend.capUsd)}.`
  );
}

/**
 * What the episode's recorded kind says paused the project, in the client's words: only what every
 * halt recorded with that kind is by definition (ProjectBlockCategory), stated as Ashara's own
 * record, so a misrecorded kind reads as Ashara's record and not as an observed fact.
 */
function recordedKind(halt: ToldHalt): string {
  switch (halt.kind) {
    case "budget_cap":
      return spendLimitStopped(halt.limit);
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
    case "replan_stopped":
      return "every attempt to revise the plan failed, the last because the model planning it gave no usable answer";
    case "replan_provider_failed":
      return "every attempt to revise the plan failed, the last because the service that runs the model planning it returned an error or did not answer, so no answer was read";
    case "model_failed":
      return "a step of the work kept failing because the model doing it gave no usable answer";
    case "provider_failed":
      return "a step of the work kept failing because the service that runs the model doing it returned an error or did not answer, so no answer was read";
    case "work_budget":
      return halt.work?.reserveProtected === true
        ? "the budget of model requests set for this project was used up except for the share set aside for checking and accepting the " +
            "finished work, which is kept for that, so the next step of the work, which was not that checking, was not sent"
        : "the budget of model requests set for this project was used up, so the next step of the work was not sent";
  }
}

/**
 * The cause in the client's words, from the episode's recorded kind; the record's own text (the error
 * class and its chain) stays in project_blocks for the operator, and the report names that record
 * instead of quoting Ashara's internal class names. A halt with no cause recorded says so.
 */
function recordedCause(episodeId: string, halt: ToldHalt, cause: RecordedCause): string {
  if (cause.reason === null && cause.errorClass === null) return "No cause was recorded for this pause.";
  return (
    `Ashara recorded the cause as this: ${recordedKind(halt)}. ` +
    (halt.kind === "budget_cap" ? `${spendFigures(halt.spend)} ` : "") +
    (halt.kind === "work_budget" ? `${workFigures(halt.work)} ` : "") +
    `Ashara keeps the technical detail in its own record of this pause, record ${episodeId}.`
  );
}

const WAITS_ON_OPERATOR = "Until then nothing more is done on this project. The team is waiting on its operator for this, and you will be told when work resumes.";

/** What has to be raised for a budget_cap halt to end: the limit that stopped the work, as recorded. */
function limitToRaise(limit: SpendLimit): string {
  switch (limit) {
    case "deployment":
      return "The spending limit for all of Ashara's work has to be raised before more is spent on any project, this one included.";
    case "project":
      return "The budget set for this project has to be raised before more is spent.";
    case "unrecorded":
      return "The spending limit that stopped the work has to be raised before more is spent.";
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
    case "replan_stopped":
    case "replan_provider_failed":
      return `The team has to look into it before the plan is revised again. ${WAITS_ON_OPERATOR}`;
    case "model_failed":
    case "provider_failed":
      return `The team has to look into it before that step is tried again. ${WAITS_ON_OPERATOR}`;
    case "replan_bound":
      return `Your latest change is recorded, and the plan is revised for it once the operator has looked the project over. ${WAITS_ON_OPERATOR}`;
    case "work_budget":
      return `More model requests have to be granted to this project before more work is done. ${WAITS_ON_OPERATOR}`;
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

/** Plain words: what stopped, why, and what the client can do (a halt kind only older records hold). */
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

/** Plain words: what stopped, what the review found, and what the client can do (a halt kind only older records hold). */
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

/**
 * Why a task was given up, as its stored reason's source records it, in the client's words: only
 * what every reason of that source is by definition. The reason's own text is Ashara's internal
 * wording and stays on the task's record, which the report names.
 */
function givenUpCategory(cause: StoredBlockedReason): string {
  switch (cause.source) {
    case "failure_given_up":
    case "task_failed":
    case "replan":
      return "its attempts at the work did not succeed";
    case "orchestrator_error":
    case "orphan_unreconciled":
      return "a step of Ashara's own work on it failed";
    case "merge_unrecorded":
      return "its work is on the project's main line, but Ashara could not record that";
    case "environment_unavailable":
      return "the machines Ashara runs the work on were not available for it";
    case "environment_undefined":
      return "the project's environment, in which it is built and tested, was not defined or could not be built";
    case "environment_change_needed":
      return "it needed a change to how the project is built and tested, and no such change was made for it";
    case "checks_stale":
    case "checks_rewrite_bound":
      return "the checks that decide it no longer held on the project's environment and could not be written again";
    case "check_disputed":
      return "its developer found that a check written for it cannot be passed by correct work, and that could not be settled";
    case "suite_review_unresolved":
      return "the review of the plan's checks found problems that could not be settled";
    case "work_budget_spent":
      return "it used every model request the budget of one task allows";
    case "context_window_exceeded":
    case "no_wider_model":
      return "the work it was given was more than any model available to the team can hold in view at once";
    case "crash_loop":
      return "Ashara's own process stopped while working on it, each time it was tried";
    case "owner_unresolved":
      return "no member of the team is assigned to do it";
    case "dependency_unsatisfiable":
      return "it depends on work that can never be finished";
    case "acceptance_failed":
      return cause.mainCommit === null
        ? "the final check of the whole project could not read the project's main line"
        : "the final check of the whole project did not pass on the project's main line";
    case "correction_pending":
      return "the client's correction changed what it rests on, and a revision of the plan replaces it";
    case "superseded":
      return "a revision of the plan replaced it";
    case "api":
      return "it was moved by hand through Ashara's API";
  }
}

/** Plain words: which work the team gave up again and the recorded cause of each, and what can resume the project. */
function planRepairBoundReport(abandoned: readonly BlockingAbandonment[]): string {
  return [
    `Work on this project has stopped: the team cannot deliver it as planned. The plan has already been revised around ` +
      `work it gave up as many times as the team revises it on its own, and it gave up again:`,
    abandoned
      .map(
        (task) =>
          `- "${task.title}", after ${plural(task.attempts, "attempt")} counted against it. Ashara recorded why it was given up as this: ` +
          `${givenUpCategory(task.cause)}. Ashara keeps the detail in its own record of that task, record ${task.workItemId}.`,
      )
      .join("\n"),
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

function haltBody(due: Extract<DueBlockReport, { readonly subject: "project-blocked" }>): string {
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

/** A halt's report: what paused the project, then the guarantee table of its terminal sweep. */
function blockedBody(due: Extract<DueBlockReport, { readonly subject: "project-blocked" }>): string {
  return `${haltBody(due)}\n\n${guaranteeSection(due.guarantees)}`;
}

export class BlockReports implements LiaisonBlockReports {
  constructor(
    private readonly store: BlockReportStore,
    /** Each report's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * A report that cannot be read or posted is that report's, contained to it (containEach); only a
   * failure of the listing as a whole throws through.
   */
  async runPending(): Promise<ReadonlyArray<BlockReportOutcome | StepFaulted>> {
    const due = await this.store.dueReports();
    return containEach(
      this.containment,
      "block-report",
      due,
      (report) => ({ id: `${report.subject}:${report.episodeId}`, projectId: report.projectId }),
      async (report): Promise<BlockReportOutcome> => {
        switch (report.subject) {
          case "project-blocked": {
            const kind = await this.store.postProjectReport(
              report.episodeId,
              "blocked",
              await this.withRegister(report.projectId, blockedBody(report)),
              tableVerdicts(report.guarantees),
            );
            return { kind, projectId: report.projectId, subject: report.subject };
          }
          case "project-resumed": {
            const kind = await this.store.postProjectReport(
              report.episodeId,
              "resumed",
              await this.withRegister(report.projectId, projectResumedReport(report.how)),
              null,
            );
            return { kind, projectId: report.projectId, subject: report.subject };
          }
        }
      },
    );
  }

  /** The report's body with the register of guarantees at risk as its last paragraph. */
  private async withRegister(projectId: ProjectId, body: string): Promise<string> {
    const register = registerOf(await this.store.riskRecords(projectId));
    return `${body}\n\n${registerParagraph(projectId, register)}`;
  }
}
