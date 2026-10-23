import { access } from "node:fs/promises";
import type { AttemptCellImage } from "@ashara/execution-infra";
import { WorktreeCommitIncomplete, cleanupWorkdir, commitAllChanges, createCellBackend, getChangedFiles } from "@ashara/execution-infra";
import {
  NO_CHANGE_REASON,
  VerificationInfrastructureFault,
  CONFLICT_MARKERS_LEFT,
  WORK_FAILED,
  asharaBlocked,
  branchChangedPaths,
  deleteSettledTaskBranch,
  environmentCheckPort,
  environmentErrorOf,
  finalizeSuccess,
  stagedConflictMarkers,
  substrateBlocked,
  taskBranchName,
  thrownBlocked,
} from "@ashara/quality";
import type { DispatchEnvironment, ExecutionResult, FinalizeDeps, MainConflict } from "@ashara/quality";
import { describeErrorChain, wrapError } from "@ashara/shared";
import type { ErrorEnvelope } from "@ashara/workplace";
import { attemptSummary, outcomeRecord, runAttempt, toSessionAttempt } from "@ashara/workplace";
import type { AttemptSlot, Outcome } from "@ashara/workplace";
import { attemptProfileOf } from "../acl/workplace-acl.js";
import type { Dispatch, DispatchContext, DispatchWork } from "./dispatch-types.js";
import { endWithoutDone } from "./end-without-done.js";

/** A dispatch whose cell is up, in its session's attempt slot. */
interface CellRun {
  readonly context: DispatchContext;
  readonly dispatch: Dispatch;
  readonly slot: AttemptSlot;
}

/** An attempt that finished done. */
type FinishedOutcome = Extract<Outcome, { readonly kind: "finished" }>;

/** Work a merge settles: every kind but a check author's, which keepChecks settles without one. */
type MergedWork = Exclude<DispatchWork, { readonly kind: "check-authoring" }>;

/** An attempt that finished done on work a merge settles, with the files it changed in its worktree. */
interface DoneRun {
  readonly context: DispatchContext;
  readonly dispatch: Dispatch;
  readonly work: MergedWork;
  readonly outcome: FinishedOutcome;
  readonly filesChanged: readonly string[];
}

/** The outcome of an attempt that finished done, and of a step that may end the dispatch on it. */
interface DoneStep {
  readonly context: DispatchContext;
  readonly dispatch: Dispatch;
  readonly outcome: FinishedOutcome;
}

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

export function attemptCellImage(environment: DispatchEnvironment): AttemptCellImage {
  if (environment.kind === "base-cell") return { kind: "base-cell", image: environment.image, digest: environment.digest };
  const { version, commit, imageId, imageRef } = environment;
  return { kind: "environment", version, commit, imageId, imageRef };
}

/** Runs the attempt in the dispatch's cell and settles it: done, through the gates and the merge; otherwise by how it ended. */
export async function runExecution({ context, dispatch: d, slot }: CellRun): Promise<ExecutionResult> {
  const { deps, verification } = context;
  const { eventSink, attemptPolicy } = deps;
  const { task, brief, staff, workDir } = d;

  // Before every implementation dispatch, before the model is called at all:
  // checks red-run on another environment version are trusted only once they hold the
  // red-run rule on their baseline in this dispatch's image; then work already on main is closed as
  // delivered, whoever delivered it. In that order: a set that cannot tell the task's work from its
  // absence would pass on main whatever main holds, and close the task on nothing. The one such set
  // the rule trusts is a held one, whose items held before the correction that put them in scope:
  // this sweep is what closes its task as held.
  if (d.work.kind === "stored-checks") {
    const stale = await verification.revalidation.revalidateOnBaseline(d, d.work.stored);
    if (stale !== null) return stale;
    const delivered = await verification.delivered.sweepDelivered(d, d.work.stored);
    if (delivered !== null) return delivered;
  }
  // A check author is dispatched only on a foundation the environment builds: on one it
  // does not, every check fails for that reason alone and the red run could decide nothing.
  if (d.work.kind === "check-authoring") {
    const unbuilt = await verification.foundationGate.foundationBuildGate(d, d.work);
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
      llm: deps.llm,
      cell: createCellBackend(d.cell, { toolTimeoutSeconds: attemptPolicy.toolTimeoutSeconds }),
      clock: deps.clock,
      records: d.records,
      signal: deps.shutdownSignal,
      environment: task.workKind === "environment" ? environmentCheckPort(verification.checkPorts.environmentScope(d)) : null,
      checks: d.work.kind === "check-authoring" ? verification.checkPorts.checkDefinitionPort(d, d.work) : null,
      taskChecks: d.work.kind === "stored-checks" ? verification.checkPorts.taskCheckRunPort(d, d.work.stored, d.work.merged) : null,
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
    return endWithoutDone({ context, dispatch: d, outcome });
  }

  // A check may need no file of its own, so a check task is judged by its checks, not its diff.
  if (d.work.kind === "check-authoring") return verification.harvest.keepChecks(d, d.work, outcome);

  return settleDone({ context, dispatch: d, work: d.work, outcome, filesChanged });
}

