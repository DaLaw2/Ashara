import type { DomainEvent, ProjectId, StepFaulted, UnreadSubject } from "@ashara/shared";
import type { CapabilityLevel, ModelCallFailure } from "./acl/finance-acl.js";
import type { StoredVision } from "./acl/engagement-acl.js";
import type { BulkPlanEdge } from "./bulk-plan.js";
import type { VisionItem } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import type { FirstPlanWrite } from "./first-plan.js";
import type { ProjectBlockCause } from "./project-halt.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";

/**
 * The catalog grade of the model that last completed an attempt of a task, as the store reads it,
 * or why none is on record.
 */
export type AttemptGrade =
  | { readonly kind: "graded"; readonly model: string; readonly grade: CapabilityLevel }
  | { readonly kind: "unrecorded"; readonly why: string };

/** One of the project's work items as the store reads it, with what was merged for it. */
export interface PlannedItem {
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
export interface AbandonedTask {
  readonly id: string;
  readonly title: string;
  /** Its dispatches, the failed ones that led to its abandonment. */
  readonly attempts: number;
  /** Why it was given up and its last failure, as its blocked_reason recorded them. */
  readonly evidence: string;
}

/** A client correction awaiting its revision (correction_holds): the client's words and the keys it affects. */
export interface CorrectionRequest {
  /** The vision version the correction wrote. */
  readonly visionVersion: number;
  /** The client message it answers: the change, its confirmation or the answer. */
  readonly requestedBy: string;
  /** That message's words. */
  readonly words: string;
  /** The guarantee and assumption keys it affects. */
  readonly affected: readonly [string, ...string[]];
}

/** A project awaiting a revision with no task in progress and no unread answer, as the store reads it. */
export interface ProjectAwaitingReplan {
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
export type RevisionCause =
  | { readonly kind: "client-change"; readonly changes: readonly [CorrectionRequest, ...CorrectionRequest[]] }
  | { readonly kind: "repair"; readonly abandoned: readonly AbandonedTask[] };

/** The part of a revision's summary that says what it planned, whatever asked for it. */
export interface PlanRevisionWork {
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
export interface RevisionChange {
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
export interface RevisionCorrections {
  readonly versions: readonly [number, ...number[]];
  readonly requestedBy: string;
  readonly affected: readonly string[];
}

/** A superseded item with the status it was read in: the write refuses it if the row moved since. */
export interface SupersededItem {
  readonly item: WorkItem;
  readonly previousStatus: WorkItemStatus;
}

export interface PlanRevisionWrite {
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

/** Whose failure a counted revision attempt was: Ashara's own is never counted (Replanner.revise). */
export type RevisionFailure = Exclude<ModelCallFailure, "ashara">;

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
