import { z } from "zod";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { DomainEvent, Logger, ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { isGoalTask } from "./predicates.js";
import { higherCapability, withStructuredLadder } from "./acl/finance-acl.js";
import type { CapabilityLevel, LadderAttemptEvent } from "./acl/finance-acl.js";
import { blockedReasonToRecord } from "./work-item-language/blocked-reason.js";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import { OPEN_WORK_ITEM_STATUSES, SETTLED_WORK_ITEM_STATUSES, type WorkItemStatus } from "./work-item-language/work-item-status.js";
import { projectBlockCause, recordedFailureOf } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { VisionUnreadable, planningVisionOf } from "./acl/engagement-acl.js";
import { modelCallFailureOf } from "./acl/finance-acl.js";
import type { ContextualLlm, ModelCallFailure } from "./acl/finance-acl.js";
import { RosterUnreadable, WorkKindOwnerUnresolved } from "./acl/organization-acl.js";
import type { PlanningVision, StoredVision } from "./acl/engagement-acl.js";
import type { BulkPlanEdge } from "./bulk-plan.js";
import { DecompositionEngine } from "./decomposition.js";
import { VisionItemsMissing, itemsToCheck } from "./decomposition-types.js";
import type { DecompositionInput, DecompositionResult, EnvironmentPlanning, LayoutPlanning, VisionItem } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import { supersedeWorkItem, takeEvents } from "./domain/index.js";
import type { FirstPlanWrite } from "./first-plan.js";
import { planOwners, toWrite } from "./first-plan.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

// Delivery's revision of a plan already under way, asked for in one of two ways. A client's
// correction (a change, a confirmed proposal, or an answer that changed an assumption) holds only the
// tasks citing a guarantee or assumption key it affects (correction_holds): each is parked whenever it
// is Pending, and one in progress finishes its attempt and may merge; the rest of the project goes on dispatching; every correction
// awaiting a revision is taken in by the next one, and its report names each, since each was promised
// the client would hear what it changed. Once no task citing an affected key is in progress, only the
// affected keys and the items of the work replaced are planned again: the open tasks citing an
// affected key, and the open tasks waiting on them, are superseded; merged work citing one (Completed,
// or Blocked as merge_unrecorded) is kept, and its key, as the vision now states it, gets a new task. A task given up, for any cause
// (the failure router's attempt bound, a dispute or review bound, the environment-change bound, an
// unsatisfiable dependency), opens a plan repair, which stops the project's dispatch: no person
// releases its dependents. Once no task of the project is in progress, the current vision is
// decomposed again with the completed work and the given-up work and its evidence as context:
// merged work is kept, open work (not started, Blocked or Failed, and the Epic that held it) is
// superseded. Either way the new tasks build on the environment already set up unless an
// environment change is needed. Revision, supersession and what it took in commit together; the
// Liaison reports the revision from what is recorded.

/** Failed attempts to revise the plan for one request after which Delivery stops and blocks the project. */
const MAX_REPLAN_ATTEMPTS = 3;

/** Revisions for client corrections Delivery writes before the operator reviews the project; the next one blocks it. */
const MAX_REVISIONS_PER_REVIEW = 3;

/**
 * Plan repairs Delivery writes before the project halts as undeliverable (R = 2):
 * past it the same work is being given up again, and the next give-up halts the
 * project (a plan_repair block) with one report naming the work given up and why. Counted since the
 * owner last reviewed such a halt.
 */
const MAX_REPAIRS_PER_REVIEW = 2;

/** Longest part of a given-up task's recorded failure the planner is shown. */
const MAX_ABANDONMENT_EVIDENCE_CHARS = 3000;

/**
 * The catalog grade of the model that last completed an attempt of a task, as the store reads it,
 * or why none is on record.
 */
export type AttemptGrade =
  | { readonly kind: "graded"; readonly model: string; readonly grade: CapabilityLevel }
  | { readonly kind: "unrecorded"; readonly why: string };

/** One of the project's work items as the store reads it, with what was merged for it. */
interface PlannedItem {
  readonly item: WorkItem;
  /** The merge commit on the target's main; null when none is recorded. */
  readonly mergeCommit: string | null;
  /** The grade of the model its completed work was done on. */
  readonly attemptGrade: AttemptGrade;
  /** A Sprint 0 task's statement of the environment it set up; null when none is recorded. */
  readonly environmentStatement: string | null;
  /**
   * The vision items its latest stored checks decide (task_checks.decides), each as
   * its check task cites it; empty when it has no stored checks or they record no items they decide.
   */
  readonly decided: readonly VisionItem[];
}

/** A task given up whose repair the project awaits (plan_repairs). */
interface AbandonedTask {
  readonly id: string;
  readonly title: string;
  /** Its dispatches, the failed ones that led to its abandonment. */
  readonly attempts: number;
  /** Why it was given up and its last failure, as its blocked_reason recorded them. */
  readonly evidence: string;
}

/** The cause a given-up task records: any but a plan revision's supersession. */
type GivenUpReason = Exclude<StoredBlockedReason, { readonly source: "superseded" }>;

/** A project awaiting a revision with no task in progress and no unread answer, as the store reads it. */
interface ProjectAwaitingReplan {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** The client corrections whose revision the project awaits (correction_holds), oldest first; empty when only repairs are awaited. */
  readonly correctionsAwaited: readonly CorrectionRequest[];
  /** The ids of the tasks given up whose repair the project awaits (plan_repairs), oldest first; empty when none. */
  readonly repairsAwaited: readonly string[];
  /** The project's current vision as stored; what a correction changed is read from it. */
  readonly vision: StoredVision;
  /** The project's dependency edges: the work item `fromId` waits on `toId`. */
  readonly dependencies: ReadonlyArray<{ readonly fromId: string; readonly toId: string }>;
  readonly rosterRows: unknown;
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  /** Whose failure the last counted attempt was, as stored; read by recordedFailureOf. */
  readonly replanLastFailure: string | null;
  /** Revisions for client corrections written since the operator last reviewed a replan_bound block (all of them when never). */
  readonly revisionsSinceReview: number;
  /** Plan repairs written since the operator last reviewed a plan_repair block (all of them when never). */
  readonly repairsSinceReview: number;
  /** The number the next revision takes; the first plan is revision 1. */
  readonly nextRevision: number;
  readonly items: readonly PlannedItem[];
}

/** What asked for a revision: the client's corrections, in the order they were recorded, or tasks given up. */
type RevisionCause =
  | { readonly kind: "client-change"; readonly changes: readonly [CorrectionRequest, ...CorrectionRequest[]] }
  | { readonly kind: "repair"; readonly abandoned: readonly AbandonedTask[] };

/** The part of a revision's summary that says what it planned, whatever asked for it. */
interface PlanRevisionWork {
  readonly newTasks: readonly string[];
  readonly newCheckTasks: number;
  /** Review tasks of the revision, each reading every suite its check tasks store together before building starts. */
  readonly newReviewTasks: number;
  /** Whether the revision sets up the project environment again (an environment change). */
  readonly newEnvironmentTask: boolean;
  readonly supersededTasks: readonly string[];
  /** Superseded tasks that are not goal tasks (isGoalTask): check, review and setup tasks, and any whose origin was never recorded. */
  readonly supersededOther: number;
  readonly keptCompleted: number;
}

/** One change a revision took in: the client's words and what work now proceeds on. */
interface RevisionChange {
  /** The client's words, as the message that asked for the change carries them. */
  readonly answer: string;
  /** What work now proceeds on, as the vision states it. */
  readonly decision: string;
}

/**
 * What a revision did, recorded with it (plan_revisions.summary) for the Liaison's report.
 * Titles are the client's goal tasks; check and environment tasks are counted apart. A revision
 * for the client's corrections carries every change it took in, in the order they were recorded;
 * a repair, the titles of the tasks given up.
 */
type PlanRevisionSummary = PlanRevisionWork &
  ({ readonly changes: readonly [RevisionChange, ...RevisionChange[]] } | { readonly repaired: readonly string[] });

/**
 * The corrections a revision takes in, by the vision version each wrote, with the client message its
 * report replies to (the earliest) and every guarantee or assumption key they affect.
 */
interface RevisionCorrections {
  readonly versions: readonly [number, ...number[]];
  readonly requestedBy: string;
  readonly affected: readonly string[];
}

/** A superseded item with the status it was read in: the write refuses it if the row moved since. */
interface SupersededItem {
  readonly item: WorkItem;
  readonly previousStatus: WorkItemStatus;
}

interface PlanRevisionWrite {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly visionVersion: number;
  /** The client corrections the revision takes in, in the order they were recorded; null for a plan repair. */
  readonly corrections: RevisionCorrections | null;
  /** The given-up tasks whose awaited repair the revision records, whatever asked for it. */
  readonly repaired: readonly string[];
  readonly superseded: readonly SupersededItem[];
  /** The new items, edges between them by temp id, and owners, as a first plan writes them. */
  readonly plan: FirstPlanWrite;
  /** Edges from a new item (temp id) to work already on record (its id): the environment kept, a kept task's check tasks its review reads. */
  readonly existingEdges: readonly BulkPlanEdge[];
  /** Kept tasks whose wait on a superseded review (`from`) moves to the revision's review (`toTempId`). */
  readonly regated: ReadonlyArray<{ readonly taskId: string; readonly from: string; readonly toTempId: string }>;
  readonly events: readonly DomainEvent[];
  readonly summary: PlanRevisionSummary;
}

/** Delivery's persistence port for plan revisions. Each method is one transaction. */
export interface ReplanStore {
  /** Every project awaiting a revision, each read on its own: one whose rows do not read is its UnreadSubject. */
  projectsAwaitingReplan(): Promise<ReadonlyArray<ProjectAwaitingReplan | UnreadSubject>>;
  /**
   * Supersedes the items it replaces, writes the new ones, records the revision and records the
   * client's corrections and the repairs it takes in, together; "moved" and nothing written when the
   * project, its vision, the corrections it awaits or an item read for it changed since it was read
   * (a task started, a correction arrived).
   */
  writeRevision(write: PlanRevisionWrite): Promise<"written" | "moved">;
  /** Counts a failed attempt with its error and whose failure it was; returns the count after it. */
  recordFailedAttempt(projectId: ProjectId, error: string, failure: RevisionFailure): Promise<number>;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type ReplanOutcome =
  | {
      readonly kind: "revised";
      readonly projectId: ProjectId;
      readonly revision: number;
      readonly cause: RevisionCause["kind"];
      readonly tasks: number;
      readonly superseded: number;
      readonly newEnvironment: boolean;
    }
  /** Something read for the revision changed before it was written; it is tried again next cycle. */
  | { readonly kind: "moved"; readonly projectId: ProjectId }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  | StepFaulted;

/** What the core loop asks of Delivery's planning each cycle, after the first plans. */
export interface Replanning {
  runPending(): Promise<readonly ReplanOutcome[]>;
}

/** A revision keeps tasks that waited on a review it supersedes, and plans no review of its own for them to wait on. */
class RevisionReviewMissing extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskIds: readonly string[],
  ) {
    super(`plan revision of project ${projectId}: task(s) ${taskIds.join(", ")} wait on a review it supersedes, and it plans no review of its own`);
    this.name = "RevisionReviewMissing";
  }
}