/**
 * An implementation attempt that finished done: its conflict resolved, its work on the task
 * branch, the ownership gate passed, then merged and verified on main.
 */
async function settleDone({ context, dispatch: d, work, outcome, filesChanged }: DoneRun): Promise<ExecutionResult> {
  const { deps, verification } = context;
  const { eventSink } = deps;
  const { task, workDir, targetProjectPath, sessionId } = d;

  if (d.conflict !== null) {
    const unresolved = await conflictResolution({ context, dispatch: d, outcome }, d.conflict);
    if (unresolved !== null) return unresolved;
  }

  // "No changes" is judged on the task branch against main, not on this
  // attempt's own edits: a re-dispatch may find its work already committed there by an earlier
  // dispatch (endWithoutDone's partial-work commit) and rightly finish done without editing.
  let workChanged: readonly string[] = filesChanged;
  if (filesChanged.length === 0) {
    const onBranch = await branchWork({ context, dispatch: d, outcome });
    if (onBranch.kind === "ended") return onBranch.result;
    workChanged = onBranch.paths;
    // Work already on main is decided by its checks on main, never by the word of an implementer that changed nothing.
    if (workChanged.length === 0 && work.kind === "stored-checks") return verification.delivered.deliveredOnMain(d, work.stored, { outcome, agentWork: "kept" }, outcome.turnsUsed);
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
    const uncommitted = await commitWork({ context, dispatch: d, outcome });
    if (uncommitted !== null) return uncommitted;
  }

  if (work.kind === "stored-checks" || work.kind === "scaffold") {
    const refused = await verification.ownershipGate.ownershipGate(d, outcome);
    if (refused !== null) return refused;
  }

  return mergeAndVerify({ context, dispatch: d, outcome }, work);
}

