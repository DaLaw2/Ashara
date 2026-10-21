import type { Cell, WorkdirInfo } from "@ashara/execution-infra";
import {
  cleanupWorkdir,
  clearWorktreeSlot,
  createWorkdir,
  createWorkdirForRetry,
  ensureTargetGitInit,
  recipePaths,
  resolveCurrentEnvironment,
  targetRepo,
  withTargetCheckout,
} from "@ashara/execution-infra";
import { buildKnowledgeQueryText, storeFailureKnowledge } from "@ashara/knowledge";
import type { KnowledgeScope } from "@ashara/knowledge";
import {
  CheckRecorder,
  ConflictRetryUnprepared,
  NO_AGENT,
  branchExists,
  cellImageOf,
  checkAreaOf,
  checkBranchName,
  conflictWithMain,
  discardCheckWorkdir,
  dropCheckBranch,
  failedBeforeAgent,
  formatChecksForBrief,
  formatConflictForBrief,
  formatFoundationForCheckAuthor,
  formatProjectChecksForCheckAuthor,
  headCommit,
  mainMergedForRetry,
  readEnvironmentDefinition,
  sessionEnvironmentVersion,
  taskBranchName,
  thrownBlocked,
} from "@ashara/quality";
import type { DispatchEnvironment, DispatchRef, DispatchWork, ExecutionResult, MainConflict, WorkPlan } from "@ashara/quality";
import { describeErrorChain, parseWorkItemId, wrapError } from "@ashara/shared";
import type { AgentBrief } from "@ashara/workplace";
import {
  ProjectIntentUnavailable,
  buildContextMap,
  createAgentBrief,
  createSessionId,
  formatAcceptanceCriteria,
  formatTaskSpec,
  loadProjectIntent,
  priorAttemptFailure,
  renderKnowledgeContext,
  withSessionLifecycle,
} from "@ashara/workplace";
import type { KnowledgeSection, TaskSpec } from "@ashara/workplace";
import { DispatchRecords } from "./dispatch-records.js";
import type { AgentStaff, Dispatch, DispatchContext, NoWiderModel, OwnerUnresolved, TaskDescriptor, Unplannable } from "./dispatch-types.js";
import { attemptCellImage, runExecution } from "./run-execution.js";

/** One task's dispatch onto the project's validated target checkout. */
interface TaskDispatch {
  readonly context: DispatchContext;
  readonly task: TaskDescriptor;
  readonly targetProjectPath: string;
}

/** A dispatch once it has its session: every stage before the agent runs reports under it. */
interface SessionDispatch extends TaskDispatch {
  readonly sessionId: string;
}

/** A task blocked before any worktree or cell exists, as its session names it. */
interface BlockedBeforeWork {
  readonly context: DispatchContext;
  readonly task: DispatchRef;
  readonly sessionId: string;
}

function briefEnvironment(environment: DispatchEnvironment): AgentBrief["projectEnvironment"] {
  if (environment.kind === "base-cell") return { kind: "to-define" };
  return { kind: "defined", version: environment.version, statement: environment.statement };
}

/**
 * No environment the task's cells could be built from: Blocked with `environment_undefined`
 * before anything ran, never a BaseCell fallback.
 */