/** The project's plan was revised its bound of times since the operator last reviewed it. */
class ReplanBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisions: number,
    readonly messages: readonly string[],
  ) {
    super(
      `project ${projectId}: the plan was revised ${revisions} time(s) for client corrections since the operator last ` +
        `reviewed it, the bound of ${MAX_REVISIONS_PER_REVIEW}; the correction(s) of message(s) ${messages.join(", ")} are not ` +
        `planned until the operator reviews the project and unblocks it`,
    );
    this.name = "ReplanBoundReached";
  }
}

/** The project's plan was repaired its bound of times since the operator last reviewed it, and a task was given up again. */
class PlanRepairBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly repairs: number,
    readonly abandoned: readonly AbandonedTask[],
  ) {
    super(
      `project ${projectId}: the plan was repaired ${repairs} time(s) since the operator last reviewed it, the bound of ` +
        `${MAX_REPAIRS_PER_REVIEW}, and the team gave up again: ` +
        abandoned.map((task) => `"${task.title}" (${task.id}) after ${task.attempts} attempt(s): ${firstLine(task.evidence)}`).join("; ") +
        `; the project halts as undeliverable: the remaining work is not planned again until the client changes ` +
        `the scope or the owner reviews the project and unblocks it`,
    );
    this.name = "PlanRepairBoundReached";
  }
}

/** Whose failure a counted revision attempt was: Ashara's own is never counted (Replanner.revise). */
type RevisionFailure = Exclude<ModelCallFailure, "ashara">;

