import type { EventStoreRepository } from "@ashara/db";
import type { Logger, ProjectId } from "@ashara/shared";
import type { ActiveProjects, WorkItemRepository } from "../domain/index.js";
import type { FailureRecoveryDeps } from "../lifecycle/failure-recovery.js";
import type { FailedApproachRepository } from "../acl/knowledge-acl.js";
import type { NewCheckDispute } from "../acl/quality-acl.js";
import type { DispatchService } from "../dispatch/dispatch-service.js";
import type { WorkspacePathStore } from "../task-helpers.js";
import type { TargetPathSource } from "../orphan-merge.js";
import type { TaskQuestion, TaskQuestionPosting } from "../acl/engagement-acl.js";
import type { SpendRefusal } from "../acl/finance-acl.js";

/** Finance's spend cap, as one task's dispatch reads it: Finance only refuses, and the refusal names its cap. */
export interface SpendRefusals {
  refusalOf(error: unknown): SpendRefusal | null;
}

/**
 * A model call refused before it was sent by anything but a spend cap (an unpriced model, a cost
 * that cannot be estimated): a configuration fault the owner fixes, so the project is blocked
 * with the refusal's class. A re-dispatch would meet the same configuration.
 */
interface ConfigurationRefusal {
  readonly kind: "configuration";
  readonly projectId: string;
  readonly errorClass: string;
  readonly reason: string;
}

export type TaskRefusal = SpendRefusal | ConfigurationRefusal;

export type TaskResult =
  | { readonly taskId: string; readonly status: "completed" | "failed" | "blocked"; readonly detail: string }
  /**
   * A model call of the dispatch was refused before it was sent: the item is back at Pending with
   * its dispatch refunded, no lesson and no failure router. A deployment refusal stops the loop with
   * its reason; a configuration refusal has blocked the project.
   */
  | { readonly taskId: string; readonly status: "refused"; readonly detail: string; readonly refusal: TaskRefusal }
  /** The process's shutdown interrupted the attempt: the item is back at Pending with its dispatch refunded. */
  | { readonly taskId: string; readonly status: "interrupted"; readonly detail: string };

/** `detail` is the dispatch's own account of what it delivered, which claims no verification it did not run. */
export function completedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "completed", detail };
}

export function failedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "failed", detail };
}

export function blockedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "blocked", detail };
}

/**
 * The client's channel for a decision only the client can make, which Engagement keeps: `ask` posts a
 * task's question to the client, as intake's questions are posted, and `answered` says whether the
 * client's answer to one has been read.
 */
export interface ClientQuestions {
  ask(question: TaskQuestion): Promise<TaskQuestionPosting>;
  answered(questionId: string): Promise<boolean>;
}

/** The loop's runtime and board, as one task's dispatch and the routing of its result read them. */
export interface DispatchLoop {
  readonly config: { readonly workdirBase: string };
  /** Each dispatched attempt runs in its own trace on it, carrying its task and attempt number. */
  readonly logger: Logger;
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /**
   * Each project's target workspace path, and the halt of a project a dispatch's refusal or a
   * parked failure that does not parse names.
   */
  readonly projectRepo: WorkspacePathStore & TargetPathSource & Pick<ActiveProjects, "block">;
  readonly spendCap: SpendRefusals;
}

/** A task's dispatch and the routing of its result. */
export interface TaskDispatchSteps {
  readonly dispatchService: Pick<DispatchService, "execute">;
  readonly failedApproachRepo: Pick<FailedApproachRepository, "record">;
  readonly failureRouter: FailureRecoveryDeps["failureRouter"];
  /** Quality's durable record of check disputes: their count per check task bounds the reopens. */
  readonly checkDisputes: CheckDisputeRecord;
  /**
   * Quality's durable record of the reviews of plan revisions' suites:
   * how many reviews named each check task bounds its reopens.
   */
  readonly suiteReviewFindings: SuiteReviewFindingRecord;
  /**
   * Quality's freeze of a plan revision's check set, run at every dispatch before it is counted: the
   * first implementation dispatched on a review's check set freezes it, so no later review of that
   * set reopens anything.
   */
  readonly checkSetFreeze: CheckSetFreeze;
  /**
   * The roster role doing a project's environment work, from its latest roster: the owner of the
   * environment task an implementation's request opens. `none`, with
   * why, when the roster names no such role; a roster that cannot be read throws.
   */
  readonly environmentOwner: (projectId: ProjectId) => Promise<EnvironmentOwner>;
  /** Where a task blocked on a decision only the client can make has its question posted, and its answer read. */
  readonly clientQuestions: ClientQuestions;
}

/** What one task's dispatch and the routing of its result run on: the loop's own board and the dispatch steps. */
export interface DispatchRunDeps {
  readonly loop: DispatchLoop;
  readonly dispatch: TaskDispatchSteps;
}

/** Who does a project's environment work, as the latest roster says. */
type EnvironmentOwner = { readonly kind: "role"; readonly roleId: string } | { readonly kind: "none"; readonly why: string };

/** Appends a dispute; resolves to the disputes its check task has drawn, this one included. */
interface CheckDisputeRecord {
  record(dispute: NewCheckDispute): Promise<number>;
}

/** One review of a plan revision's suites that found problems, as its dispatch ended with it. */
interface SuiteReviewFindingsEntry {
  readonly projectId: string;
  readonly reviewTaskId: string;
  readonly problems: ReadonlyArray<{
    readonly checkTaskIds: readonly string[];
    readonly kind: "contradiction" | "outside-vision" | "undecided-item" | "breaks-contract";
    readonly problem: string;
    readonly evidence: string;
  }>;
}

/** Appends the findings; resolves, per named check task, to how many reviews have named it, this one included. */
interface SuiteReviewFindingRecord {
  record(findings: SuiteReviewFindingsEntry): Promise<{ readonly timesNamed: ReadonlyMap<string, number> }>;
}

/**
 * Quality's freeze of a plan revision's check set: freezes the check set of
 * every review task the dispatched task depends on that is not frozen yet, and resolves to the review
 * tasks it froze. A task that depends on no review freezes nothing.
 */
interface CheckSetFreeze {
  freezeFor(taskId: string): Promise<readonly string[]>;
}
