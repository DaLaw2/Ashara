import { access } from "node:fs/promises";
import type { AttemptCellImage, BaseCellReference, Cell, EnvironmentImages, WorkdirInfo } from "@ashara/execution-infra";
import {
  WorktreeCommitIncomplete,
  cleanupWorkdir,
  clearWorktreeSlot,
  commitAllChanges,
  commitPartialWork,
  createCellBackend,
  createWorkdir,
  createWorkdirForRetry,
  ensureTargetGitInit,
  getChangedFiles,
  pruneStaleEnvironmentImages,
  recipePaths,
  resolveCurrentEnvironment,
  targetRepo,
  withTargetCheckout,
} from "@ashara/execution-infra";
import type { ContextualTurnLlm } from "@ashara/finance";
import { buildKnowledgeQueryText, storeFailureKnowledge } from "@ashara/knowledge";
import type { KnowledgeScope, KnowledgeSink, KnowledgeSource } from "@ashara/knowledge";
import {
  CheckRecorder,
  ConflictRetryUnprepared,
  NO_AGENT,
  NO_CHANGE_REASON,
  TaskVerification,
  VerificationInfrastructureFault,
  CONFLICT_MARKERS_LEFT,
  WORK_FAILED,
  agentWorkOf,
  asharaBlocked,
  branchChangedPaths,
  branchExists,
  cellImageOf,
  checkAreaOf,
  checkBranchName,
  conflictWithMain,
  deleteSettledTaskBranch,
  describeAgentWork,
  discardCheckWorkdir,
  dropCheckBranch,
  environmentBlocked,
  environmentCheckPort,
  environmentErrorOf,
  failedBeforeAgent,
  finalizeSuccess,
  formatChecksForBrief,
  formatConflictForBrief,
  formatFoundationForCheckAuthor,
  formatProjectChecksForCheckAuthor,
  headCommit,
  mainMergedForRetry,
  readEnvironmentDefinition,
  sessionEnvironmentVersion,
  stagedConflictMarkers,
  substrateBlocked,
  taskBranchName,
  thrownBlocked,
  unavailableOf,
} from "@ashara/quality";
import type {
  AgentWork,
  DispatchEnvironment,
  DispatchRef,
  DispatchWork,
  EnvironmentStatementStore,
  ExecutionEventSink,
  ExecutionResult,
  FinalizeDeps,
  MainConflict,
  SuiteReviewing,
  TaskCheckStore,
  TaskChecks,
  VerificationCells,
  WorkPlan,
} from "@ashara/quality";
import type { Clock, ProjectId, WorkItemId } from "@ashara/shared";
import type { AgentBrief, ErrorEnvelope } from "@ashara/workplace";
import { describeErrorChain, parseWorkItemId, wrapError } from "@ashara/shared";
import { createAgentBrief, createSessionId, turnFailureOf } from "@ashara/workplace";
import {
  ProjectIntentUnavailable,
  attemptSummary,
  buildContextMap,
  formatAcceptanceCriteria,
  formatTaskSpec,
  loadProjectIntent,
  outcomeRecord,
  priorAttemptFailure,
  renderKnowledgeContext,
  runAttempt,
  toSessionAttempt,
  withSessionLifecycle,
} from "@ashara/workplace";
import type {
  AssignmentStaff,
  AttemptSlot,
  KnowledgeSection,
  Outcome,
  ProjectIntentSource,
  SessionStore,
  TaskSpec,
} from "@ashara/workplace";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { StoredTaskSpec } from "../work-item-language/task-spec.js";
import type { WorkKind } from "../acl/organization-acl.js";
import { attemptProfileOf } from "../acl/workplace-acl.js";
import { DispatchRecords } from "./dispatch-records.js";

// Delivery's dispatch of one task (ADR-075): it resolves what decides the work, builds the brief,
// staffs the attempt, runs it in Workplace and hands every verdict to Quality's TaskVerification.
// What happens to the task afterwards is the core loop's (execution.ts), from the ExecutionResult.

/**
 * What the disk says of a worktree after its cleanup: null when it is gone (ENOENT), otherwise what
 * is left. An answer other than ENOENT is never read as "gone": it is reported with its cause.
 */
async function worktreeLeft(workDir: string): Promise<string | null> {
  try {
    await access(workDir);
    return "is still on disk after cleanup";
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return null;
    return `could not be checked after cleanup: ${describeErrorChain(e)}`;
  }
}

function attemptCellImage(environment: DispatchEnvironment): AttemptCellImage {
  if (environment.kind === "base-cell") return { kind: "base-cell", image: environment.image, digest: environment.digest };
  const { version, commit, imageId, imageRef } = environment;
  return { kind: "environment", version, commit, imageId, imageRef };
}

function briefEnvironment(environment: DispatchEnvironment): AgentBrief["projectEnvironment"] {
  if (environment.kind === "base-cell") return { kind: "to-define" };
  return { kind: "defined", version: environment.version, statement: environment.statement };
}

/** A task no work plan can be made for: it fails before the agent, with the reason. */
interface Unplannable {
  readonly kind: "unplannable";
  readonly operation: string;
  readonly reason: string;
}

/**
 * No environment the task's cells could be built from: Blocked with `environment_undefined`
 * before anything ran, never a BaseCell fallback (s-platform-role-m1 C2).
 */
function environmentUndefined(
  task: DispatchRef,
  sessionId: string,
  reason: string,
  eventSink: ExecutionEventSink | undefined,
): ExecutionResult {
  const taskId = task.id;
  const chain = wrapError("development", "resolveCurrentEnvironment", reason, { taskId });
  const summary = `no environment for task ${taskId}: ${reason}; no agent ran and nothing executed`;
  console.warn(`[${taskId}] ${summary}`);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: task.attempt, stage: "resolveCurrentEnvironment", reason: summary });
  return {
    status: "environment_undefined",
    reason,
    detail: summary,
    outcome: null,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: { outcome: "blocked", summary, chain },
  };
}

/**
 * No roster role can work the task: Blocked with `owner_unresolved` before any worktree or cell
 * exists. No default role is substituted (s-team-roster-m1).
 */
function ownerUnresolved(
  task: DispatchRef,
  sessionId: string,
  unresolved: OwnerUnresolved,
  eventSink: ExecutionEventSink | undefined,
): ExecutionResult {
  const taskId = task.id;
  const chain = wrapError("development", "assignAgent", unresolved.reason, { taskId, ownerRoleId: unresolved.ownerRoleId });
  const summary = `no roster role can work task ${taskId}: ${unresolved.reason}; no agent ran and nothing executed`;
  console.warn(`[${taskId}] ${summary}`);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: task.attempt, stage: "assignAgent", reason: summary });
  return {
    status: "owner_unresolved",
    ownerRoleId: unresolved.ownerRoleId,
    rosterRevision: unresolved.rosterRevision,
    reason: unresolved.reason,
    detail: summary,
    outcome: null,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: { outcome: "blocked", summary, chain },
  };
}