/**
 * The halt an exhausted revision records, by whose failure its last attempt was: the cycle that
 * counted it classified it (modelCallFailureOf), and a later cycle reads it back from the record
 * (recordedFailureOf), so both halt the same. A last failure that names no party is Ashara's (`fault`).
 * @testseam exported for the integration fault-classifiers.test.ts; Replanner.revise is its production caller
 */
export function exhaustedRevisionCause(projectId: ProjectId, attempts: number, lastError: string, failure: ModelCallFailure): ProjectBlockCause {
  const cause = projectBlockCause(new ReplanAttemptsExhausted(projectId, attempts, lastError, failure));
  switch (failure) {
    case "model":
      return { ...cause, category: "replan_stopped" };
    case "provider":
      return { ...cause, category: "replan_provider_failed" };
    case "ashara":
      return cause;
  }
}

/**
 * Revising the plan failed on every attempt: the change is not planned, and the old plan is not
 * dispatched past it. `failure` is whose failure the last attempt was.
 */
class ReplanAttemptsExhausted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
    readonly lastError: string,
    readonly failure: ModelCallFailure,
  ) {
    super(`project ${projectId}: the plan could not be revised after ${attempts} attempt(s); last error: ${lastError}`);
    this.name = "ReplanAttemptsExhausted";
  }
}

/**
 * The project has spent its revision attempts but holds no error for them. A database CHECK
 * constraint makes this unrepresentable; meeting it means the store lied.
 */
class ReplanFailureUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
  ) {
    super(`project ${projectId} has ${attempts} failed plan revision attempts but no recorded error`);
    this.name = "ReplanFailureUnrecorded";
  }
}

/**
 * A completed task whose work a revision judges carries no capability level in its task_spec: no
 * judge can be asked at or above work whose tier is unknown, so nothing is judged.
 */
class JudgedTaskUngraded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskId: string,
    readonly origin: string | undefined,
  ) {
    super(
      `project ${projectId}: task ${taskId} (origin ${origin ?? "unrecorded"}) carries no capability level in its task_spec; ` +
        `the revision cannot ask a judge of its work at or above it`,
    );
    this.name = "JudgedTaskUngraded";
  }
}

/** The store listed a project awaiting a revision that neither a client correction nor a repair asks for. */
class RevisionUnasked extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`project ${projectId}: listed as awaiting a plan revision, but no client correction and no given-up task asks for one`);
    this.name = "RevisionUnasked";
  }
}

/** A client correction awaiting its revision (correction_holds): the client's words and the keys it affects. */
interface CorrectionRequest {
  /** The vision version the correction wrote. */
  readonly visionVersion: number;
  /** The client message it answers: the change, its confirmation or the answer. */
  readonly requestedBy: string;
  /** That message's words. */
  readonly words: string;
  /** The guarantee and assumption keys it affects. */
  readonly affected: readonly [string, ...string[]];
}

/** An awaited repair names a task that is not an Abandoned task of the project given up for a recorded cause. */
class RepairSubjectUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskId: string,
    readonly detail: string,
  ) {
    super(`project ${projectId}: a plan repair is awaited for task ${taskId}, but ${detail}`);
    this.name = "RepairSubjectUnreadable";
  }
}

/** What a given-up task's blocked_reason recorded of why, for the planner; prefixed by the cause. */
function givenUpEvidence(reason: GivenUpReason): string {
  switch (reason.source) {
    case "failure_given_up": {
      const lastFailure = reason.lastFailure === undefined ? [] : [`Last failure: ${JSON.stringify(reason.lastFailure)}`];
      const detail = reason.detail === undefined ? [] : [reason.detail];
      return [`Its attempts were spent: ${reason.reason}`, ...detail, ...lastFailure].join("\n");
    }
    case "replan":
      return `Given up after a failed attempt: ${reason.replanContext.detail}`;
    case "api":
      return `Given up by an operator: ${JSON.stringify(blockedReasonToRecord(reason))}`;
    case "environment_unavailable":
      return `The machines it ran on kept failing (${reason.unavailable}): ${reason.reason}`;
    case "checks_stale":
    case "checks_rewrite_bound":
      return `Its checks no longer hold on the project's environment: ${reason.reason}`;
    case "check_disputed":
      return `Its implementer disputed check ${JSON.stringify(reason.checkName)} past what the team settles: ${reason.reason}`;
    case "suite_review_unresolved":
      return `The review of the plan's checks kept finding problems: ${reason.reason}`;
    case "environment_change_needed":
      return `It needs an environment change (${reason.paths.join(", ")}) the team could not make for it: ${reason.reason}`;
    case "dependency_unsatisfiable":
      return `It depends on work that can never complete: ${reason.reason}`;
    case "environment_undefined":
      return `The project's environment on main is not one its cells can be built from: ${reason.reason}`;
    case "owner_unresolved":
      return `No role of the team's roster could be assigned it (owner ${reason.ownerRoleId ?? "none"}): ${reason.reason}`;
    case "acceptance_failed":
      return (
        `Every task of the plan was done, but the acceptance run on main ` +
        `(${reason.mainCommit === null ? "main could not be read" : `commit ${reason.mainCommit}`}) of the ` +
        `environment's test and every completed task's checks did not pass, or could not be carried out:\n${reason.reason}`
      );
    case "orphan_unreconciled":
      return `Ashara's own machinery could not settle it after a restart (${reason.step}): ${reason.reason}`;
    case "work_budget_spent":
      return `It drew every model request its work budget holds (${reason.drawnRequests} of ${reason.budgetRequests}): ${reason.reason}`;
    case "context_window_exceeded":
      return (
        `A turn of its work did not fit the ${reason.windowTokens}-token context window of ${reason.provider}/${reason.model}` +
        `${reason.projectedInputTokens === null ? "" : ` (a projected input of ${reason.projectedInputTokens} tokens)`}, ` +
        `and no model graded for it has a larger one: ${reason.reason}`
      );
    case "no_wider_model":
      return (
        `An attempt of its work overflowed a ${reason.overflowedWindowTokens}-token context window, ` +
        `and no model graded for it now has a larger one: ${reason.reason}`
      );
    case "crash_loop":
      return `Ashara's process died while it was in progress at ${reason.boots} startups in a row, so it is not dispatched again: ${reason.reason}`;
    case "task_failed":
    case "orchestrator_error":
    case "merge_unrecorded":
    case "correction_pending":
      return reason.reason;
  }
}

