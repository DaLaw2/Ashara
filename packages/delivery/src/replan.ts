import { z } from "zod";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { DomainEvent, ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { withStructuredLadder } from "./acl/finance-acl.js";
import type { LadderAttemptEvent } from "./acl/finance-acl.js";
import { blockedReasonToRecord } from "./work-item-language/blocked-reason.js";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { projectBlockCause, recordedFailureOf } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { VisionUnreadable, planningVisionOf, statedChangeOf } from "./acl/engagement-acl.js";
import { modelCallFailureOf } from "./acl/finance-acl.js";
import type { ContextualLlm, ModelCallFailure } from "./acl/finance-acl.js";
import { RosterUnreadable, WorkKindOwnerUnresolved } from "./acl/organization-acl.js";
import type { PlanningVision, StoredVision } from "./acl/engagement-acl.js";
import type { BulkPlanEdge } from "./bulk-plan.js";
import { DecompositionEngine } from "./decomposition.js";
import { VisionItemsMissing } from "./decomposition-types.js";
import type { DecompositionInput, DecompositionResult, EnvironmentPlanning, LayoutPlanning, VisionItem } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import { supersedeWorkItem, takeEvents } from "./domain/index.js";
import type { FirstPlanWrite } from "./first-plan.js";
import { planOwners, toWrite } from "./first-plan.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

// Delivery's revision of a plan already under way (story s-liaison-intake-m1, task
// t-replan-on-change, migration 042), asked for in one of two ways. A client answer that changed an
// assumption the plan was built on is recorded as a request (replan_requests, migration 052); every
// such answer awaiting a revision is taken in by the next one, and its report names each, since
// each was promised the client would hear what it changed. A task given up, for any cause
// (the failure router's attempt bound, a dispute or review bound, the environment-change bound, an
// unsatisfiable dependency: ADR-074 addendum 2 d74 D, d76; migrations 045, 048), opens a plan repair:
// no person releases its dependents; the remaining work is planned again around it. Either stops the project's
// dispatch. Once no task of the project is in progress, the current vision is decomposed again with
// the completed work, and for a repair the given-up work and its evidence, as context: completed work
// stays Completed, open work (not started, Blocked or Failed, and the Epic that held it) is
// superseded, and the new tasks build on the environment already set up unless an environment change
// is needed. Revision, supersession and the requests it took in commit together; the Liaison reports the
// revision from what is recorded.

/** Failed attempts to revise the plan for one request after which Delivery stops and blocks the project. */
const MAX_REPLAN_ATTEMPTS = 3;

/** Revisions for client changes Delivery writes before the operator reviews the project; the next request blocks it. */
const MAX_REVISIONS_PER_REVIEW = 3;

/**
 * Plan repairs Delivery writes before the project halts as undeliverable (R = 2, ADR-074 addendum 2
 * d74 D, d76): past it the same work is being given up again, and the next give-up halts the
 * project (a plan_repair block) with one report naming the work given up and why. Counted since the
 * owner last reviewed such a halt (exit X3).
 */
const MAX_REPAIRS_PER_REVIEW = 2;

/** Longest part of a given-up task's recorded failure the planner is shown. */
const MAX_ABANDONMENT_EVIDENCE_CHARS = 3000;

/** One of the project's work items as the store reads it, with what was merged for it. */
interface PlannedItem {
  readonly item: WorkItem;
  /** The merge commit on the target's main (migration 041); null when none is recorded. */
  readonly mergeCommit: string | null;
  /** A Sprint 0 task's statement of the environment it set up (migration 033); null when none is recorded. */
  readonly environmentStatement: string | null;
  /**
   * The vision items its latest stored checks decide (task_checks.decides, migration 064), each as
   * its check task cites it; empty when it has no stored checks or they record no items they decide.
   */
  readonly decided: readonly VisionItem[];
}

/** A task given up whose repair the project awaits (plan_repairs, migrations 045, 048). */
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
  /** The client answers whose revision the project awaits (replan_requests), oldest first; empty when only repairs are awaited. */
  readonly changesAwaited: readonly string[];
  /** The ids of the tasks given up whose repair the project awaits (plan_repairs), oldest first; empty when none. */
  readonly repairsAwaited: readonly string[];
  /** The project's current vision as stored; the request's Stated assumption is found in it. */
  readonly vision: StoredVision;
  readonly rosterRows: unknown;
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  /** Whose failure the last counted attempt was, as stored (migration 066); read by recordedFailureOf. */
  readonly replanLastFailure: string | null;
  /** Revisions for client changes written since the operator last reviewed a replan_bound block (all of them when never). */
  readonly revisionsSinceReview: number;
  /** Plan repairs written since the operator last reviewed a plan_repair block (all of them when never). */
  readonly repairsSinceReview: number;
  /** The number the next revision takes; the first plan is revision 1. */
  readonly nextRevision: number;
  readonly items: readonly PlannedItem[];
}