/** The cells every dispatch runs on: verification's, and the BaseCell. */
interface ExecutionCells extends VerificationCells {
  /** The image the Sprint 0 task's cells start from (config/base-cell.toml); no other task uses it. */
  readonly baseCell: BaseCellReference;
}

/** Who works a task and on which model: the task's owner role, as the project's roster names it. */
type AgentStaff = AssignmentStaff;

/**
 * A task no role of the roster can work: it has no owner, or its owner is not in the project's
 * latest roster. The dispatch blocks; no default role stands in for the owner.
 */
interface OwnerUnresolved {
  readonly kind: "owner-unresolved";
  /** The work item's stored owner_role_id; null when it has none. */
  readonly ownerRoleId: string | null;
  /** The project's latest roster revision the decision was made against; null when it has none. */
  readonly rosterRevision: number | null;
  readonly reason: string;
}

type Staffing = { readonly kind: "staffed"; readonly staff: AgentStaff } | OwnerUnresolved;

/**
 * Builds the agent half of a task's Assignment: its owner role and its model, resolved once per
 * attempt and never inside it (ADR-074 d44). The composition root supplies it. A model that
 * cannot be resolved throws and fails the dispatch.
 */
export interface AgentStaffing {
  staff(task: TaskDescriptor): Promise<Staffing>;
}

/** The limits of one attempt; the wall clock is the attempt's own (ADR-074 d56, 20 minutes). */
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
   * WorkItem hierarchy) before constructing this descriptor (kl-t2/Q5). `null`
   * means the walk ran and found no Epic ancestor. Required: a parent is not an Epic, so no
   * other field may stand in for it at the knowledge write.
   */
  readonly epicId: string | null;
  /**
   * Number of times this task has been dispatched. The DB column is NOT NULL
   * with default 0, `createPendingWorkItem` always sets it, and the sole
   * production construction site (orchestrator/execution.ts) always passes it.
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
   * sole construction site (orchestrator/execution.ts) always has the WorkItem.
   * An empty array means "no criteria stated" and the brief section is omitted;
   * undefined would be a second way to spell "none" that costs a supplier check
   * on every new construction site.
   */
  readonly successCriteria: readonly string[];
}

/** Everything one dispatch holds once its cell is up. */
interface Dispatch {
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

/**
 * The stored check a dispute names, with the revision holding it and the task it decides: one of
 * the dispatched task's own checks when `ofTask` is null, else one of the merged task `ofTask`'s
 * latest checks (the regression suite its merge must pass). null when no stored check is so named.
 */
function disputedCheckOf(
  taskId: string,
  work: Extract<DispatchWork, { readonly kind: "stored-checks" }>,
  checkName: string,
  ofTask: string | null,
): { readonly revision: TaskChecks; readonly check: TaskChecks["checks"][number]; readonly checksOf: string } | null {
  const revision = ofTask === null ? work.stored : work.merged.find((prior) => prior.taskId === ofTask);
  if (revision === undefined) return null;
  const check = revision.checks.find((candidate) => candidate.name === checkName);
  if (check === undefined) return null;
  return { revision, check, checksOf: ofTask ?? taskId };
}

interface DispatchServiceDeps {
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
   * The environment substrate (s-platform-role-m1): builds an environment version's image for
   * build_environment, the substrate gate and every later task's cells, and keeps the Sprint 0
   * task's stack statement.
   */
  readonly environment: {
    readonly images: EnvironmentImages;
    readonly statements: EnvironmentStatementStore;
  };
  /**
   * Quality's task checks (s-independent-verify-m1): a check task stores the checks it wrote, and
   * an implementation task is decided by them. Required: no task is verified without them.
   */
  readonly checks: TaskCheckStore;
  /**
   * Quality's review of a plan revision's suites (ADR-074 addendum 2 d71 c): a review task is
   * dispatched to it, never to an agent, so it runs no cell. Required: no implementation is released
   * without it.
   */
  readonly suiteReview: SuiteReviewing;
  /** Aborted on shutdown: an attempt in flight ends as cancelled. */
  readonly shutdownSignal: AbortSignal;
  /** What an attempt's wall clock reads. */
  readonly clock: Clock;
}

export class DispatchService {
  private readonly deps: DispatchServiceDeps;
  /** Quality's verification of this service's dispatches; the acceptance sweep is run on it too. */
  readonly verification: TaskVerification;

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps;
    this.verification = new TaskVerification({
      config: deps.config,
      cells: deps.cells,
      attemptPolicy: deps.attemptPolicy,
      environment: deps.environment,
      checks: deps.checks,
      suiteReview: deps.suiteReview,
      ...(deps.eventSink === undefined ? {} : { eventSink: deps.eventSink }),
    });
  }

  /**
   * `targetProjectPath` is the project's validated target checkout: a project without one is
   * blocked by the caller before dispatch, since only that checkout gives the worktree a git dir
   * Z0 owns (execution-infra's host-git.ts) and the merge a place to land.
   */
  async execute(task: TaskDescriptor, targetProjectPath: string): Promise<ExecutionResult> {
    try {
      return await this.executeTask(task, targetProjectPath);
    } finally {
      // Every build_environment call leaves an image: once the environment task
      // ends, however it ends, only main's current version and images in use are kept.
      if (task.workKind === "environment") {
        await pruneStaleEnvironmentImages(task.projectId, targetProjectPath, this.deps.environment.images, readEnvironmentDefinition);
      }
    }
  }