/** The given-up tasks a repair answers, with what their blocked_reason recorded of why. */
function abandonedOf(project: ProjectAwaitingReplan): AbandonedTask[] {
  return project.repairsAwaited.map((id) => {
    const planned = project.items.find(({ item }) => item.id === id);
    if (planned === undefined) throw new RepairSubjectUnreadable(project.projectId, id, "it is not a work item of the project");
    const { item } = planned;
    const reason = item.blockedReason;
    if (item.status !== "Abandoned" || reason === undefined || reason.source === "superseded") {
      throw new RepairSubjectUnreadable(project.projectId, id, `it is ${item.status} with ${reason?.source ?? "no"} blocked reason, not given up`);
    }
    return {
      id,
      title: item.title,
      attempts: reason.source === "failure_given_up" ? (reason.attempts ?? item.dispatchCount) : item.dispatchCount,
      evidence: givenUpEvidence(reason),
    };
  });
}

/**
 * The client's corrections come first: their revision waits only for the work they touch, where a
 * repair's waits for every task. Every correction awaiting a revision is taken in by this one, each a
 * change on record; a repair still awaited is planned by the next.
 */
function causeOf(project: ProjectAwaitingReplan): RevisionCause {
  const [first, ...rest] = project.correctionsAwaited;
  if (first !== undefined) return { kind: "client-change", changes: [first, ...rest] };
  if (project.repairsAwaited.length === 0) throw new RevisionUnasked(project.projectId);
  return { kind: "repair", abandoned: abandonedOf(project) };
}

/** Every key the corrections affect, each once, in the order first named. */
function affectedKeys(changes: readonly CorrectionRequest[]): string[] {
  return [...new Set(changes.flatMap((change) => change.affected))];
}

/** What work now proceeds on after a correction: each item it affects as the vision now states it, or that it is withdrawn. */
function decisionOf(change: CorrectionRequest, vision: PlanningVision): string {
  return change.affected
    .map((key) => {
      const item = vision.items.find((each) => each.id === key);
      return item === undefined ? `${key} is withdrawn.` : item.text;
    })
    .join("\n");
}

/** The changes as the summary records them: the client's words and the decision, in the order recorded. */
function revisionChanges(changes: readonly [CorrectionRequest, ...CorrectionRequest[]], vision: PlanningVision): readonly [RevisionChange, ...RevisionChange[]] {
  const [first, ...rest] = changes;
  const recorded = (change: CorrectionRequest): RevisionChange => ({ answer: change.words, decision: decisionOf(change, vision) });
  return [recorded(first), ...rest.map(recorded)];
}

function firstLine(text: string): string {
  // split returns at least one element, the whole text when it holds no newline.
  return text.split("\n")[0];
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} of ${text.length} characters not shown]`;
}

/** The given-up tasks as the planner reads them: what was tried, how often, and why it failed. */
function abandonmentSection(abandoned: readonly AbandonedTask[]): string {
  return [
    `The team gave up ${abandoned.length === 1 ? "a task" : `${abandoned.length} tasks`} of the plan after its attempts failed:`,
    ...abandoned.map((task) => `- "${task.title}", after ${task.attempts} attempt(s). Evidence:\n${cut(task.evidence, MAX_ABANDONMENT_EVIDENCE_CHARS)}`),
  ].join("\n");
}

/** One change as the planner reads it: the client's words and what work now proceeds on. */
function changeLines(change: CorrectionRequest, vision: PlanningVision): string {
  return `The client wrote: ${change.words}\nWork now proceeds on:\n${decisionOf(change, vision)}`;
}

/** What the revision is asked for, as the planner reads it beside the vision items it plans. */
function causeSection(cause: RevisionCause, vision: PlanningVision): string {
  if (cause.kind === "client-change") {
    const replanned =
      `Only the work these changes touch is planned again: the rest of the plan stands and goes on. ` +
      `Plan tasks for the vision items listed below, building on the work already done.`;
    return cause.changes.length === 1
      ? `The client changed what is built after work began. ${changeLines(cause.changes[0], vision)}\n${replanned}`
      : `The client changed what is built after work began, in ${cause.changes.length} messages; plan for every one of them.\n` +
          cause.changes.map((change, i) => `Change ${i + 1}. ${changeLines(change, vision)}`).join("\n") +
          `\n${replanned}`;
  }
  return (
    `${abandonmentSection(cause.abandoned)}\n` +
    `Plan the work still to do again so that the vision is still delivered: the given-up work is not done, and its ` +
    `evidence shows what to do differently. Plan small tasks, each a complete behaviour a user can use and observe.`
  );
}

export const EnvironmentJudgmentSchema = z.strictObject({ environmentChange: z.boolean(), reason: z.string().min(1) });

function environmentPrompt(cause: RevisionCause, statement: string | null, vision: PlanningVision): string {
  const situation =
    cause.kind === "client-change"
      ? [
          `After work on a project began, the client changed what is built.`,
          `Say whether ${cause.changes.length === 1 ? "this change" : `what the client changed, in ${cause.changes.length} messages taken together,`} needs the project environment changed: how the project is built and tested, the`,
          `technology it is built with, or the tools its build and tests run on. A change to what the product does that`,
          `the environment as it is can build and test is not an environment change.`,
          ...cause.changes.flatMap((change) => [
            ``,
            `The client's words:`,
            JSON.stringify(change.words),
            ``,
            `What work now proceeds on:`,
            JSON.stringify(decisionOf(change, vision)),
          ]),
        ]
      : [
          `Work on a project stopped: the team gave up work after its attempts failed. Say whether the evidence shows`,
          `that the project environment must be changed for the remaining work to succeed: how the project is built and`,
          `tested, the technology it is built with, or the tools its build and tests run on (for example a build tool`,
          `that cannot write where the environment makes it write). A failure of the work itself is not an environment change.`,
          ``,
          abandonmentSection(cause.abandoned),
        ];
  return [
    `You are the planner of a software contractor.`,
    ...situation,
    ``,
    `The project environment, as the team stated it when it set it up:`,
    JSON.stringify(statement ?? "(no statement recorded)"),
    ``,
    `Return exactly {"environmentChange": true or false, "reason": "..."} with one sentence of reason.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
  ].join("\n");
}

function judgmentReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. No markdown, no explanatory prose.`
  );
}

function isTask(planned: PlannedItem): boolean {
  return planned.item.level === "Task";
}

/** A work item read as isGoalTask reads its row: the level and the task_spec.origin, null where none is recorded. */
function goalTask(item: WorkItem): boolean {
  return isGoalTask({ level: item.level, origin: item.taskSpec?.origin ?? null });
}

