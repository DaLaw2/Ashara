import type { BaseCellReference, Cell, EnvironmentImages, WorkdirInfo } from "@ashara/execution-infra";
import type { ContextualTurnLlm } from "@ashara/finance";
import type { KnowledgeSink, KnowledgeSource } from "@ashara/knowledge";
import type {
  CheckAuthoring,
  CompletedTaskChecks,
  DispatchEnvironment,
  EnvironmentStatementStore,
  ExecutionEventSink,
  MainConflict,
  TaskCheckStore,
  TaskChecks,
  VerificationCells,
} from "@ashara/quality";
import type { Clock, Logger, ProjectId, WorkItemId } from "@ashara/shared";
import type { AgentBrief, AssignmentStaff, ProjectIntentSource, SessionStore } from "@ashara/workplace";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { StoredTaskSpec } from "../work-item-language/task-spec.js";
import type { WorkKind } from "../acl/organization-acl.js";
import type { DispatchRecords } from "./dispatch-records.js";
import type { DispatchVerification } from "./verification-ports.js";

/**
 * What decides a task's work: the environment substrate (Sprint 0 and every environment task), the
 * product's own build and test from the definition (the product scaffold), the checks the check
 * author stored for it (every other implementation task), or, for a check task, Z0's red run of
 * the checks it defines. Resolved before the brief and the worktree.
 */
export type WorkPlan =
  | { readonly kind: "substrate" }
  | { readonly kind: "scaffold" }
  | {
      readonly kind: "stored-checks";
      readonly stored: TaskChecks;
      /**
       * The latest checks of every task of the project already merged: the regression suite the
       * merge must pass, any check of which the implementer may dispute.
       */
      readonly merged: readonly CompletedTaskChecks[];
    }
  | Omit<CheckAuthoring, "branch" | "startCommit" | "recorder">;

/** A task's work plan once its worktree exists: a check task's carries its throwaway worktree. */
export type DispatchWork = Exclude<WorkPlan, { readonly kind: "check-authoring" }> | CheckAuthoring;

/** A task no work plan can be made for: it fails before the agent, with the reason. */
export interface Unplannable {
  readonly kind: "unplannable";
  readonly operation: string;
  readonly reason: string;
}

/** The cells every dispatch runs on: verification's, and the BaseCell. */
interface ExecutionCells extends VerificationCells {
  /** The image the Sprint 0 task's cells start from (config/base-cell.toml); no other task uses it. */
  readonly baseCell: BaseCellReference;
}

/** Who works a task and on which model: the task's owner role, as the project's roster names it. */
export type AgentStaff = AssignmentStaff;

/**
 * A task no role of the roster can work: it has no owner, or its owner is not in the project's
 * latest roster. The dispatch blocks; no default role stands in for the owner.
 */
export interface OwnerUnresolved {
  readonly kind: "owner-unresolved";
  /** The work item's stored owner_role_id; null when it has none. */
  readonly ownerRoleId: string | null;
  /** The project's latest roster revision the decision was made against; null when it has none. */
  readonly rosterRevision: number | null;
  readonly reason: string;
}

/**
 * A task an attempt of which overflowed a context window of `overflowedWindowTokens`
 * (work_items.overflowed_window_tokens) is dispatched only on a model whose window is larger, and
 * the catalog offers none. The dispatch gives the task up; no model runs it on a window it is known
 * not to fit.
 */
export interface NoWiderModel {
  readonly kind: "no-wider-model";
  readonly overflowedWindowTokens: number;
}

/** How a task was staffed for one attempt: its owner and model, or why it has none. */
export type Staffing = { readonly kind: "staffed"; readonly staff: AgentStaff } | OwnerUnresolved | NoWiderModel;

/**
 * Builds the agent half of a task's Assignment: its owner role and its model, resolved once per
 * attempt and never inside it. The composition root supplies it. A model that
 * cannot be resolved throws and fails the dispatch.
 */
export interface AgentStaffing {
  staff(task: TaskDescriptor): Promise<Staffing>;
  /**
   * The model the task is dispatched on next after an attempt's turn did not fit a window of
   * `windowTokens`: one whose window is larger, so the overflow is not met again on the same model
   * nor on one no larger; null when the catalog offers none.
   */
  widerModel(task: TaskDescriptor, windowTokens: number): AgentStaff["model"] | null;
}

/** The limits of one attempt; the wall clock is the attempt's own. */
interface AttemptPolicy {
  readonly maxTurns: number;
  /** Upper bound of one run_command; the model may ask for less. */
  readonly perCommandTimeoutSeconds: number;
  /** Timeout of the file tools (read, write, list, search). */
  readonly toolTimeoutSeconds: number;
}

interface DispatchConfig {
  readonly workdirBase: string;
}