/** Merges the task branch on main and verifies the merged tree by the gate its work kind has. */
async function mergeAndVerify({ context, dispatch: d, outcome }: DoneStep, work: MergedWork): Promise<ExecutionResult> {
  const { deps, verification } = context;
  const { eventSink } = deps;
  const { task, workDir, targetProjectPath, sessionId } = d;

  let finalizeDeps: Omit<FinalizeDeps, "presentedConflict" | "workdirBase" | "logger">;
  if (work.kind === "substrate") {
    const gate = await verification.substrateGate.substrateGate(d, outcome.statement, outcome);
    if (gate.kind === "ended") return gate.result;
    finalizeDeps = {
      postMergeOperation: "postMergeVerify",
      postMergeVerify: (path, lease) => verification.postMerge.postMergeEnvironmentTest(d, path, gate.tested, lease),
    };
  } else if (work.kind === "scaffold") {
    // No gate ran the scaffold's build and test before its merge: their verdict there is its
    // own attempt's, never a regression of the tree.
    finalizeDeps = {
      postMergeOperation: "postMergeScaffold",
      postMergeVerify: (path, lease) => verification.postMerge.postMergeScaffold(d, path, lease),
    };
  } else {
    const { stored } = work;
    finalizeDeps = {
      postMergeOperation: "postMergeTaskChecks",
      postMergeVerify: (path, lease) => verification.postMerge.postMergeStoredChecks(d, path, stored, lease),
    };
  }

  const finalizeResult = await finalizeSuccess(
    { ...finalizeDeps, presentedConflict: d.conflict, workdirBase: deps.config.workdirBase, logger: deps.logger },
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
        deps.logger,
        finalizeResult.errorLayer,
      );
    }
    if (fault.class === "ashara") {
      // No verdict was reached, so nothing is known of the task's work: blocked for the operator,
      // the merge aborted and the branch kept, never a failure the task is replanned against.
      await cleanupWorkdir(workDir, targetProjectPath);
      return asharaBlocked(task, sessionId, "postMergeCheckRun", fault.error, { outcome, agentWork: "kept" }, eventSink, deps.logger, finalizeResult.errorLayer);
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
  await deleteSettledTaskBranch(targetProjectPath, task.id, "merged into main", deps.logger);
  // Stated from the disk, not assumed: cleanupWorkdir's own fallbacks are best-effort.
  const left = await worktreeLeft(workDir);
  if (left !== null) {
    deps.logger.warn("delivery.worktree-left", `task completed — but worktree ${workDir} ${left}`, { taskId: task.id, attempt: task.attempt, workDir });
  } else {
    deps.logger.info("delivery.task-merged", `task completed — worktree ${workDir} removed after the merge`, { taskId: task.id, attempt: task.attempt, workDir });
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
 * An attempt handed a conflict with main finished done: every conflicting file must be free of
 * conflict markers before anything is committed. Markers left fail the attempt under
 * conflictMarkersLeft with nothing committed (the merge is discarded with the worktree). Z0's git
 * failing blocks for the operator. Null when the conflict is resolved.
 */
async function conflictResolution({ context, dispatch: d, outcome }: DoneStep, conflict: MainConflict): Promise<ExecutionResult | null> {
  const { eventSink, logger } = context.deps;
  const { task, workDir, targetProjectPath, sessionId } = d;
  let left: string[];
  try {
    left = await stagedConflictMarkers(d.repo, conflict.files);
  } catch (e) {
    await cleanupWorkdir(workDir, targetProjectPath);
    const fault = new VerificationInfrastructureFault(task.id, "conflict marker read of the task worktree", { cause: e });
    const chain = wrapError("development", "conflictResolution", fault, { taskId: task.id, errorClass: fault.name });
    return asharaBlocked(task, sessionId, "conflictResolution", fault, { outcome, agentWork: "merge-discarded" }, eventSink, logger, chain);
  }
  eventSink?.emit({ event: "merge_conflict_resolution", taskId: task.id, attempt: task.attempt, files: conflict.files, markersLeft: left });
  if (left.length === 0) return null;
  await cleanupWorkdir(workDir, targetProjectPath);
  const summary = `the conflict of ${task.id} with main is not resolved: conflict markers are left in ${left.join(", ")}; nothing was committed or merged`;
  const chain = wrapError("development", "conflictMarkersLeft", summary, { taskId: task.id, mainCommit: conflict.mainCommit, conflictFiles: conflict.files, markersLeft: left });
  eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: summary });
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
async function commitWork({ context, dispatch: d, outcome }: DoneStep): Promise<ExecutionResult | null> {
  const { eventSink, logger } = context.deps;
  const { task, workDir, targetProjectPath, sessionId } = d;
  try {
    await commitAllChanges(d.repo, `ashara: agent output for task ${task.id}`);
    return null;
  } catch (e) {
    await cleanupWorkdir(workDir, targetProjectPath);
    if (!(e instanceof WorktreeCommitIncomplete)) {
      // Z0's git refused to record the work (WorktreeCommitFailed), or anything else failed: never the agent's.
      return thrownBlocked(task, sessionId, "commitWork", e, { step: "commit the agent's work on the task branch", cell: "host git" }, { outcome, agentWork: "kept" }, eventSink, logger);
    }
    const chain = wrapError("development", "commitWork", e, { taskId: task.id });
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: `the agent's work on ${task.id} was committed only in part, nothing merged: ${chain.message}`,
      chain,
      agentOutput: outcomeRecord(outcome),
    };
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: envelope.summary });
    return { status: "failed", verdict: WORK_FAILED, detail: envelope.summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: envelope };
  }
}

/**
 * The paths the task branch changed since it left main, read through the target's hardened host
 * git, for an attempt that finished done with nothing uncommitted. Z0's git failing blocks for
 * the operator: an unreadable branch is never read as "no changes", nor as work to merge.
 */
async function branchWork({
  context,
  dispatch: d,
  outcome,
}: DoneStep): Promise<{ readonly kind: "paths"; readonly paths: readonly string[] } | { readonly kind: "ended"; readonly result: ExecutionResult }> {
  const { eventSink, logger } = context.deps;
  const { task, workDir, targetProjectPath, sessionId } = d;
  try {
    return { kind: "paths", paths: await branchChangedPaths(targetProjectPath, task.id, taskBranchName(task.id)) };
  } catch (e) {
    await cleanupWorkdir(workDir, targetProjectPath);
    const environmentFailure = environmentErrorOf(e);
    if (environmentFailure !== null) {
      return {
        kind: "ended",
        result: substrateBlocked(task, sessionId, "branchWork", environmentFailure, "host git", { outcome, agentWork: "kept" }, eventSink, logger),
      };
    }
    const fault = new VerificationInfrastructureFault(task.id, "task branch diff against main", { cause: e });
    const chain = wrapError("development", "branchWork", fault, { taskId: task.id, errorClass: fault.name });
    return { kind: "ended", result: asharaBlocked(task, sessionId, "branchWork", fault, { outcome, agentWork: "kept" }, eventSink, logger, chain) };
  }
}