/**
 * The superseded tasks as a revision's summary tells them: each goal task (isGoalTask) by title, as
 * the revision's new goal tasks are; every other task (a check, review or setup task, or one whose
 * origin was never recorded) only counted.
 *
 * @testseam replan.test.ts classifies superseded tasks without a model; Replanner.compose is its production caller
 */
export function setAsideWork(tasks: readonly WorkItem[]): { readonly supersededTasks: readonly string[]; readonly supersededOther: number } {
  return {
    supersededTasks: tasks.filter(goalTask).map((item) => item.title),
    supersededOther: tasks.filter((item) => !goalTask(item)).length,
  };
}

function isEnvironmentTask(item: WorkItem): boolean {
  return item.workKind === "environment" || item.taskSpec?.origin === "sprint0";
}

/**
 * The product layout a revision builds on, or a new one when no scaffold
 * completed (an open one is superseded with the rest). Built on, its taskId is the layout's latest
 * merged state: of the latest completed product scaffold and every task with a merge on record that
 * completed after it, the last to complete. Never a task merged before the scaffold, whose commit
 * holds no product to build. A Completed task with a merge takes no later transition (only
 * a check task is reopened, and nothing of it is merged), so its updatedAt is when it completed.
 */
function layoutOf(completed: readonly PlannedItem[]): LayoutPlanning {
  const scaffolds = completed.filter(({ item }) => item.taskSpec?.origin === "product-scaffold");
  const scaffold = scaffolds[scaffolds.length - 1];
  if (scaffold === undefined) return { kind: "new" };
  let latest = scaffold;
  for (const planned of completed) {
    if (planned.mergeCommit === null) continue;
    if (planned.item.updatedAt.getTime() > latest.item.updatedAt.getTime()) latest = planned;
  }
  return { kind: "existing", taskId: latest.item.id };
}

/**
 * The vision items the stored checks of a completed goal task (isGoalTask) decide, so a revision
 * need not give them a task again. What the task cites is never read here: an item it cites that no
 * stored check decides, a check stored before decides was recorded or a task completed with no
 * stored checks, is planned again. A key a correction the revision answers affects is never among
 * them: every stored check was written against the contract before that correction, and a key's text
 * can stand unchanged while what it rests on changed (an interface entry it is observed at, an
 * exclusion), so a check deciding it decides the old contract, not the corrected one.
 */
function checkedByDone(completed: readonly PlannedItem[], cause: RevisionCause): VisionItem[] {
  const affected = new Set(cause.kind === "client-change" ? affectedKeys(cause.changes) : []);
  return completed.flatMap(({ item, decided }) => (goalTask(item) ? decided.filter((done) => !affected.has(done.id)) : []));
}

/** The work already done, kept as the revision's context: titles and what merged them. */
function doneSection(completed: readonly PlannedItem[]): string {
  if (completed.length === 0) return "Already done: nothing yet.";
  const lines = completed.map(({ item, mergeCommit }) =>
    mergeCommit === null ? `- ${item.title}` : `- ${item.title} (merged as ${mergeCommit})`,
  );
  return `Already done, and kept as it is (plan only what is still to do, building on it):\n${lines.join("\n")}`;
}

/** What a revision replaces and plans again. */
interface RevisionScope {
  /** A task in progress the revision waits for; null when it waits for none. */
  readonly waitsOn: PlannedItem | null;
  /** The open tasks and Epics it supersedes. */
  readonly replaced: readonly PlannedItem[];
  /** The vision items it plans again, as the current vision states them. */
  readonly planned: readonly VisionItem[];
  /** Open tasks it keeps that waited on a review task it supersedes: each waits on the revision's own review instead. */
  readonly regated: readonly RegatedTask[];
}

/** A kept task moved off a superseded review task onto the revision's own review. */
interface RegatedTask {
  readonly taskId: string;
  /** The superseded review task it waited on. */
  readonly review: string;
  /** Its own check tasks, kept: the revision's review reads their suites with its own. */
  readonly checkTasks: readonly string[];
}

/**
 * Open and not in progress: work a revision may supersede, since an attempt in progress is waited
 * on instead. A task Blocked as merge_unrecorded is merged work, its code on main and only its record
 * unwritten, so it is kept as a Completed task is (its exit completes it): a correction citing its
 * key plans that key again beside it.
 */
function isSupersedable(item: WorkItem): boolean {
  if (!OPEN_WORK_ITEM_STATUSES.includes(item.status) || item.status === "InProgress") return false;
  return item.status !== "Blocked" || item.blockedReason?.source !== "merge_unrecorded";
}

/** Not settled: an Epic a revision may still close or keep. */
function isUnsettled(item: WorkItem): boolean {
  return !SETTLED_WORK_ITEM_STATUSES.includes(item.status);
}

/** The vision keys a task cites in its task_spec's sources; none when its spec records no sources. */
function citedKeys(item: WorkItem): string[] {
  const sources = item.taskSpec?.sources;
  return sources === undefined ? [] : sources.map((source) => source.id);
}

/**
 * A repair's scope: the whole plan. It waits for every task in progress, supersedes every open task
 * and every open Epic (the revision writes its own), and plans the whole current vision again.
 */
function wholePlanScope(project: ProjectAwaitingReplan, vision: PlanningVision): RevisionScope {
  const tasks = project.items.filter(isTask);
  const openEpics = project.items.filter(({ item }) => item.level === "Epic" && isUnsettled(item));
  return {
    waitsOn: tasks.find(({ item }) => item.status === "InProgress") ?? null,
    replaced: [...tasks.filter(({ item }) => isSupersedable(item)), ...openEpics],
    planned: vision.items,
    regated: [],
  };
}

/**
 * A correction's scope: only the work citing a key it affects. It waits for a task citing one that is
 * in progress and for no other; it supersedes the open tasks citing one, and every open task waiting
 * on those, directly or not, which would otherwise wait on work never done; and it plans again the
 * affected keys still in the vision and every item the work it supersedes, a review aside, cited. Two waits are not
 * passed on, since the work behind them is not changed: a superseded check task gates only the task it
 * checks, as dependency resolution reads it; and a task citing no affected key that waits on a
 * superseded review task is kept, moved to wait on the revision's own review (regated), unless the
 * revision plans nothing and so writes no review, when it is replaced with the review. Merged work
 * citing an affected key is kept (isSupersedable), a held task that finished its attempt and merged included: its key is not decided by the checks it merged with, which
 * decide the contract before the correction (checkedByDone), so it is planned again. An
 * open environment or layout task is replaced too while none is completed, since the revision then
 * plans its own. An open Epic left with no open task of its own is closed with the work it held,
 * since nothing would settle it.
 */