  private async executeTask(task: TaskDescriptor, targetProjectPath: string): Promise<ExecutionResult> {
    const { config, eventSink, cells } = this.deps;
    const sessionId = createSessionId();
    const base = config.workdirBase;

    eventSink?.emit({
      event: "task_started",
      taskId: task.id,
      attempt: task.attempt,
      title: task.title,
      // The stored goal or none: a task without one is never given its title as a goal.
      goal: task.taskSpec?.goal,
      // The stored grade as it is (ADR-074 addendum 2 d70), never a default: staffing refuses a task
      // without one, and the model it is staffed with is emitted when its attempt starts.
      capability: task.taskSpec?.capability,
    });

    // A review of the plan's suites reads stored checks and the vision in one structured call: no
    // substrate, environment, worktree or cell is involved, so none is probed.
    if (task.taskSpec?.origin === "review") {
      const reviewed = await this.verification.reviewSuites(task, sessionId, targetProjectPath);
      if (reviewed.status === "failed") await storeFailureKnowledge(this.deps.knowledgeSink, task, reviewed);
      return reviewed;
    }

    // First, before the brief (which may call an LLM) or the
    // worktree: a substrate that cannot host the task blocks it here, so no
    // later path can fall through to host execution.
    try {
      await cells.substrate.probeSubstrate();
    } catch (e) {
      return thrownBlocked(task, sessionId, "probeSubstrate", e, { step: "probe the container substrate", cell: "container substrate" }, NO_AGENT, eventSink);
    }

    // Only the environment role's work and the product scaffold are checked by the substrate: any
    // other task so marked would skip verification without being able to build what the gate checks.
    const substrateKind = task.taskSpec?.origin === "product-scaffold" ? "implementation" : "environment";
    if (task.taskSpec?.checkedBy === "substrate" && task.workKind !== substrateKind) {
      const result = failedBeforeAgent(
        task,
        sessionId,
        "checkSubstrateGate",
        `task_spec.checkedBy is "substrate" but the task's work kind is ${task.workKind ?? "unrecorded"}, not ${substrateKind}`,
        `no gate can check ${task.id}`,
      );
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }

    // Before the brief, the worktree and any cell: every cell of the task is started from what
    // this resolves, and a project with nothing to build them from blocks here.
    let environment: DispatchEnvironment;
    if (task.taskSpec?.origin === "sprint0") {
      environment = { kind: "base-cell", image: cells.baseCell.image, digest: cells.baseCell.digest };
    } else {
      try {
        const resolution = await resolveCurrentEnvironment(
          task.projectId,
          targetRepo(targetProjectPath),
          this.deps.environment.images,
          this.deps.environment.statements,
          readEnvironmentDefinition,
        );
        // No lesson: nothing of the agent's ran (fault-class.ts), the plan's repair answers it.
        if (resolution.kind === "undefined") return environmentUndefined(task, sessionId, resolution.reason, eventSink);
        environment = { kind: "environment", ...resolution.environment };
      } catch (e) {
        const where = { step: "resolve the current environment", cell: "environment image build" };
        return thrownBlocked(task, sessionId, "resolveEnvironment", e, where, NO_AGENT, eventSink);
      }
      eventSink?.emit({
        event: "environment_resolved",
        taskId: task.id,
        attempt: task.attempt,
        version: environment.version,
        commit: environment.commit,
        imageId: environment.imageId,
        imageRef: environment.imageRef,
        reused: environment.reused,
      });
    }

    // Before the brief and any model call: what decides the work. An implementation task with no
    // stored checks, or a check task that decides no single task, is not dispatched; neither is a
    // task whose stored spec lacks a field the brief states, since the brief would have to invent it.
    const unplannable = async (refused: Unplannable): Promise<ExecutionResult> => {
      const result = failedBeforeAgent(task, sessionId, refused.operation, refused.reason, `no work plan for ${task.id}`);
      eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    };
    const read = briefSpecOf(task);
    if (read.kind === "unplannable") return unplannable(read);
    const { spec } = read;
    let plan: WorkPlan;
    try {
      const planned = await this.planWork(task, environment);
      if (planned.kind === "unplannable") return await unplannable(planned);
      plan = planned;
    } catch (e) {
      return thrownBlocked(task, sessionId, "planWork", e, { step: "read the checks that decide the work", cell: "CI cell" }, NO_AGENT, eventSink);
    }

    // A retry resumes the task's branch. When it conflicts with main (a batch partner merged the
    // same files first), the attempt starts with main merged into it and the conflict in
    // its worktree, named in its brief: the branch as it is would only conflict again. A conflict
    // that cannot be prepared is Z0's git and blocks under class ashara, never dispatching the branch unchanged.
    // A branch that merges cleanly starts with main merged into it (a tree regression is repaired
    // on the merged tree it was found on, createWorkdirForRetry).
    let resumesBranch = false;
    try {
      if (plan.kind !== "check-authoring") {
        // A fresh target has no repository yet: initialised first (as createWorkdir does), so git
        // is asked of a repository and its answer is never "no repository" read as "no branch".
        await withTargetCheckout(targetProjectPath, `the git init before task ${task.id}'s branch is looked up`, () => ensureTargetGitInit(targetProjectPath, base));
        resumesBranch = await branchExists(targetProjectPath, taskBranchName(task.id));
      }
    } catch (e) {
      return thrownBlocked(task, sessionId, "resumeBranch", e, { step: "read whether the task branch exists", cell: "host git" }, NO_AGENT, eventSink);
    }
    let conflict: MainConflict | null = null;
    if (resumesBranch) {
      try {
        conflict = await conflictWithMain(targetProjectPath, task.id);
      } catch (e) {
        return this.conflictUnprepared(task, sessionId, e);
      }
      if (conflict !== null) {
        eventSink?.emit({ event: "merge_conflict_presented", taskId: task.id, attempt: task.attempt, mainCommit: conflict.mainCommit, files: conflict.files });
      }
    }

    let brief: AgentBrief;
    try {
      brief = await this.buildBrief(task, spec, targetProjectPath, environment, plan, conflict);
    } catch (e) {
      // A missing or unreadable intent (ProjectIntentUnavailable) is Ashara's own record, as is any
      // other throw building the brief: never the agent's work, so blocked under class ashara.
      const step = e instanceof ProjectIntentUnavailable ? "load the project's intent" : "build the brief";
      return thrownBlocked(task, sessionId, "buildBrief", e, { step, cell: "brief" }, NO_AGENT, eventSink);
    }

    // The Assignment's agent half, once per attempt: a model that cannot be
    // resolved (routing, budget) fails the dispatch before any worktree exists.
    let staff: AgentStaff;
    let records: DispatchRecords;
    try {
      const staffing = await this.deps.staffing.staff(task);
      if (staffing.kind === "owner-unresolved") return ownerUnresolved(task, sessionId, staffing, eventSink);
      staff = staffing.staff;
      records = new DispatchRecords(base, task.id, sessionId);
      await records.writeBrief(brief);
    } catch (e) {
      return thrownBlocked(task, sessionId, "assignAgent", e, { step: "staff the attempt and write its brief", cell: "attempt records" }, NO_AGENT, eventSink);
    }

    // A check task works on a throwaway branch fresh from main, never on a task branch: nothing of
    // it is merged, and a retry starts again from main.
    let workdir: WorkdirInfo;
    let work: DispatchWork;
    try {
      if (plan.kind === "check-authoring") {
        const branch = checkBranchName(task.id);
        // A worktree a crash left registered holds the branch, and git refuses to delete it.
        await clearWorktreeSlot(base, targetProjectPath, branch);
        await dropCheckBranch(targetProjectPath, branch);
        workdir = await createWorkdir(base, targetProjectPath, branch);
        try {
          work = { ...plan, branch, startCommit: await headCommit(workdir.repo, task.id), recorder: new CheckRecorder(plan.citedItems) };
        } catch (e) {
          await discardCheckWorkdir(workdir.workDir, targetProjectPath, branch);
          throw e;
        }
      } else {
        workdir = resumesBranch
          ? await createWorkdirForRetry(base, targetProjectPath, taskBranchName(task.id), mainMergedForRetry(task.id, conflict))
          : await createWorkdir(base, targetProjectPath, taskBranchName(task.id));
        work = plan;
      }
    } catch (e) {
      if (e instanceof ConflictRetryUnprepared) return this.conflictUnprepared(task, sessionId, e);
      return thrownBlocked(task, sessionId, "createWorkdir", e, { step: "create the task worktree", cell: "host git" }, NO_AGENT, eventSink);
    }
    const { workDir, repo } = workdir;

    // The task's cell mounts only its worktree, labelled with the owner role's id. Its `.git` is a
    // throwaway repository of the cell's own (PodmanSubstrate): the gitlink names the git dir's host
    // path, and Z0 alone uses that git dir. A substrate that vanished since the probe, or a cell that
    // cannot start, still blocks: never a host fallback.
    let cell: Cell;
    try {
      cell = await cells.substrate.createCell({
        image: cellImageOf(environment),
        project: task.projectId,
        task: task.id,
        role: staff.role.id,
        instance: cells.instance,
        mount: { hostPath: workDir },
      });
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      return thrownBlocked(task, sessionId, "createCell", e, { step: "create the task cell", cell: "task cell" }, NO_AGENT, eventSink);
    }
    eventSink?.emit({ event: "cell_created", taskId: task.id, attempt: task.attempt, cellId: cell.id, roleId: staff.role.id, role: staff.role.name, image: cellImageOf(environment), cellImage: attemptCellImage(environment) });

    const dispatch: Dispatch = {
      task,
      brief,
      staff,
      cell,
      records,
      targetProjectPath,
      workDir,
      repo,
      sessionId,
      environment,
      work,
      conflict,
    };

    try {
      const result = await withSessionLifecycle(
        this.deps.sessionStore,
        { sessionId, taskId: task.id, brief, environmentVersion: sessionEnvironmentVersion(environment) },
        (slot) => this.runExecution(dispatch, slot),
      );
      // ONE seam covering every return path inside runExecution (kl-t4): only the agent's own work
      // failing is a lesson about the task (fault-class.ts). A substrate or Z0 fault, a refused call,
      // stale stored checks, a disputed check, a requested environment change and a shutdown are not.
      if (result.status === "failed" || result.status === "blocked") {
        await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      }
      return result;
    } catch (e) {
      // A throw no stage caught: never the agent's work, so blocked under its class, no lesson.
      eventSink?.emit({ event: "error", location: "DispatchService:execute", taskId: task.id, attempt: task.attempt, error: describeErrorChain(e) });
      await cleanupWorkdir(workDir, targetProjectPath);
      return thrownBlocked(task, sessionId, "runExecution", e, { step: "run the dispatch", cell: "task cell" }, { outcome: null, agentWork: "unknown" }, eventSink);
    } finally {
      await this.verification.teardownCell({ taskId: task.id, attempt: task.attempt }, cell);
    }
  }