function environmentUndefined({ context, task, sessionId }: BlockedBeforeWork, reason: string): ExecutionResult {
  const { eventSink, logger } = context.deps;
  const taskId = task.id;
  const chain = wrapError("development", "resolveCurrentEnvironment", reason, { taskId });
  const summary = `no environment for task ${taskId}: ${reason}; no agent ran and nothing executed`;
  logger.info("delivery.environment-undefined", summary, { taskId, attempt: task.attempt });
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
 * exists. No default role is substituted.
 */
function ownerUnresolved({ context, task, sessionId }: BlockedBeforeWork, unresolved: OwnerUnresolved): ExecutionResult {
  const { eventSink, logger } = context.deps;
  const taskId = task.id;
  const chain = wrapError("development", "assignAgent", unresolved.reason, { taskId, ownerRoleId: unresolved.ownerRoleId });
  const summary = `no roster role can work task ${taskId}: ${unresolved.reason}; no agent ran and nothing executed`;
  logger.info("delivery.owner-unresolved", summary, { taskId, attempt: task.attempt, ownerRoleId: unresolved.ownerRoleId });
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

/**
 * No catalog model has a window larger than one an attempt of the task overflowed: `no_wider_model`
 * before any worktree or cell exists, and the orchestrator gives the task up for a plan repair.
 */
function noWiderModel({ context, task, sessionId }: BlockedBeforeWork, unfit: NoWiderModel): ExecutionResult {
  const { eventSink, logger } = context.deps;
  const taskId = task.id;
  const reason =
    `an attempt of task ${taskId} overflowed a context window of ${unfit.overflowedWindowTokens} tokens, and no catalog model ` +
    `graded for it has a larger one`;
  const chain = wrapError("development", "assignAgent", reason, { taskId, overflowedWindowTokens: unfit.overflowedWindowTokens });
  const summary = `${reason}; no agent ran and nothing executed`;
  logger.warn("delivery.no-wider-model", summary, { taskId, attempt: task.attempt, overflowedWindowTokens: unfit.overflowedWindowTokens });
  eventSink?.emit({ event: "task_blocked", taskId, attempt: task.attempt, stage: "assignAgent", reason: summary });
  return {
    status: "no_wider_model",
    overflowedWindowTokens: unfit.overflowedWindowTokens,
    detail: summary,
    outcome: null,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: { outcome: "blocked", summary, chain },
  };
}

/**
 * The task's conflict with main could not be prepared for this attempt (ConflictRetryUnprepared),
 * or git could not even be asked: Z0's git, never the agent's work, so blocked under class ashara
 * (prepareConflictRetry). Nothing was dispatched, so the branch is never dispatched as it is; it
 * is kept as it was for the next dispatch to try again.
 */
function conflictUnprepared({ context, task, sessionId }: SessionDispatch, e: unknown): ExecutionResult {
  const where = { step: "prepare the task's conflict with main for its next attempt", cell: "host git" };
  return thrownBlocked(task, sessionId, "prepareConflictRetry", e, where, NO_AGENT, context.deps.eventSink, context.deps.logger);
}

/**
 * Dispatches the task. `targetProjectPath` is the project's validated target checkout: a project
 * without one is blocked by the caller before dispatch, since only that checkout gives the worktree
 * a git dir Z0 owns (execution-infra's host-git.ts) and the merge a place to land.
 */
export async function executeTask({ context, task, targetProjectPath }: TaskDispatch): Promise<ExecutionResult> {
  const { deps, verification } = context;
  const { eventSink, cells } = deps;
  const sessionId = createSessionId();
  const session: SessionDispatch = { context, task, targetProjectPath, sessionId };

  eventSink?.emit({
    event: "task_started",
    taskId: task.id,
    attempt: task.attempt,
    title: task.title,
    // The stored goal or none: a task without one is never given its title as a goal.
    goal: task.taskSpec?.goal,
    // The stored grade as it is, never a default: staffing refuses a task
    // without one, and the model it is staffed with is emitted when its attempt starts.
    capability: task.taskSpec?.capability,
  });

  // A review of the plan's suites reads stored checks and the vision in one structured call: no
  // substrate, environment, worktree or cell is involved, so none is probed.
  if (task.taskSpec?.origin === "review") {
    const reviewed = await verification.reviewSuites(task, sessionId, targetProjectPath);
    if (reviewed.status === "failed") await storeFailureKnowledge(deps.knowledgeSink, task, reviewed);
    return reviewed;
  }

  // First, before the brief (which may call an LLM) or the
  // worktree: a substrate that cannot host the task blocks it here, so no
  // later path can fall through to host execution.
  try {
    await cells.substrate.probeSubstrate();
  } catch (e) {
    return thrownBlocked(task, sessionId, "probeSubstrate", e, { step: "probe the container substrate", cell: "container substrate" }, NO_AGENT, eventSink, deps.logger);
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
    await storeFailureKnowledge(deps.knowledgeSink, task, result);
    return result;
  }

  const environment = await dispatchEnvironment(session);
  if ("status" in environment) return environment;

  // Before the brief and any model call: what decides the work. An implementation task with no
  // stored checks, or a check task that decides no single task, is not dispatched; neither is a
  // task whose stored spec lacks a field the brief states, since the brief would have to invent it.
  const unplannable = async (refused: Unplannable): Promise<ExecutionResult> => {
    const result = failedBeforeAgent(task, sessionId, refused.operation, refused.reason, `no work plan for ${task.id}`);
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
    await storeFailureKnowledge(deps.knowledgeSink, task, result);
    return result;
  };
  const read = briefSpecOf(task);
  if (read.kind === "unplannable") return unplannable(read);
  const { spec } = read;
  let plan: WorkPlan;
  try {
    const planned = await planWork(context, task, environment);
    if (planned.kind === "unplannable") return await unplannable(planned);
    plan = planned;
  } catch (e) {
    return thrownBlocked(task, sessionId, "planWork", e, { step: "read the checks that decide the work", cell: "CI cell" }, NO_AGENT, eventSink, deps.logger);
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
      await withTargetCheckout(targetProjectPath, `the git init before task ${task.id}'s branch is looked up`, () => ensureTargetGitInit(targetProjectPath, deps.config.workdirBase));
      resumesBranch = await branchExists(targetProjectPath, taskBranchName(task.id));
    }
  } catch (e) {
    return thrownBlocked(task, sessionId, "resumeBranch", e, { step: "read whether the task branch exists", cell: "host git" }, NO_AGENT, eventSink, deps.logger);
  }
  let conflict: MainConflict | null = null;
  if (resumesBranch) {
    try {
      conflict = await conflictWithMain(targetProjectPath, task.id);
    } catch (e) {
      return conflictUnprepared(session, e);
    }
    if (conflict !== null) {
      eventSink?.emit({ event: "merge_conflict_presented", taskId: task.id, attempt: task.attempt, mainCommit: conflict.mainCommit, files: conflict.files });
    }
  }

  let brief: AgentBrief;
  try {
    brief = await buildBrief({ context, task, spec, targetProjectPath, environment, plan, conflict });
  } catch (e) {
    // A missing or unreadable intent (ProjectIntentUnavailable) is Ashara's own record, as is any
    // other throw building the brief: never the agent's work, so blocked under class ashara.
    const step = e instanceof ProjectIntentUnavailable ? "load the project's intent" : "build the brief";
    return thrownBlocked(task, sessionId, "buildBrief", e, { step, cell: "brief" }, NO_AGENT, eventSink, deps.logger);
  }

  // The Assignment's agent half, once per attempt: a model that cannot be
  // resolved (routing, budget) fails the dispatch before any worktree exists.
  let staff: AgentStaff;
  let records: DispatchRecords;
  try {
    const staffing = await deps.staffing.staff(task);
    if (staffing.kind === "owner-unresolved") return ownerUnresolved(session, staffing);
    if (staffing.kind === "no-wider-model") return noWiderModel(session, staffing);
    staff = staffing.staff;
    records = new DispatchRecords(deps.config.workdirBase, task.id, sessionId);
    await records.writeBrief(brief);
  } catch (e) {
    return thrownBlocked(task, sessionId, "assignAgent", e, { step: "staff the attempt and write its brief", cell: "attempt records" }, NO_AGENT, eventSink, deps.logger);
  }

  return dispatchInCell({ ...session, environment, plan, resumesBranch, conflict, brief, staff, records });
}

/**
 * Before the brief, the worktree and any cell: every cell of the task is started from what
 * this resolves, and a project with nothing to build them from blocks here.
 */
async function dispatchEnvironment(session: SessionDispatch): Promise<DispatchEnvironment | ExecutionResult> {
  const { context, task, targetProjectPath, sessionId } = session;
  const { deps } = context;
  if (task.taskSpec?.origin === "sprint0") {
    return { kind: "base-cell", image: deps.cells.baseCell.image, digest: deps.cells.baseCell.digest };
  }
  let environment: Extract<DispatchEnvironment, { kind: "environment" }>;
  try {
    const resolution = await resolveCurrentEnvironment(
      task.projectId,
      targetRepo(targetProjectPath),
      deps.environment.images,
      deps.environment.statements,
      readEnvironmentDefinition,
    );
    // No lesson: nothing of the agent's ran (fault-class.ts), the plan's repair answers it.
    if (resolution.kind === "undefined") return environmentUndefined(session, resolution.reason);
    environment = { kind: "environment", ...resolution.environment };
  } catch (e) {
    const where = { step: "resolve the current environment", cell: "environment image build" };
    return thrownBlocked(task, sessionId, "resolveEnvironment", e, where, NO_AGENT, deps.eventSink, deps.logger);
  }
  deps.eventSink?.emit({
    event: "environment_resolved",
    taskId: task.id,
    attempt: task.attempt,
    version: environment.version,
    commit: environment.commit,
    imageId: environment.imageId,
    imageRef: environment.imageRef,
    reused: environment.reused,
  });
  return environment;
}

/** A planned, briefed and staffed dispatch, before its worktree and cell exist. */
interface StaffedDispatch extends SessionDispatch {
  readonly environment: DispatchEnvironment;
  readonly plan: WorkPlan;
  readonly resumesBranch: boolean;
  readonly conflict: MainConflict | null;
  readonly brief: AgentBrief;
  readonly staff: AgentStaff;
  readonly records: DispatchRecords;
}

/** Creates the task's worktree and cell, runs the attempt in them, and tears the cell down. */
async function dispatchInCell(staffed: StaffedDispatch): Promise<ExecutionResult> {
  const { context, task, targetProjectPath, sessionId, environment, plan, resumesBranch, conflict, brief, staff, records } = staffed;
  const { deps, verification } = context;
  const { eventSink, cells } = deps;
  const base = deps.config.workdirBase;

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
        await discardCheckWorkdir(workdir.workDir, targetProjectPath, branch, deps.logger);
        throw e;
      }
    } else {
      workdir = resumesBranch
        ? await createWorkdirForRetry(base, targetProjectPath, taskBranchName(task.id), mainMergedForRetry(task.id, conflict, deps.logger))
        : await createWorkdir(base, targetProjectPath, taskBranchName(task.id));
      work = plan;
    }
  } catch (e) {
    if (e instanceof ConflictRetryUnprepared) return conflictUnprepared(staffed, e);
    return thrownBlocked(task, sessionId, "createWorkdir", e, { step: "create the task worktree", cell: "host git" }, NO_AGENT, eventSink, deps.logger);
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
    return thrownBlocked(task, sessionId, "createCell", e, { step: "create the task cell", cell: "task cell" }, NO_AGENT, eventSink, deps.logger);
  }
  eventSink?.emit({ event: "cell_created", taskId: task.id, attempt: task.attempt, cellId: cell.id, roleId: staff.role.id, role: staff.role.name, image: cellImageOf(environment), cellImage: attemptCellImage(environment) });

  const dispatch: Dispatch = { task, brief, staff, cell, records, targetProjectPath, workDir, repo, sessionId, environment, work, conflict };

  try {
    const result = await withSessionLifecycle(
      deps.sessionStore,
      { sessionId, taskId: task.id, brief, environmentVersion: sessionEnvironmentVersion(environment) },
      (slot) => runExecution({ context, dispatch, slot }),
    );
    // ONE seam covering every return path inside runExecution: only the agent's own work
    // failing is a lesson about the task (fault-class.ts). A substrate or Z0 fault, a refused call,
    // stale stored checks, a disputed check, a requested environment change and a shutdown are not.
    if (result.status === "failed" || result.status === "blocked") {
      await storeFailureKnowledge(deps.knowledgeSink, task, result);
    }
    return result;
  } catch (e) {
    // A throw no stage caught: never the agent's work, so blocked under its class, no lesson.
    eventSink?.emit({ event: "error", location: "DispatchService:execute", taskId: task.id, attempt: task.attempt, error: describeErrorChain(e) });
    await cleanupWorkdir(workDir, targetProjectPath);
    return thrownBlocked(task, sessionId, "runExecution", e, { step: "run the dispatch", cell: "task cell" }, { outcome: null, agentWork: "unknown" }, eventSink, deps.logger);
  } finally {
    await verification.teardownCell({ taskId: task.id, attempt: task.attempt }, cell);
  }
}