function correctionScope(project: ProjectAwaitingReplan, affected: readonly string[], vision: PlanningVision, checked: readonly VisionItem[]): RevisionScope {
  const keys = new Set(affected);
  const tasks = project.items.filter(isTask);
  const byId = new Map<string, PlannedItem>(tasks.map((task) => [task.item.id, task]));
  const citing = tasks.filter(({ item }) => citedKeys(item).some((key) => keys.has(key)));
  const waitsOn = citing.find(({ item }) => item.status === "InProgress") ?? null;
  const openIds = new Set<string>(tasks.filter(({ item }) => isSupersedable(item)).map(({ item }) => item.id));
  // A dependent not read as a task is replaced: nothing shows it untouched.
  const citesAffected = (id: string) => {
    const task = byId.get(id);
    return task === undefined || citedKeys(task.item).some((key) => keys.has(key));
  };

  const closeOver = (seed: readonly PlannedItem[], reviewWaits: "regate" | "replace"): RevisionScope => {
    const replacedIds = new Set<string>(seed.map(({ item }) => item.id));
    const regatedOn = new Map<string, string>();
    const frontier = [...replacedIds];
    for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
      const waitedOn = next;
      const gate = byId.get(waitedOn)?.item;
      const checksOnly = gate?.workKind === "check" ? (gate.taskSpec?.checksFor ?? null) : null;
      for (const edge of project.dependencies) {
        if (edge.toId !== waitedOn || replacedIds.has(edge.fromId) || !openIds.has(edge.fromId)) continue;
        if (checksOnly !== null && checksOnly !== edge.fromId) continue;
        if (reviewWaits === "regate" && gate?.taskSpec?.origin === "review" && !citesAffected(edge.fromId)) {
          regatedOn.set(edge.fromId, waitedOn);
          continue;
        }
        replacedIds.add(edge.fromId);
        frontier.push(edge.fromId);
      }
    }
    const replaced = tasks.filter(({ item }) => replacedIds.has(item.id));
    const closedEpics = project.items.filter(({ item }) => {
      if (item.level !== "Epic" || !isUnsettled(item)) return false;
      const children = tasks.filter((task) => task.item.parentId === item.id);
      return children.some((task) => replacedIds.has(task.item.id)) && children.every((task) => !isSupersedable(task.item) || replacedIds.has(task.item.id)) && !children.some((task) => task.item.status === "InProgress");
    });
    const regated = [...regatedOn].flatMap(([taskId, review]): RegatedTask[] =>
      replacedIds.has(taskId)
        ? []
        : [
            {
              taskId,
              review,
              checkTasks: tasks
                .filter(({ item }) => item.workKind === "check" && item.taskSpec?.checksFor === taskId && item.status !== "Abandoned" && !replacedIds.has(item.id))
                .map(({ item }) => item.id),
            },
          ],
    );
    // A review cites every item of its plan and builds none of them: the work it reviewed is planned by its own citations.
    const cited = new Set([...keys, ...replaced.filter(({ item }) => item.taskSpec?.origin !== "review").flatMap(({ item }) => citedKeys(item))]);
    return { waitsOn, replaced: [...replaced, ...closedEpics], planned: vision.items.filter((item) => cited.has(item.id)), regated };
  };

  const held = citing.filter(({ item }) => isSupersedable(item));
  const regating = closeOver(held, "regate");
  // A revision that plans nothing writes no review for a kept task to wait on: it is replaced instead.
  const reviewWaits = regating.regated.length > 0 && stillToCheck(regating.planned, checked).length === 0 ? "replace" : "regate";
  const scope = reviewWaits === "regate" ? regating : closeOver(held, reviewWaits);
  if (stillToCheck(scope.planned, checked).length === 0) return scope;
  // With no environment or layout completed, a revision that plans work plans its own (environmentOf,
  // layoutOf): the open one it would duplicate is replaced too, with the work waiting on it.
  const completed = tasks.filter(({ item }) => item.status === "Completed");
  const setUpAgain = (setsUp: (item: WorkItem) => boolean) => !completed.some(({ item }) => setsUp(item));
  const isScaffold = (item: WorkItem) => item.taskSpec?.origin === "product-scaffold";
  const setsUpAgain = (item: WorkItem) => (isEnvironmentTask(item) && setUpAgain(isEnvironmentTask)) || (isScaffold(item) && setUpAgain(isScaffold));
  // One of them in progress is waited for, as a held task is: its result decides whether the revision sets up its own.
  const settingUp = tasks.find(({ item }) => item.status === "InProgress" && setsUpAgain(item)) ?? null;
  const duplicated = tasks.filter(({ item }) => isSupersedable(item) && setsUpAgain(item));
  const full = duplicated.length === 0 ? scope : closeOver([...held, ...duplicated], reviewWaits);
  return { ...full, waitsOn: waitsOn ?? settingUp };
}

/** The items of `planned` the plan must check that no completed goal task's stored checks already decide as the vision states them. */
function stillToCheck(planned: readonly VisionItem[], checked: readonly VisionItem[]): VisionItem[] {
  return itemsToCheck(planned).filter((item) => !checked.some((done) => done.id === item.id && done.text === item.text));
}

interface ReplannerDeps {
  readonly llm: ContextualLlm;
  readonly store: ReplanStore;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  readonly logger: Logger;
}

/**
 * Delivery's plan revision step. Each project awaiting a revision that has no task in progress is
 * revised through recorded `decomposition` calls and written whole or not at all. A failed
 * attempt writes nothing and is counted; at the cap, and when the project's revisions or repairs
 * reach their bound, the project is blocked, so the loop neither spins on it nor revises without end.
 */
export class Replanner implements Replanning {
  constructor(private readonly deps: ReplannerDeps) {}