  /**
   * What decides the task's work. Sprint 0 is checked by the substrate; a check task's checks are
   * red-run by Z0 and it must decide exactly one implementation task; every other task is decided
   * by the latest checks stored for it, and with none stored it is unplannable (never verified
   * from nothing).
   */
  private async planWork(task: TaskDescriptor, environment: DispatchEnvironment): Promise<WorkPlan | Unplannable> {
    // The product scaffold is decided by the product's build and test from the definition on its
    // merge: no check can be written for a layout that does not exist yet (ADR-074 addendum 2 d72 B2).
    if (task.taskSpec?.origin === "product-scaffold") {
      if (task.taskSpec.checkedBy !== "substrate" || environment.kind !== "environment") {
        return {
          kind: "unplannable",
          operation: "checkSubstrateGate",
          reason: `product scaffold ${task.id} needs task_spec.checkedBy "substrate" and a defined environment to run the product's build and test in`,
        };
      }
      return { kind: "scaffold" };
    }
    if (task.taskSpec?.checkedBy === "substrate") return { kind: "substrate" };
    // Environment work (Sprint 0, and every environment task an implementation requested) is decided
    // by the substrate gate alone: stored checks and the implementer's ownership gate would refuse
    // the very files it exists to write.
    if (task.workKind === "environment") {
      return {
        kind: "unplannable",
        operation: "checkSubstrateGate",
        reason: `environment task ${task.id} is not checked by the substrate (task_spec.checkedBy), the only gate environment work has`,
      };
    }
    if (task.workKind === "check") {
      if (environment.kind !== "environment") {
        return { kind: "unplannable", operation: "resolveCheckedTask", reason: `check task ${task.id} has no environment to red-run its checks in` };
      }
      const checked = await this.deps.checks.checkedTasksOf(task.id);
      const [only] = checked;
      if (checked.length !== 1 || only === undefined) {
        return {
          kind: "unplannable",
          operation: "resolveCheckedTask",
          reason:
            `check task ${task.id} must decide exactly one implementation task, but its task_spec.checksFor names ` +
            `${checked.length} implementation task(s) on record [${checked.join(", ")}]`,
        };
      }
      // Every authoring, the first and each one after a dispute, a review or staleness, is red-run
      // on the same fixed commit, never on main as later merges left it (ADR-074 addendum 2 d74 A).
      const foundation = await this.deps.checks.foundationOf(task.id);
      if (foundation.kind === "none") {
        return { kind: "unplannable", operation: "resolveCheckFoundation", reason: `no foundation to red-run the checks on: ${foundation.reason}` };
      }
      // ADR-083: its checks are kept only when they decide every item it cites, so a check task that
      // records none has nothing its checks could be judged complete against.
      // eslint-disable-next-line no-restricted-syntax -- policy default: an absent sources list cites no item, which the unplannable refusal below rejects as an empty one
      const [firstCited, ...restCited] = (task.taskSpec?.sources ?? []).map((source) => source.id);
      if (firstCited === undefined) {
        return {
          kind: "unplannable",
          operation: "resolveCitedItems",
          reason: `check task ${task.id} records no vision item it cites (task_spec.sources), so no check set of it can be judged to decide them`,
        };
      }
      const prior = await this.deps.checks.latest(parseWorkItemId(only, "TaskCheckStore.checkedTasksOf"));
      return {
        kind: "check-authoring",
        checkedTaskId: only,
        environment,
        prior,
        foundation: { taskId: foundation.taskId, commit: foundation.commit },
        citedItems: [firstCited, ...restCited],
      };
    }
    const stored = await this.deps.checks.latest(task.id);
    if (stored === null || stored.checks.length === 0) {
      return {
        kind: "unplannable",
        operation: "loadTaskChecks",
        reason: `no checks are stored for task ${task.id}: its check task has not recorded any, so nothing could decide its work`,
      };
    }
    const merged = (await this.deps.checks.completedOf(task.projectId, task.id)).checked;
    return { kind: "stored-checks", stored, merged };
  }