/**
 * What decides the task's work. Sprint 0 is checked by the substrate; a check task's checks are
 * red-run by Z0 and it must decide exactly one implementation task; every other task is decided
 * by the latest checks stored for it, and with none stored it is unplannable (never verified
 * from nothing).
 */
async function planWork(context: DispatchContext, task: TaskDescriptor, environment: DispatchEnvironment): Promise<WorkPlan | Unplannable> {
  const { checks } = context.deps;
  // The product scaffold is decided by the product's build and test from the definition on its
  // merge: no check can be written for a layout that does not exist yet.
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
    const checked = await checks.checkedTasksOf(task.id);
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
    // on the same fixed commit, never on main as later merges left it.
    const foundation = await checks.foundationOf(task.id);
    if (foundation.kind === "none") {
      return { kind: "unplannable", operation: "resolveCheckFoundation", reason: `no foundation to red-run the checks on: ${foundation.reason}` };
    }
    // Its checks are kept only when they decide every item it cites, so a check task that
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
    const prior = await checks.latest(parseWorkItemId(only, "TaskCheckStore.checkedTasksOf"));
    return {
      kind: "check-authoring",
      checkedTaskId: only,
      environment,
      prior,
      foundation: { taskId: foundation.taskId, commit: foundation.commit },
      citedItems: [firstCited, ...restCited],
    };
  }
  const stored = await checks.latest(task.id);
  if (stored === null || stored.checks.length === 0) {
    return {
      kind: "unplannable",
      operation: "loadTaskChecks",
      reason: `no checks are stored for task ${task.id}: its check task has not recorded any, so nothing could decide its work`,
    };
  }
  const merged = (await checks.completedOf(task.projectId, task.id)).checked;
  return { kind: "stored-checks", stored, merged };
}