  /**
   * A project whose own record cannot be revised is blocked, and the other projects are still
   * revised. Any other failure that escapes an attempt, a store failure included, is that
   * project's, contained to it (containEach).
   */
  async runPending(): Promise<readonly ReplanOutcome[]> {
    const projects = await this.deps.store.projectsAwaitingReplan();
    return containEach(this.deps.containment, "replan", projects, (project) => ({ id: project.projectId, projectId: project.projectId }), async (project) => {
      try {
        return await this.revise(project);
      } catch (err) {
        const projectRecord =
          err instanceof ReplanFailureUnrecorded ||
          err instanceof RevisionUnasked ||
          err instanceof RepairSubjectUnreadable ||
          err instanceof RosterUnreadable ||
          err instanceof WorkKindOwnerUnresolved ||
          err instanceof VisionUnreadable ||
          err instanceof VisionItemsMissing;
        if (!projectRecord) throw err;
        return this.block(project.projectId, projectBlockCause(err));
      }
    });
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<ReplanOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    this.deps.logger.info("delivery.project-blocked", `${cause.errorClass}; project ${projectId} ${result}: ${cause.reason}`, {
      projectId,
      step: "replan",
      category: cause.category,
      errorClass: cause.errorClass,
      result,
    });
    return { kind: "project-blocked", projectId, cause };
  }

  private async revise(project: ProjectAwaitingReplan): Promise<ReplanOutcome> {
    const { projectId } = project;
    const cause = causeOf(project);
    if (cause.kind === "client-change" && project.revisionsSinceReview >= MAX_REVISIONS_PER_REVIEW) {
      const err = new ReplanBoundReached(projectId, project.revisionsSinceReview, cause.changes.map((change) => change.requestedBy));
      return this.block(projectId, { ...projectBlockCause(err), category: "replan_bound" });
    }
    if (cause.kind === "repair" && project.repairsSinceReview >= MAX_REPAIRS_PER_REVIEW) {
      const err = new PlanRepairBoundReached(projectId, project.repairsSinceReview, cause.abandoned);
      return this.block(projectId, { ...projectBlockCause(err), category: "plan_repair" });
    }
    if (project.replanAttempts >= MAX_REPLAN_ATTEMPTS) {
      if (project.replanLastError === null) throw new ReplanFailureUnrecorded(projectId, project.replanAttempts);
      const failure = recordedFailureOf(project.replanLastFailure);
      return this.block(projectId, exhaustedRevisionCause(projectId, project.replanAttempts, project.replanLastError, failure));
    }

    const owners = planOwners(projectId, project.rosterRows);
    // Read before the counted attempt: VisionUnreadable throws through to runPending, which blocks.
    const vision = planningVisionOf(project.vision);
    const completed = project.items.filter(isTask).filter(({ item }) => item.status === "Completed");
    const checked = checkedByDone(completed, cause);
    const scope =
      cause.kind === "client-change" ? correctionScope(project, affectedKeys(cause.changes), vision, checked) : wholePlanScope(project, vision);
    // The store lists a project only with no such task in progress; one seen here started since. Nothing
    // is drawn before this return: the revision waits on a dispatch, which ends by its own bounds.
    if (scope.waitsOn !== null) return { kind: "moved", projectId };
    // A correction whose replaced work leaves nothing to check unplanned (a withdrawn guarantee, an
    // assumption no check rests on) is written with no new task and no model call.
    const nothingToPlan = cause.kind === "client-change" && stillToCheck(scope.planned, checked).length === 0;

    let write: PlanRevisionWrite;
    let result: "written" | "moved";
    try {
      let planned: { readonly decomposition: DecompositionResult; readonly environment: EnvironmentPlanning } | null = null;
      if (!nothingToPlan) {
        const environment = await this.environmentOf(project, cause, completed, vision);
        planned = { decomposition: await this.decompose(project, vision, scope.planned, cause, completed, environment), environment };
      }
      write = this.compose(project, cause, vision, planned, owners, completed, scope);
      result = await this.deps.store.writeRevision(write);
    } catch (err) {
      // Only the model's or its provider's failure is a failed revision attempt. Ashara's own (a
      // refusal before the call, a store write that failed, a request built wrong, a fault nothing
      // names) never counts toward the bound: a spend cap's refusal is the core loop's step's, any
      // other is contained to this project (containEach), or blocks it when it is the project's record.
      const failure = modelCallFailureOf(err);
      if (failure === "ashara") throw err;
      return this.fail(project, err, failure);
    }
    // Revised again next cycle, uncounted: the work ledger bounds it, since every
    // decomposition draws from the project's budget, which halts the project as work_budget when spent.
    if (result === "moved") return { kind: "moved", projectId };
    const why =
      cause.kind === "client-change"
        ? `the correction(s) of message(s) ${cause.changes.map((change) => change.requestedBy).join(", ")}`
        : `given-up task(s) ${cause.abandoned.map((task) => task.id).join(", ")}`;
    this.deps.logger.info("delivery.revision-written", `revision ${write.revision} written for ${why}`, { projectId, revision: write.revision, cause: cause.kind });
    return {
      kind: "revised",
      projectId,
      revision: write.revision,
      cause: cause.kind,
      tasks: write.plan.items.filter((item) => item.level === "Task").length,
      superseded: write.summary.supersededTasks.length + write.summary.supersededOther,
      newEnvironment: write.summary.newEnvironmentTask,
    };
  }