  private async buildBrief(
    task: TaskDescriptor,
    spec: TaskSpec,
    targetProjectPath: string,
    environment: DispatchEnvironment,
    plan: WorkPlan,
    conflict: MainConflict | null,
  ): Promise<AgentBrief> {
    const priorFailure = priorAttemptFailure(task.id, task.blockedReason?.source === "replan" ? task.blockedReason.replanContext : undefined);

    // A ProjectIntentUnavailable propagates to execute() and blocks the task.
    const projectIntent = await loadProjectIntent(this.deps.intentSource, task.id);

    const contextMap = await buildContextMap(targetProjectPath);
    const knowledgeContext = await this.buildKnowledgeContext(task, spec);

    // createAgentBrief: the compiler checks the shape at this construction site,
    // and the Zod parse underneath throws on a malformed brief, which blocks the
    // task rather than shipping a degraded one.
    const acceptanceSection = formatAcceptanceCriteria(task.successCriteria);
    const formattedTaskSpec = formatTaskSpec(spec);
    const specContext = acceptanceSection ? `${formattedTaskSpec}\n\n${acceptanceSection}` : formattedTaskSpec;
    let taskContext = specContext;
    if (plan.kind === "stored-checks") taskContext = `${specContext}\n\n${formatChecksForBrief(plan.stored)}`;
    if (conflict !== null) taskContext = `${taskContext}\n\n${formatConflictForBrief(conflict)}`;
    if (plan.kind === "check-authoring") {
      const stored = await this.deps.checks.storedOfProject(task.projectId, plan.checkedTaskId);
      taskContext = `${specContext}\n\n${formatProjectChecksForCheckAuthor(stored)}\n\n${formatFoundationForCheckAuthor(plan.foundation, checkAreaOf(plan.checkedTaskId))}`;
    }
    // Named before work starts (ADR-074 addendum 2 d66 c, d72): what the ownership gate refuses,
    // and the inputs whose change rebuilds the environment.
    const protectedPaths: AgentBrief["protectedPaths"] =
      environment.kind === "environment"
        ? {
            recipe: [...recipePaths(environment.definition)],
            checkFiles: [...new Set((await this.deps.checks.checkFilesOf(task.projectId)).map((file) => file.path))].sort(),
            inputs: [...environment.definition.inputs],
          }
        : undefined;
    return createAgentBrief(
      {
        taskId: task.id,
        goal: spec.goal,
        ...projectIntent,
        projectEnvironment: briefEnvironment(environment),
        context: taskContext,
        deliverables: spec.deliverables,
        knowledgeContext,
        contextMap,
        ...(priorFailure !== undefined ? { priorAttemptFailure: priorFailure } : {}),
        ...(protectedPaths !== undefined ? { protectedPaths } : {}),
      },
      "development:buildBrief",
    );
  }

  private async buildKnowledgeContext(task: TaskDescriptor, spec: TaskSpec): Promise<string> {
    const source = this.deps.knowledgeSource;
    if (!source) return "";

    const scope: KnowledgeScope = {
      projectId: task.projectId,
      epicId: task.epicId,
      queryText: buildKnowledgeQueryText(task.title, spec),
    };

    const sections: KnowledgeSection[] = [];

    try {
      const findings = await source.recentFindings(scope, 10);
      sections.push({
        heading: "## Recent Findings",
        entries: findings.map((f) => `- "${f.title}" (source: ${f.source})\n  ${f.contentSnippet}`),
      });
    } catch (e: unknown) {
      console.warn(`[buildKnowledgeContext] Failed to retrieve recent findings: ${describeErrorChain(e)}`);
    }

    try {
      const approaches = await source.failedApproaches(scope, 10);
      sections.push({
        heading: "## Failed Approaches — do not repeat",
        entries: approaches.map((a) => `- "${a.title}" — Failed: ${a.failureReason}\n  Learned: ${a.learned}`),
      });
    } catch (e: unknown) {
      console.warn(`[buildKnowledgeContext] Failed to retrieve failed approaches: ${describeErrorChain(e)}`);
    }

    return renderKnowledgeContext(sections);
  }