/** What asked for a revision: the client's answers, in the order they were sent, or tasks given up. */
type RevisionCause =
  | { readonly kind: "client-change"; readonly changes: readonly [ChangeRequest, ...ChangeRequest[]] }
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
  /** Superseded check and environment tasks. */
  readonly supersededOther: number;
  readonly keptCompleted: number;
}

/** One change a revision took in: the client's words and what work now proceeds on. */
interface RevisionChange {
  /** The client's words, as the answer that asked for the change carries them. */
  readonly answer: string;
  /** What work now proceeds on, as the vision states it. */
  readonly decision: string;
}

/**
 * What a revision did, recorded with it (plan_revisions.summary) for the Liaison's report.
 * Titles are the client's goal tasks; check and environment tasks are counted apart. A revision
 * for the client's changes carries every change it took in, in the order the answers were sent;
 * a repair, the titles of the tasks given up.
 */
type PlanRevisionSummary = PlanRevisionWork &
  ({ readonly changes: readonly [RevisionChange, ...RevisionChange[]] } | { readonly repaired: readonly string[] });

/** A superseded item with the status it was read in: the write refuses it if the row moved since. */
interface SupersededItem {
  readonly item: WorkItem;
  readonly previousStatus: WorkItemStatus;
}

interface PlanRevisionWrite {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly visionVersion: number;
  /** The client answers the revision takes in, in the order they were sent; empty for a plan repair. */
  readonly answers: readonly string[];
  /** The given-up tasks whose awaited repair the revision records, whatever asked for it. */
  readonly repaired: readonly string[];
  readonly superseded: readonly SupersededItem[];
  /** The new items, edges between them by temp id, and owners, as a first plan writes them. */
  readonly plan: FirstPlanWrite;
  /** Edges from a new item (temp id) to work already on record (its id): the environment kept. */
  readonly existingEdges: readonly BulkPlanEdge[];
  readonly events: readonly DomainEvent[];
  readonly summary: PlanRevisionSummary;
}

/** Delivery's persistence port for plan revisions. Each method is one transaction. */
export interface ReplanStore {
  /** Every project awaiting a revision, each read on its own: one whose rows do not read is its UnreadSubject. */
  projectsAwaitingReplan(): Promise<ReadonlyArray<ProjectAwaitingReplan | UnreadSubject>>;
  /**
   * Supersedes the open items, writes the new ones, records the revision and records the client's
   * answers and the repairs it takes in, together; "moved" and nothing written when the project,
   * its vision, the answers it awaits or an item read for it changed since it was read (a task
   * started, an answer arrived).
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

/** The project's plan was revised its bound of times since the operator last reviewed it. */
class ReplanBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisions: number,
    readonly answers: readonly string[],
  ) {
    super(
      `project ${projectId}: the plan was revised ${revisions} time(s) for client changes since the operator last ` +
        `reviewed it, the bound of ${MAX_REVISIONS_PER_REVIEW}; the change(s) of answer(s) ${answers.join(", ")} are not ` +
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
 * The project has spent its revision attempts but holds no error for them. The CHECK of migration
 * 042 makes this unrepresentable; meeting it means the store lied.
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

/** A recorded request names an answer the current vision holds no Stated assumption for: there is no change on record to plan. */
class ReplanRequestUnfounded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly requestedBy: string,
    readonly visionVersion: number,
    readonly detail: string,
  ) {
    super(
      `project ${projectId}: replanning was requested by answer ${requestedBy}, but vision v${visionVersion} ` +
        `records no change from it (${detail}); nothing is planned`,
    );
    this.name = "ReplanRequestUnfounded";
  }
}