/** The task a dispatch works, as the core loop describes it from its WorkItem. */
export interface TaskDescriptor {
  readonly id: WorkItemId;
  /** work_items.project_id: every LLM call made for this task is charged to it. */
  readonly projectId: ProjectId;
  readonly title: string;
  readonly parentId?: string;
  readonly taskSpec?: StoredTaskSpec;
  /** WorkItem.blockedReason, carried through so a replanned attempt can see why the prior attempt failed. */
  readonly blockedReason?: StoredBlockedReason;
  /**
   * The task's true Epic ancestor id, walked up by the core loop (which reads the
   * WorkItem hierarchy) before constructing this descriptor. `null`
   * means the walk ran and found no Epic ancestor. Required: a parent is not an Epic, so no
   * other field may stand in for it at the knowledge write.
   */
  readonly epicId: string | null;
  /**
   * Number of times this task has been dispatched. The DB column is NOT NULL
   * with default 0, `createPendingWorkItem` always sets it, and the sole
   * production construction site (the core loop's dispatch run) always passes it.
   * Required so the `?? 0` absence default that silently prevented model
   * escalation is structurally impossible.
   */
  readonly dispatchCount: number;
  /**
   * This dispatch's ordinal: work_items.dispatch_count as the orchestrator's dispatch seam left
   * it (incrementDispatchCount's return), so every event and result of the dispatch names it.
   * A refunded dispatch (a spend-cap refusal, a shutdown) gives its number to the next one.
   */
  readonly attempt: number;
  /**
   * work_items.work_kind: which kind of work the task is. Only an environment task's
   * attempt is given build_environment. null for a task planned before owners were assigned.
   */
  readonly workKind: WorkKind | null;
  /**
   * Prose acceptance statements from work_items.success_criteria. Required: the
   * sole construction site (the core loop's dispatch run) always has the WorkItem.
   * An empty array means "no criteria stated" and the brief section is omitted;
   * undefined would be a second way to spell "none" that costs a supplier check
   * on every new construction site.
   */
  readonly successCriteria: readonly string[];
  /**
   * work_items.overflowed_window_tokens: the largest context window an attempt of
   * the task did not fit, so its dispatch is staffed with a model whose window is larger; null when
   * no attempt has overflowed one.
   */
  readonly overflowedWindowTokens: number | null;
}

/** Everything one dispatch holds once its cell is up. */
export interface Dispatch {
  readonly task: TaskDescriptor;
  readonly brief: AgentBrief;
  readonly staff: AgentStaff;
  readonly cell: Cell;
  readonly records: DispatchRecords;
  readonly targetProjectPath: string;
  readonly workDir: string;
  /** The worktree's git dir, resolved before the cell existed; never re-read from the work tree. */
  readonly repo: WorkdirInfo["repo"];
  readonly sessionId: string;
  /** What the task cell, the red-run and gate cells and the post-merge verifier cell are started from. */
  readonly environment: DispatchEnvironment;
  readonly work: DispatchWork;
  /**
   * The conflict with main the attempt starts with: main merged into the task branch in its
   * worktree, the merge staged with git's markers in these files (startMainMerge). Null otherwise.
   */
  readonly conflict: MainConflict | null;
}

export interface DispatchServiceDeps {
  readonly config: DispatchConfig;
  readonly sessionStore: SessionStore;
  readonly knowledgeSink: KnowledgeSink;
  readonly knowledgeSource?: KnowledgeSource;
  readonly eventSink?: ExecutionEventSink;
  /**
   * Supplies the owner's own vision text for a task's project. A task whose project has none
   * is not dispatched: a brief with an invented intent is the failure this port exists to prevent.
   */
  readonly intentSource: ProjectIntentSource;
  /**
   * Required: execute() probes the substrate before anything else and runs every
   * tool call and every check in a cell, so there is no configuration in which
   * an unavailable substrate means "run on the host".
   */
  readonly cells: ExecutionCells;
  /** The recorded gateway: every agent turn is one llm_calls row charged to the task's project. */
  readonly llm: ContextualTurnLlm;
  readonly staffing: AgentStaffing;
  readonly attemptPolicy: AttemptPolicy;
  /**
   * The environment substrate: builds an environment version's image for
   * build_environment, the substrate gate and every later task's cells, and keeps the Sprint 0
   * task's stack statement.
   */
  readonly environment: {
    readonly images: EnvironmentImages;
    readonly statements: EnvironmentStatementStore;
  };
  /**
   * Quality's task checks: a check task stores the checks it wrote, and
   * an implementation task is decided by them. Required: no task is verified without them.
   */
  readonly checks: TaskCheckStore;
  /** Quality's verification jobs, each built by the composition root: every verdict a dispatch is decided by. */
  readonly verifiers: DispatchVerification;
  /** Aborted on shutdown: an attempt in flight ends as cancelled. */
  readonly shutdownSignal: AbortSignal;
  /** What an attempt's wall clock reads. */
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What every stage of a dispatch works with: the service's dependencies and Quality's verification of its dispatches. */
export interface DispatchContext {
  readonly deps: DispatchServiceDeps;
  readonly verification: DispatchVerification;
}