  /**
   * The environment the revision builds on: the latest completed environment task, unless the
   * cause needs an environment change; a new environment task when none is completed. Whether it
   * still serves judges the environment task's work, so a judge of work at that work's tier is asked.
   */
  private async environmentOf(
    project: ProjectAwaitingReplan,
    cause: RevisionCause,
    completed: readonly PlannedItem[],
    vision: PlanningVision,
  ): Promise<EnvironmentPlanning> {
    const environments = completed.filter(({ item }) => isEnvironmentTask(item));
    const current = environments[environments.length - 1];
    if (current === undefined) return { kind: "new" };
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      { site: "decomposition", attempts: 2, onAttempt: this.deps.onAttempt, reask: judgmentReask },
    );
    const response = await provider.generateStructured({
      judges: this.judgedTierOf(project.projectId, current),
      prompt: environmentPrompt(cause, current.environmentStatement, vision),
      schema: EnvironmentJudgmentSchema,
      maxTokens: 512,
    });
    this.deps.logger.info("delivery.environment-judged", `environment change ${response.data.environmentChange}: ${response.data.reason}`, {
      projectId: project.projectId,
      environmentChange: response.data.environmentChange,
    });
    return response.data.environmentChange ? { kind: "new" } : { kind: "existing", taskId: current.item.id };
  }

  /**
   * The tier of a completed task's work: the higher of the grade it was planned at and the grade of
   * the model that did it, since either alone can understate the work. With no model on record the
   * planned grade stands alone, and the record says so.
   */
  private judgedTierOf(projectId: ProjectId, done: PlannedItem): CapabilityLevel {
    const planned = done.item.taskSpec?.capability;
    if (planned === undefined) throw new JudgedTaskUngraded(projectId, done.item.id, done.item.taskSpec?.origin);
    const attempt = done.attemptGrade;
    if (attempt.kind === "graded") return higherCapability(planned, attempt.grade);
    this.deps.logger.warn(
      "delivery.judged-tier-unrecorded",
      `task ${done.item.id} is judged at its planned grade ${planned} alone: ${attempt.why}`,
      { projectId, taskId: done.item.id, plannedGrade: planned },
    );
    return planned;
  }

  private async decompose(
    project: ProjectAwaitingReplan,
    vision: PlanningVision,
    planned: readonly VisionItem[],
    cause: RevisionCause,
    completed: readonly PlannedItem[],
    environment: EnvironmentPlanning,
  ): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.onAttempt,
    );
    const northStar = [vision.northStar, causeSection(cause, vision), doneSection(completed)].join("\n\n");
    const input: DecompositionInput = {
      epicTitle: project.projectName,
      epicNorthStar: northStar,
      epicDescription: vision.visionText,
      priorEpicResults:
        completed.length === 0
          ? []
          : [
              {
                epicId: "done",
                title: "Work already done",
                completedStories: completed.map(({ item }) => item.title),
                keyDecisions: cause.kind === "client-change" ? cause.changes.map((change) => decisionOf(change, vision)) : [],
                deliveredCapabilities: [],
              },
            ],
      environment,
      layout: layoutOf(completed),
      // The same rule as a first plan: every new task traces to the current vision, here to the items
      // the revision plans again (for a repair, all of them).
      visionItems: planned,
      interface: vision.interface,
      checkedItems: checkedByDone(completed, cause),
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  /**
   * The revision as written: the replaced items superseded, and the new plan, or none when a
   * correction left nothing to plan (`planned` null).
   */
  private compose(
    project: ProjectAwaitingReplan,
    cause: RevisionCause,
    vision: PlanningVision,
    planned: { readonly decomposition: DecompositionResult; readonly environment: EnvironmentPlanning } | null,
    owners: ReturnType<typeof planOwners>,
    completed: readonly PlannedItem[],
    scope: RevisionScope,
  ): PlanRevisionWrite {
    const { replaced } = scope;
    const plan: FirstPlanWrite =
      planned === null ? { projectId: project.projectId, items: [], edges: [], owners: [], droppedDependencies: [] } : toWrite(project.projectId, planned.decomposition, owners);
    const tempIds = new Set(plan.items.map((item) => item.tempId));
    // A kept task moved off a superseded review waits on the revision's own, which reads its checks' suites too.
    const review = planned?.decomposition.tasks.find((task) => task.taskSpec.origin === "review");
    if (scope.regated.length > 0 && review === undefined) throw new RevisionReviewMissing(project.projectId, scope.regated.map((task) => task.taskId));
    const regated = review === undefined ? [] : scope.regated.map(({ taskId, review: from }) => ({ taskId, from, toTempId: review.id }));
    const reviewed = review === undefined ? [] : scope.regated.flatMap(({ checkTasks }) => checkTasks.map((to) => ({ from: review.id, to })));
    const existingEdges = [...plan.edges.filter((edge) => !tempIds.has(edge.to)), ...reviewed];
    const revision = project.nextRevision;
    const repairOf = [...project.repairsAwaited];
    const corrections: RevisionCorrections | null =
      cause.kind === "client-change"
        ? {
            versions: [cause.changes[0].visionVersion, ...cause.changes.slice(1).map((change) => change.visionVersion)],
            requestedBy: cause.changes[0].requestedBy,
            affected: affectedKeys(cause.changes),
          }
        : null;

    const events: DomainEvent[] = [];
    const superseded = replaced.map(({ item }): SupersededItem => {
      const previousStatus = item.status;
      supersedeWorkItem(
        item,
        corrections !== null
          ? {
              source: "superseded",
              planRevision: revision,
              requestedBy: corrections.requestedBy,
              reason:
                `replaced by plan revision ${revision} from vision v${project.vision.version}: the client's ` +
                `correction(s) changed ${corrections.affected.join(", ")}, which this work cites or waits on`,
            }
          : {
              source: "superseded",
              planRevision: revision,
              requestedBy: null,
              repairOf,
              reason:
                `replaced by plan revision ${revision} from vision v${project.vision.version}: the team gave up ` +
                `${repairOf.join(", ")} and planned the remaining work again around it`,
            },
      );
      events.push(...takeEvents(item));
      return { item, previousStatus };
    });

    const setAside = setAsideWork(superseded.filter(({ item }) => item.level === "Task").map(({ item }) => item));
    const newTasks = planned === null ? [] : planned.decomposition.tasks;
    const origins = newTasks.map((task) => task.taskSpec.origin);
    const work: PlanRevisionWork = {
      newTasks: newTasks.filter((task) => task.taskSpec.origin === "decomposition").map((task) => task.title),
      newCheckTasks: origins.filter((origin) => origin === "check").length,
      newReviewTasks: origins.filter((origin) => origin === "review").length,
      newEnvironmentTask: planned !== null && planned.environment.kind === "new",
      ...setAside,
      keptCompleted: completed.length,
    };
    return {
      projectId: project.projectId,
      revision,
      visionVersion: project.vision.version,
      corrections,
      repaired: corrections === null ? repairOf : [],
      superseded,
      plan: { ...plan, edges: plan.edges.filter((edge) => tempIds.has(edge.to)) },
      existingEdges,
      regated,
      events,
      summary:
        cause.kind === "client-change"
          ? { ...work, changes: revisionChanges(cause.changes, vision) }
          : { ...work, repaired: cause.abandoned.map((task) => task.title) },
    };
  }

  private async fail(project: ProjectAwaitingReplan, err: unknown, failure: RevisionFailure): Promise<ReplanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error, failure);
    const asked =
      project.correctionsAwaited.length > 0
        ? `the correction(s) of message(s) ${project.correctionsAwaited.map((correction) => correction.requestedBy).join(", ")}`
        : `repair of ${project.repairsAwaited.join(", ")}`;
    this.deps.logger.warn("delivery.replan-attempt-failed", `(vision v${project.vision.version}, ${asked}): attempt ${attempt}/${MAX_REPLAN_ATTEMPTS} failed`, {
      projectId,
      attempt,
      visionVersion: project.vision.version,
    }, err);
    if (attempt < MAX_REPLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };
    return this.block(projectId, exhaustedRevisionCause(projectId, attempt, error, failure));
  }
}