/** The store listed a project awaiting a revision that neither a client answer nor a repair asks for. */
class ReplanRequestMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`project ${projectId}: listed as awaiting a plan revision, but no client answer and no given-up task asks for one`);
    this.name = "ReplanRequestMissing";
  }
}

/** The client's change a recorded request stands for: the answer, their question, their words and what work now proceeds on. */
interface ChangeRequest {
  readonly answerId: string;
  readonly question: string;
  readonly answer: string;
  readonly decision: string;
}

function changeOf(project: ProjectAwaitingReplan, requestedBy: string): ChangeRequest {
  const stated = statedChangeOf(project.vision, requestedBy);
  if (stated === null) {
    throw new ReplanRequestUnfounded(project.projectId, requestedBy, project.vision.version, "no Stated assumption carries that answer");
  }
  return { answerId: requestedBy, ...stated };
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
    case "task_failed":
    case "orchestrator_error":
    case "merge_unrecorded":
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
 * The client's answers come first: their revision re-plans every open item, so it answers the awaited
 * repairs too. Every answer awaiting a revision is taken in by this one, each a change on record.
 */
function causeOf(project: ProjectAwaitingReplan): RevisionCause {
  const [first, ...rest] = project.changesAwaited;
  if (first !== undefined) {
    return { kind: "client-change", changes: [changeOf(project, first), ...rest.map((answerId) => changeOf(project, answerId))] };
  }
  if (project.repairsAwaited.length === 0) throw new ReplanRequestMissing(project.projectId);
  return { kind: "repair", abandoned: abandonedOf(project) };
}

/** The changes as the summary records them: the client's words and the decision, in the order sent. */
function revisionChanges(changes: readonly [ChangeRequest, ...ChangeRequest[]]): readonly [RevisionChange, ...RevisionChange[]] {
  const [first, ...rest] = changes;
  const recorded = (change: ChangeRequest): RevisionChange => ({ answer: change.answer, decision: change.decision });
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

/** One change as the planner reads it: the question, the client's words and the decision. */
function changeLines(change: ChangeRequest): string {
  return `They were asked: ${change.question}\nThey answered: ${change.answer}\nWork now proceeds on: ${change.decision}`;
}

/** What the revision is asked for, as the planner reads it beside the vision. */
function causeSection(cause: RevisionCause): string {
  if (cause.kind === "client-change") {
    return cause.changes.length === 1
      ? `The client changed what is built after work began. ${changeLines(cause.changes[0])}`
      : `The client changed what is built after work began, in ${cause.changes.length} answers; plan for every one of them.\n` +
          cause.changes.map((change, i) => `Change ${i + 1}. ${changeLines(change)}`).join("\n");
  }
  return (
    `${abandonmentSection(cause.abandoned)}\n` +
    `Plan the work still to do again so that the vision is still delivered: the given-up work is not done, and its ` +
    `evidence shows what to do differently. Plan small tasks, each a complete behaviour a user can use and observe.`
  );
}

const EnvironmentJudgmentSchema = z.strictObject({ environmentChange: z.boolean(), reason: z.string().min(1) });

function environmentPrompt(cause: RevisionCause, statement: string | null): string {
  const situation =
    cause.kind === "client-change"
      ? [
          `After work on a project began, the client changed what is built.`,
          `Say whether ${cause.changes.length === 1 ? "this change" : `what the client changed, in ${cause.changes.length} answers taken together,`} needs the project environment changed: how the project is built and tested, the`,
          `technology it is built with, or the tools its build and tests run on. A change to what the product does that`,
          `the environment as it is can build and test is not an environment change.`,
          ...cause.changes.flatMap((change) => [
            ``,
            `The question the client answered:`,
            JSON.stringify(change.question),
            ``,
            `The client's answer:`,
            JSON.stringify(change.answer),
            ``,
            `What work now proceeds on:`,
            JSON.stringify(change.decision),
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

function isGoalTask(item: WorkItem): boolean {
  const origin = item.taskSpec?.origin;
  return (
    origin !== "check" &&
    origin !== "sprint0" &&
    origin !== "product-scaffold" &&
    origin !== "acceptance" &&
    item.workKind !== "environment" &&
    item.workKind !== "check"
  );
}

function isEnvironmentTask(item: WorkItem): boolean {
  return item.workKind === "environment" || item.taskSpec?.origin === "sprint0";
}

/**
 * The product layout a revision builds on (ADR-074 addendum 2 d72 B2), or a new one when no scaffold
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
 * The vision items the stored checks of a completed decomposed task decide (ADR-083), so a revision
 * need not give them a task again. What the task cites is never read here: an item it cites that no
 * stored check decides, a check stored before decides was recorded or a task completed with no
 * stored checks, is planned again.
 */
function checkedByDone(completed: readonly PlannedItem[]): VisionItem[] {
  return completed.flatMap(({ item, decided }) => (item.taskSpec?.origin === "decomposition" ? [...decided] : []));
}

/** The work already done, kept as the revision's context: titles and what merged them. */
function doneSection(completed: readonly PlannedItem[]): string {
  if (completed.length === 0) return "Already done: nothing yet.";
  const lines = completed.map(({ item, mergeCommit }) =>
    mergeCommit === null ? `- ${item.title}` : `- ${item.title} (merged as ${mergeCommit})`,
  );
  return `Already done, and kept as it is (plan only what is still to do, building on it):\n${lines.join("\n")}`;
}

interface ReplannerDeps {
  readonly llm: ContextualLlm;
  readonly store: ReplanStore;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
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
          err instanceof ReplanRequestUnfounded ||
          err instanceof ReplanRequestMissing ||
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
    console.warn(`[replan] project ${projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
    return { kind: "project-blocked", projectId, cause };
  }

  private async revise(project: ProjectAwaitingReplan): Promise<ReplanOutcome> {
    const { projectId } = project;
    const cause = causeOf(project);
    if (cause.kind === "client-change" && project.revisionsSinceReview >= MAX_REVISIONS_PER_REVIEW) {
      const err = new ReplanBoundReached(projectId, project.revisionsSinceReview, cause.changes.map((change) => change.answerId));
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
    const tasks = project.items.filter(isTask);
    // The store lists a project only with no task in progress; one seen here started since.
    if (tasks.some(({ item }) => item.status === "InProgress")) return { kind: "moved", projectId };
    const completed = tasks.filter(({ item }) => item.status === "Completed");
    const open = tasks.filter(({ item }) => item.status === "Pending" || item.status === "Blocked" || item.status === "Failed");
    // The revision writes its own Epic; an old one not Completed is closed with the work it held.
    const openEpics = project.items.filter(({ item }) => item.level === "Epic" && item.status !== "Completed" && item.status !== "Abandoned");

    let write: PlanRevisionWrite;
    let result: "written" | "moved";
    try {
      const environment = await this.environmentOf(project, cause, completed);
      const decomposition = await this.decompose(project, vision, cause, completed, environment);
      write = this.compose(project, cause, decomposition, owners, environment, completed, [...open, ...openEpics]);
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
    if (result === "moved") return { kind: "moved", projectId };
    const why =
      cause.kind === "client-change"
        ? `answer(s) ${cause.changes.map((change) => change.answerId).join(", ")}`
        : `given-up task(s) ${cause.abandoned.map((task) => task.id).join(", ")}`;
    console.log(`[replan] project ${projectId}: revision ${write.revision} written for ${why}`);
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
   * cause needs an environment change; a new environment task when none is completed.
   */
  private async environmentOf(
    project: ProjectAwaitingReplan,
    cause: RevisionCause,
    completed: readonly PlannedItem[],
  ): Promise<EnvironmentPlanning> {
    const environments = completed.filter(({ item }) => isEnvironmentTask(item));
    const current = environments[environments.length - 1];
    if (current === undefined) return { kind: "new" };
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      { site: "decomposition", attempts: 2, onAttempt: this.deps.onAttempt, reask: judgmentReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: environmentPrompt(cause, current.environmentStatement),
      schema: EnvironmentJudgmentSchema,
      maxTokens: 512,
    });
    console.log(
      `[replan] project ${project.projectId}: environment change ${response.data.environmentChange}: ${response.data.reason}`,
    );
    return response.data.environmentChange ? { kind: "new" } : { kind: "existing", taskId: current.item.id };
  }

  private async decompose(
    project: ProjectAwaitingReplan,
    vision: PlanningVision,
    cause: RevisionCause,
    completed: readonly PlannedItem[],
    environment: EnvironmentPlanning,
  ): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.onAttempt,
    );
    const northStar = [vision.northStar, causeSection(cause), doneSection(completed)].join("\n\n");
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
                keyDecisions: cause.kind === "client-change" ? cause.changes.map((change) => change.decision) : [],
                deliveredCapabilities: [],
              },
            ],
      environment,
      layout: layoutOf(completed),
      // The same rule as a first plan (ADR-074 addendum 2 d71 d): every new task traces to the current vision.
      visionItems: vision.items,
      checkedItems: checkedByDone(completed),
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  private compose(
    project: ProjectAwaitingReplan,
    cause: RevisionCause,
    decomposition: DecompositionResult,
    owners: ReturnType<typeof planOwners>,
    environment: EnvironmentPlanning,
    completed: readonly PlannedItem[],
    open: readonly PlannedItem[],
  ): PlanRevisionWrite {
    const plan = toWrite(project.projectId, decomposition, owners);
    const tempIds = new Set(plan.items.map((item) => item.tempId));
    const existingEdges = plan.edges.filter((edge) => !tempIds.has(edge.to));
    const revision = project.nextRevision;
    const repairOf = [...project.repairsAwaited];
    const answers = cause.kind === "client-change" ? cause.changes.map((change) => change.answerId) : [];

    const events: DomainEvent[] = [];
    const superseded = open.map(({ item }): SupersededItem => {
      const previousStatus = item.status;
      supersedeWorkItem(
        item,
        cause.kind === "client-change"
          ? {
              source: "superseded",
              planRevision: revision,
              requestedBy: cause.changes[0].answerId,
              reason:
                `replaced by plan revision ${revision} from vision v${project.vision.version}: the client's ` +
                `answer(s) ${answers.join(", ")} changed what is built`,
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

    const supersededTasks = superseded.filter(({ item }) => item.level === "Task");
    const origins = decomposition.tasks.map((task) => task.taskSpec.origin);
    const work: PlanRevisionWork = {
      newTasks: decomposition.tasks.filter((task) => task.taskSpec.origin === "decomposition").map((task) => task.title),
      newCheckTasks: origins.filter((origin) => origin === "check").length,
      newReviewTasks: origins.filter((origin) => origin === "review").length,
      newEnvironmentTask: environment.kind === "new",
      supersededTasks: supersededTasks.filter(({ item }) => isGoalTask(item)).map(({ item }) => item.title),
      supersededOther: supersededTasks.filter(({ item }) => !isGoalTask(item)).length,
      keptCompleted: completed.length,
    };
    return {
      projectId: project.projectId,
      revision,
      visionVersion: project.vision.version,
      answers,
      repaired: repairOf,
      superseded,
      plan: { ...plan, edges: plan.edges.filter((edge) => tempIds.has(edge.to)) },
      existingEdges,
      events,
      summary:
        cause.kind === "client-change"
          ? { ...work, changes: revisionChanges(cause.changes) }
          : { ...work, repaired: cause.abandoned.map((task) => task.title) },
    };
  }

  private async fail(project: ProjectAwaitingReplan, err: unknown, failure: RevisionFailure): Promise<ReplanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error, failure);
    const asked =
      project.changesAwaited.length > 0 ? `answer(s) ${project.changesAwaited.join(", ")}` : `repair of ${project.repairsAwaited.join(", ")}`;
    console.warn(`[replan] project ${projectId} (vision v${project.vision.version}, ${asked}): attempt ${attempt}/${MAX_REPLAN_ATTEMPTS} failed: ${error}`);
    if (attempt < MAX_REPLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };
    return this.block(projectId, exhaustedRevisionCause(projectId, attempt, error, failure));
  }
}