  private async runExecution(d: Dispatch, slot: AttemptSlot): Promise<ExecutionResult> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, brief, staff, workDir, targetProjectPath, sessionId } = d;

    // Before every implementation dispatch, before the model is called at all (ADR-074 addendum 2
    // d74 A): checks red-run on another environment version are trusted only once they hold the
    // red-run rule on their baseline in this dispatch's image; then work already on main is closed as
    // delivered, whoever delivered it. In that order: a set that cannot tell the task's work from its
    // absence would pass on main whatever main holds, and close the task on nothing.
    if (d.work.kind === "stored-checks") {
      const stale = await this.verification.revalidateOnBaseline(d, d.work.stored);
      if (stale !== null) return stale;
      const delivered = await this.verification.sweepDelivered(d, d.work.stored);
      if (delivered !== null) return delivered;
    }
    // A check author is dispatched only on a foundation the environment builds: on one it
    // does not, every check fails for that reason alone and the red run could decide nothing.
    if (d.work.kind === "check-authoring") {
      const unbuilt = await this.verification.foundationBuildGate(d, d.work);
      if (unbuilt !== null) return unbuilt;
    }

    eventSink?.emit({
      event: "agent_launched",
      taskId: task.id,
      attempt: task.attempt,
      workDir,
      cellId: d.cell.id,
      roleId: staff.role.id,
      role: staff.role.name,
      provider: staff.model.provider,
      model: staff.model.modelId,
      records: d.records.dir,
    });

    const outcome = await runAttempt(
      {
        projectId: task.projectId,
        taskId: task.id,
        role: staff.role,
        ...attemptProfileOf(task.workKind),
        brief,
        cellImage: attemptCellImage(d.environment),
        model: staff.model,
        limits: { maxTurns: attemptPolicy.maxTurns, perCommandTimeoutSeconds: attemptPolicy.perCommandTimeoutSeconds },
      },
      {
        llm: this.deps.llm,
        cell: createCellBackend(d.cell, { toolTimeoutSeconds: attemptPolicy.toolTimeoutSeconds }),
        clock: this.deps.clock,
        records: d.records,
        signal: this.deps.shutdownSignal,
        environment: task.workKind === "environment" ? environmentCheckPort(this.verification.environmentScope(d)) : null,
        checks: d.work.kind === "check-authoring" ? this.verification.checkDefinitionPort(d, d.work) : null,
        taskChecks: d.work.kind === "stored-checks" ? this.verification.taskCheckRunPort(d, d.work.stored, d.work.merged) : null,
      },
    );
    slot.attempt = toSessionAttempt(outcome, staff.model, attemptCellImage(d.environment));
    // Observe the workdir BEFORE cleanup: after cleanupWorkdir the worktree is gone.
    const filesChanged = await getChangedFiles(d.repo);
    eventSink?.emit({
      event: "agent_completed",
      taskId: task.id,
      attempt: task.attempt,
      outcome: outcome.kind,
      turns: outcome.turnsUsed,
      cost: outcome.cost.measured ? outcome.cost.totalUsd : outcome.cost.measuredUsd,
      costMeasured: outcome.cost.measured,
      summary: attemptSummary(outcome),
      filesChanged,
    });

    if (!(outcome.kind === "finished" && outcome.status === "done")) {
      return this.endWithoutDone(d, outcome);
    }

    // A check may need no file of its own, so a check task is judged by its checks, not its diff.
    if (d.work.kind === "check-authoring") return this.verification.keepChecks(d, d.work, outcome);

    if (d.conflict !== null) {
      const unresolved = await this.conflictResolution(d, d.conflict, outcome);
      if (unresolved !== null) return unresolved;
    }

    // "No changes" is judged on the task branch against main (ADR-074 addendum 2 d65 d), not on this
    // attempt's own edits: a re-dispatch may find its work already committed there by an earlier
    // dispatch (endWithoutDone's partial-work commit) and rightly finish done without editing.
    let workChanged: readonly string[] = filesChanged;
    if (filesChanged.length === 0) {
      const onBranch = await this.branchWork(d, outcome);
      if (onBranch.kind === "ended") return onBranch.result;
      workChanged = onBranch.paths;
      // Work already on main (ADR-074 addendum 2 d67 b) is decided by its checks on main, never by the word of an implementer that changed nothing.
      if (workChanged.length === 0 && d.work.kind === "stored-checks") return this.verification.deliveredOnMain(d, d.work.stored, { outcome, agentWork: "kept" }, outcome.turnsUsed);
      if (workChanged.length === 0) {
        const reason = NO_CHANGE_REASON;
        eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
        await cleanupWorkdir(workDir, targetProjectPath);
        const chain = wrapError("development", "agentExecution", reason, { taskId: task.id, turnCount: outcome.turnsUsed });
        return {
          status: "failed",
          verdict: WORK_FAILED,
          detail: reason,
          outcome,
          sessionId,
          attempt: task.attempt,
          errorEnvelope: { outcome: "failed", summary: reason, chain, agentOutput: outcomeRecord(outcome) },
        };
      }
      eventSink?.emit({ event: "branch_work_found", taskId: task.id, attempt: task.attempt, paths: workChanged });
    } else {
      const uncommitted = await this.commitWork(d, outcome);
      if (uncommitted !== null) return uncommitted;
    }

    if (d.work.kind === "stored-checks" || d.work.kind === "scaffold") {
      const refused = await this.verification.ownershipGate(d, outcome);
      if (refused !== null) return refused;
    }

    let finalizeDeps: Omit<FinalizeDeps, "presentedConflict" | "workdirBase">;
    if (d.work.kind === "substrate") {
      const gate = await this.verification.substrateGate(d, outcome.statement, outcome);
      if (gate.kind === "ended") return gate.result;
      finalizeDeps = {
        postMergeOperation: "postMergeVerify",
        postMergeVerify: (path, lease) => this.verification.postMergeEnvironmentTest(d, path, gate.tested, lease),
      };
    } else if (d.work.kind === "scaffold") {
      // No gate ran the scaffold's build and test before its merge: their verdict there is its
      // own attempt's, never a regression of the tree (ADR-074 addendum 2 d74 D).
      finalizeDeps = {
        postMergeOperation: "postMergeScaffold",
        postMergeVerify: (path, lease) => this.verification.postMergeScaffold(d, path, lease),
      };
    } else {
      const { stored } = d.work;
      finalizeDeps = {
        postMergeOperation: "postMergeTaskChecks",
        postMergeVerify: (path, lease) => this.verification.postMergeStoredChecks(d, path, stored, lease),
      };
    }

    const finalizeResult = await finalizeSuccess(
      { ...finalizeDeps, presentedConflict: d.conflict, workdirBase: this.deps.config.workdirBase },
      task,
      targetProjectPath,
      task.attempt,
    );
    if (!finalizeResult.success) {
      const { fault } = finalizeResult;
      if (fault.class === "substrate") {
        // The merge was aborted and the branch kept: the verifier cell's substrate
        // failed, which is the operator's to fix, not a regression of the tree.
        await cleanupWorkdir(workDir, targetProjectPath);
        return substrateBlocked(
          task,
          sessionId,
          "postMergeVerify",
          fault.error,
          "verifier cell",
          { outcome, agentWork: "kept" },
          eventSink,
          finalizeResult.errorLayer,
        );
      }
      if (fault.class === "ashara") {
        // No verdict was reached, so nothing is known of the task's work: blocked for the operator,
        // the merge aborted and the branch kept, never a failure the task is replanned against.
        await cleanupWorkdir(workDir, targetProjectPath);
        return asharaBlocked(task, sessionId, "postMergeCheckRun", fault.error, { outcome, agentWork: "kept" }, eventSink, finalizeResult.errorLayer);
      }
      const { verdict } = fault;
      const gateChain = finalizeResult.errorLayer;
      // The lesson carries what failed: which suite and which check, and whether it was a regression.
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `${finalizeResult.failedStep === "merge" ? "merge into main failed" : "post-merge verify failed"} for ${task.id}:\n${finalizeResult.gateFailureContext}`,
        chain: gateChain,
        agentOutput: outcomeRecord(outcome),
      };
      eventSink?.emit({
        event: "gate_failed",
        taskId: task.id,
        attempt: task.attempt,
        reason: envelope.summary,
      });
      await cleanupWorkdir(workDir, targetProjectPath);
      return {
        status: "failed",
        verdict,
        detail: envelope.summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: envelope,
      };
    }

    await cleanupWorkdir(workDir, targetProjectPath);
    await deleteSettledTaskBranch(targetProjectPath, task.id, "merged into main");
    // Stated from the disk, not assumed: cleanupWorkdir's own fallbacks are best-effort.
    const left = await worktreeLeft(workDir);
    if (left !== null) {
      console.warn(`[${task.id}] task completed — but worktree ${workDir} ${left}`);
    } else {
      console.log(`[${task.id}] task completed — worktree ${workDir} removed after the merge`);
    }
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "completed" });
    return {
      status: "completed",
      delivered: { kind: "merged", mergeCommit: finalizeResult.mergeCommit },
      detail: `merged on main as ${finalizeResult.mergeCommit}, after its post-merge checks passed on the merged tree`,
      outcome,
      sessionId,
      attempt: task.attempt,
    };
  }

  /**
   * The task's conflict with main could not be prepared for this attempt (ConflictRetryUnprepared),
   * or git could not even be asked: Z0's git, never the agent's work, so blocked under class ashara
   * (prepareConflictRetry). Nothing was dispatched, so the branch is never dispatched as it is; it
   * is kept as it was for the next dispatch to try again.
   */
  private conflictUnprepared(task: TaskDescriptor, sessionId: string, e: unknown): ExecutionResult {
    const where = { step: "prepare the task's conflict with main for its next attempt", cell: "host git" };
    return thrownBlocked(task, sessionId, "prepareConflictRetry", e, where, NO_AGENT, this.deps.eventSink);
  }

  /**
   * An attempt handed a conflict with main finished done: every conflicting file must be free of
   * conflict markers before anything is committed. Markers left fail the attempt under
   * conflictMarkersLeft with nothing committed (the merge is discarded with the worktree). Z0's git
   * failing blocks for the operator. Null when the conflict is resolved.
   */
  private async conflictResolution(d: Dispatch, conflict: MainConflict, outcome: Outcome): Promise<ExecutionResult | null> {
    const { task, workDir, targetProjectPath, sessionId } = d;
    let left: string[];
    try {
      left = await stagedConflictMarkers(d.repo, conflict.files);
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const fault = new VerificationInfrastructureFault(task.id, "conflict marker read of the task worktree", { cause: e });
      const chain = wrapError("development", "conflictResolution", fault, { taskId: task.id, errorClass: fault.name });
      return asharaBlocked(task, sessionId, "conflictResolution", fault, { outcome, agentWork: "merge-discarded" }, this.deps.eventSink, chain);
    }
    this.deps.eventSink?.emit({ event: "merge_conflict_resolution", taskId: task.id, attempt: task.attempt, files: conflict.files, markersLeft: left });
    if (left.length === 0) return null;
    await cleanupWorkdir(workDir, targetProjectPath);
    const summary = `the conflict of ${task.id} with main is not resolved: conflict markers are left in ${left.join(", ")}; nothing was committed or merged`;
    const chain = wrapError("development", "conflictMarkersLeft", summary, { taskId: task.id, mainCommit: conflict.mainCommit, conflictFiles: conflict.files, markersLeft: left });
    this.deps.eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: summary });
    return {
      status: "failed",
      verdict: CONFLICT_MARKERS_LEFT,
      detail: summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) },
    };
  }

  /**
   * Records the agent's work on the task branch, the only commit of a finished attempt: every gate
   * and the merge read the branch, so work it does not hold is never merged as if it were there.
   * Null when the commit holds all of it. A host git that refuses the commit blocks the task for
   * the operator; changes the commit left behind fail it.
   */
  private async commitWork(d: Dispatch, outcome: Outcome): Promise<ExecutionResult | null> {
    const { task, workDir, targetProjectPath, sessionId } = d;
    try {
      await commitAllChanges(d.repo, `ashara: agent output for task ${task.id}`);
      return null;
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      if (!(e instanceof WorktreeCommitIncomplete)) {
        // Z0's git refused to record the work (WorktreeCommitFailed), or anything else failed: never the agent's.
        return thrownBlocked(task, sessionId, "commitWork", e, { step: "commit the agent's work on the task branch", cell: "host git" }, { outcome, agentWork: "kept" }, this.deps.eventSink);
      }
      const chain = wrapError("development", "commitWork", e, { taskId: task.id });
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `the agent's work on ${task.id} was committed only in part, nothing merged: ${chain.message}`,
        chain,
        agentOutput: outcomeRecord(outcome),
      };
      this.deps.eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: envelope.summary });
      return { status: "failed", verdict: WORK_FAILED, detail: envelope.summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: envelope };
    }
  }

  /**
   * The paths the task branch changed since it left main, read through the target's hardened host
   * git, for an attempt that finished done with nothing uncommitted. Z0's git failing blocks for
   * the operator: an unreadable branch is never read as "no changes", nor as work to merge.
   */
  private async branchWork(
    d: Dispatch,
    outcome: Outcome,
  ): Promise<{ readonly kind: "paths"; readonly paths: readonly string[] } | { readonly kind: "ended"; readonly result: ExecutionResult }> {
    const { task, workDir, targetProjectPath, sessionId } = d;
    try {
      return { kind: "paths", paths: await branchChangedPaths(targetProjectPath, task.id, taskBranchName(task.id)) };
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure !== null) {
        return {
          kind: "ended",
          result: substrateBlocked(task, sessionId, "branchWork", environmentFailure, "host git", { outcome, agentWork: "kept" }, this.deps.eventSink),
        };
      }
      const fault = new VerificationInfrastructureFault(task.id, "task branch diff against main", { cause: e });
      const chain = wrapError("development", "branchWork", fault, { taskId: task.id, errorClass: fault.name });
      return { kind: "ended", result: asharaBlocked(task, sessionId, "branchWork", fault, { outcome, agentWork: "kept" }, this.deps.eventSink, chain) };
    }
  }

  /**
   * Every terminal except finished(done): finished(blocked) is `blocked`; a cell that failed under
   * the attempt is environment-blocked (the operator's to fix), and so is a model call that failed
   * (transport_exhausted), under the provider's or Ashara's class; every other terminal is `failed`
   * with the terminal named. None of them is read as completed on the agent's word: only a check
   * author's `blocked` whose checked task Z0 finds delivered on main completes (checkedTaskOnMain).
   */
  private async endWithoutDone(d: Dispatch, outcome: Outcome): Promise<ExecutionResult> {
    const { task, staff, workDir, targetProjectPath, sessionId } = d;
    let agentWork: Exclude<AgentWork, "none">;
    if (d.work.kind === "check-authoring") {
      // Nothing of a check task is kept for a retry: the next attempt starts again from main.
      await discardCheckWorkdir(workDir, targetProjectPath, d.work.branch);
      agentWork = "discarded";
    } else {
      agentWork = agentWorkOf(
        await commitPartialWork(d.repo, `ashara: partial work for retry (task ${task.id}, dispatch ${task.attempt}, ${outcome.kind})`),
      );
      await cleanupWorkdir(workDir, targetProjectPath);
    }

    // Discipline C: task, model, turns, last tool call and the terminal's own detail.
    const context = {
      taskId: task.id,
      role: staff.role,
      provider: staff.model.provider,
      model: staff.model.modelId,
      outcome: outcome.kind,
      turnCount: outcome.turnsUsed,
      lastToolCall: outcome.lastToolCall,
      records: d.records.dir,
    };

    if (outcome.kind === "environment_failure") {
      // Workplace already told the substrate's failure from the tool's own (classifyCellError);
      // a records sink that cannot write is the same kind of failure, on the Z0 side.
      // run_checks runs in a CI cell of its own, and Z0's machinery around it is no cell at all.
      const errorClass = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error;
      const typed = environmentErrorOf(outcome.error);
      const cell = outcome.lastToolCall?.toolName === "run_checks" ? "CI cell (run_checks)" : "task cell";
      // Substrate only by its class (fault-class.ts); records that cannot be written, Z0's
      // verification machinery and anything unclassified are Ashara's (fail-closed).
      const fault = outcome.source !== "records" && typed !== null ? "substrate" : "ashara";
      const unavailable =
        outcome.source === "records"
          ? "attempt records"
          : outcome.error instanceof VerificationInfrastructureFault
            ? `verification infrastructure (${outcome.error.step})`
            : typed !== null
              ? unavailableOf(typed, cell)
              : `Ashara's own machinery under the ${cell}`;
      return environmentBlocked(
        {
          task,
          sessionId,
          stage: "agentAttempt",
          fault,
          errorClass,
          message: `the attempt's environment failed (${outcome.source}) after ${outcome.turnsUsed} turn(s): ${outcome.detail}`,
          chain: wrapError("development", "agentAttempt", outcome.error, { ...context, source: outcome.source, errorClass }),
          unavailable,
          outcome,
          agentWork,
        },
        this.deps.eventSink,
      );
    }

    if (outcome.kind === "transport_exhausted") {
      // A model call that failed is never the agent's work: no answer of the model was read. It is
      // blocked under whose failure it was, the provider's or Ashara's own (turnFailureOf).
      const fault = turnFailureOf(outcome.error);
      const errorClass = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error;
      const model = `${staff.model.provider}/${staff.model.modelId}`;
      return environmentBlocked(
        {
          task,
          sessionId,
          stage: "agentAttempt",
          fault,
          errorClass,
          message: `the attempt's model call failed after ${outcome.turnsUsed} turn(s): ${outcome.detail}`,
          chain: wrapError("development", "agentAttempt", outcome.error, { ...context, errorClass, fault }),
          unavailable: fault === "provider" ? `model provider (${model})` : `Ashara's request to the model provider (${model})`,
          outcome,
          agentWork,
        },
        this.deps.eventSink,
      );
    }

    if (outcome.kind === "refused") {
      const summary = `attempt stopped after ${outcome.turnsUsed} turn(s): ${outcome.detail}; ${describeAgentWork(agentWork)}`;
      console.warn(`[${task.id}] ${summary}`);
      this.deps.eventSink?.emit({ event: "task_refused", taskId: task.id, attempt: task.attempt, errorClass: outcome.error.name, reason: summary });
      return {
        status: "refused",
        refusal: outcome.error,
        detail: summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: {
          outcome: "blocked",
          summary,
          chain: wrapError("development", "agentAttempt", outcome.error, { ...context, errorClass: outcome.error.name }),
          agentOutput: outcomeRecord(outcome),
        },
      };
    }

    // Identified by the abort reason itself, not its text: the cancellation carries the very
    // reason this process's shutdown signal was aborted with. Any other cancellation stays a failure.
    const shutdown = this.deps.shutdownSignal;
    if (outcome.kind === "cancelled" && shutdown.aborted && outcome.reason === shutdown.reason) {
      const summary = `attempt interrupted by shutdown after ${outcome.turnsUsed} turn(s); ${describeAgentWork(agentWork)}`;
      console.warn(`[${task.id}] ${summary}`);
      this.deps.eventSink?.emit({ event: "task_interrupted", taskId: task.id, attempt: task.attempt, turns: outcome.turnsUsed });
      return {
        status: "interrupted",
        detail: summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: {
          outcome: "blocked",
          summary,
          chain: wrapError("development", "agentAttempt", outcome.reason, context),
          agentOutput: outcomeRecord(outcome),
        },
      };
    }

    // Workplace offers dispute_check only to implementation work with stored checks, and only for
    // the names of its own checks or of a merged task's (ADR-074 addendum 2 d74 D); a dispute that
    // names no stored check falls through to failed below.
    const disputed = outcome.kind === "disputed" && d.work.kind === "stored-checks" ? disputedCheckOf(task.id, d.work, outcome.checkName, outcome.ofTask) : null;
    if (outcome.kind === "disputed" && disputed !== null) {
      const { revision: stored, check, checksOf } = disputed;
      const whose = checksOf === task.id ? "" : ` of merged task ${checksOf}`;
      const summary =
        `check ${JSON.stringify(check.name)}${whose} (revision ${stored.revision}, check task ${stored.checkTaskId}) disputed ` +
        `after ${outcome.turnsUsed} turn(s): ${outcome.reason}; ${describeAgentWork(agentWork)}`;
      console.warn(`[${task.id}] ${summary}`);
      this.deps.eventSink?.emit({
        event: "check_disputed",
        taskId: task.id,
        attempt: task.attempt,
        checksOf,
        checkTaskId: stored.checkTaskId,
        revision: stored.revision,
        check: check.name,
        reason: outcome.reason,
      });
      return {
        status: "disputed",
        checksOf,
        checkTaskId: stored.checkTaskId,
        revision: stored.revision,
        check: { name: check.name, command: check.command },
        reason: outcome.reason,
        evidence: outcome.evidence,
        detail: summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: {
          outcome: "blocked",
          summary,
          chain: wrapError("development", "agentAttempt", outcome.reason, { ...context, checksOf, checkTaskId: stored.checkTaskId, check: check.name }),
          agentOutput: outcomeRecord(outcome),
        },
      };
    }

    let notDelivered = "";
    if (outcome.kind === "finished" && d.work.kind === "check-authoring") {
      const evaluated = await this.verification.checkedTaskOnMain(d, d.work, outcome);
      if ("status" in evaluated) return evaluated;
      notDelivered = `; Z0 does not find it delivered: ${evaluated.why}`;
    }

    if (outcome.kind === "finished") {
      const chain = wrapError("development", "agentAttempt", `${outcome.blockedReason ?? outcome.summary}${notDelivered}`, context);
      const envelope: ErrorEnvelope = {
        outcome: "blocked",
        summary: `agent reported blocked after ${outcome.turnsUsed} turns: ${attemptSummary(outcome)}${notDelivered}`,
        chain,
        agentOutput: outcomeRecord(outcome),
      };
      return {
        status: "blocked",
        verdict: WORK_FAILED,
        detail: envelope.summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: envelope,
      };
    }

    const cause = outcome.kind === "cancelled" ? outcome.reason : outcome.detail;
    const chain = wrapError("development", "agentAttempt", cause, context);
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: `attempt ended as ${outcome.kind} after ${outcome.turnsUsed} turn(s) on ${staff.model.provider}/${staff.model.modelId}: ${outcome.detail}`,
      chain,
      agentOutput: outcomeRecord(outcome),
    };
    return {
      status: "failed",
      verdict: WORK_FAILED,
      detail: envelope.summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: envelope,
    };
  }
}

/**
 * The task as its brief states it, read from the stored spec only. Every producer of a dispatched
 * task writes the goal, end state, scope and deliverables; a row without one is refused rather than
 * given an end state or scope the plan never recorded.
 */
function briefSpecOf(task: TaskDescriptor): { readonly kind: "spec"; readonly spec: TaskSpec } | Unplannable {
  const stored = task.taskSpec;
  const [goal, endState, scope, deliverables] = [stored?.goal, stored?.endState, stored?.scope, stored?.deliverables];
  if (goal === undefined || endState === undefined || scope === undefined || deliverables === undefined) {
    const missing = Object.entries({ goal, endState, scope, deliverables })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    return {
      kind: "unplannable",
      operation: "readTaskSpec",
      reason:
        stored === undefined
          ? `task ${task.id} has no stored task_spec, so its brief would state a goal, end state, scope and deliverables no plan recorded`
          : `task ${task.id}'s stored task_spec has no ${missing.join(", ")}, so its brief would state what no plan recorded`,
    };
  }
  return { kind: "spec", spec: { goal, endState, scope, deliverables } };
}