/** What a task's brief is built from. */
interface BriefInputs {
  readonly context: DispatchContext;
  readonly task: TaskDescriptor;
  readonly spec: TaskSpec;
  readonly targetProjectPath: string;
  readonly environment: DispatchEnvironment;
  readonly plan: WorkPlan;
  readonly conflict: MainConflict | null;
}

async function buildBrief({ context, task, spec, targetProjectPath, environment, plan, conflict }: BriefInputs): Promise<AgentBrief> {
  const { deps } = context;
  const priorFailure = priorAttemptFailure(task.id, task.blockedReason?.source === "replan" ? task.blockedReason.replanContext : undefined);

  // A ProjectIntentUnavailable propagates to execute() and blocks the task.
  const projectIntent = await loadProjectIntent(deps.intentSource, task.id);

  const contextMap = await buildContextMap(targetProjectPath);
  const knowledgeContext = await buildKnowledgeContext(context, task, spec);

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
    const stored = await deps.checks.storedOfProject(task.projectId, plan.checkedTaskId);
    taskContext = `${specContext}\n\n${formatProjectChecksForCheckAuthor(stored)}\n\n${formatFoundationForCheckAuthor(plan.foundation, checkAreaOf(plan.checkedTaskId))}`;
  }
  // Named before work starts: what the ownership gate refuses,
  // and the inputs whose change rebuilds the environment.
  const protectedPaths: AgentBrief["protectedPaths"] =
    environment.kind === "environment"
      ? {
          recipe: [...recipePaths(environment.definition)],
          checkFiles: [...new Set((await deps.checks.checkFilesOf(task.projectId)).map((file) => file.path))].sort(),
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

async function buildKnowledgeContext(context: DispatchContext, task: TaskDescriptor, spec: TaskSpec): Promise<string> {
  const { deps } = context;
  const source = deps.knowledgeSource;
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
    // eslint-disable-next-line ashara/catch-continue -- best effort: the findings section is left out of the brief, never rendered as none, and the attempt is judged by its checks, not by what context it was given
    deps.logger.warn("delivery.findings-unread", "the recent findings could not be read; the brief leaves them out", {}, e);
  }

  try {
    const approaches = await source.failedApproaches(scope, 10);
    sections.push({
      heading: "## Failed Approaches — do not repeat",
      entries: approaches.map((a) => `- "${a.title}" — Failed: ${a.failureReason}\n  Learned: ${a.learned}`),
    });
  } catch (e: unknown) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the failed-approaches section is left out of the brief, never rendered as none, and the attempt is judged by its checks, not by what context it was given
    deps.logger.warn("delivery.failed-approaches-unread", "the failed approaches could not be read; the brief leaves them out", {}, e);
  }

  return renderKnowledgeContext(sections);
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
