import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttemptCellImage,
  BaseCellReference,
  BuiltEnvironment,
  Cell,
  CellSpec,
  CheckoutLease,
  CurrentEnvironment,
  EnvironmentCheckScope,
  EnvironmentDefinition,
  EnvironmentImages,
  EnvironmentTestRun,
  PartialCommitOutcome,
  SubstrateInfo,
  WorkdirInfo,
} from "@ashara/execution-infra";
import {
  CellTeardownFailed,
  ENVIRONMENT_BUILD_TIMEOUT_MS,
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  WorktreeCommitFailed,
  WorktreeCommitIncomplete,
  cellRunBoundMs,
  cleanupWorkdir,
  clearWorktreeSlot,
  commitAllChanges,
  commitPartialWork,
  createCellBackend,
  createWorkdir,
  createWorkdirForRetry,
  buildContextPaths,
  ensureTargetGitInit,
  environmentVersion,
  getChangedFiles,
  pruneStaleEnvironmentImages,
  readEnvironmentDefinition,
  recipePaths,
  resolveCurrentEnvironment,
  targetRepo,
  withTargetCheckout,
} from "@ashara/execution-infra";
import { PreCallRefusal } from "@ashara/finance";
import type { ContextualTurnLlm } from "@ashara/finance";
import type { ResolvedModel } from "@ashara/model-access";
import type { ProjectId, WorkItemId, AgentBrief, Clock, ErrorEnvelope, ErrorLayer, StoredTaskSpec, StoredBlockedReason, WorkKind } from "@ashara/shared";
import { createSessionId, createAgentBrief, describeErrorChain, parseWorkItemId, wrapError, errorEnvelopeSchema, renderChainForBrief, renderElided } from "@ashara/shared";
import type {
  AssignmentRole,
  CheckDefinition,
  CheckDefinitionPort,
  CheckRedRunPreview,
  CheckRunReport,
  FoundationProbe,
  Outcome,
  TaskCheckRunPort,
} from "@ashara/workplace";
import {
  checkPassed,
  checkVerdict,
  describeProductChange,
  environmentBuildPassed,
  environmentCheckPassed,
  environmentCommandsPassed,
  environmentProbePassed,
  formatEnvironmentCheck,
  formatCheckRuns,
  formatEnvironmentCommands,
  formatEnvironmentProbe,
  runAttempt,
} from "@ashara/workplace";
import { formatAcceptanceCriteria, formatTaskSpec } from "./brief-assembly.js";
import { DispatchRecords, attemptSummary, outcomeRecord, toSessionAttempt } from "./cell-execution.js";
import type { SessionAttempt } from "./cell-execution.js";
import { buildContextMap } from "./context-map.js";
import { environmentCheckPort, runFoundationBuild, runPostMergeEnvironmentCommands, runPostMergeProbe, runSubstrateGate } from "./environment-check.js";
import type { EnvironmentStatementStore, SubstrateGateRun, TestedEnvironment } from "./environment-check.js";
import { DispatchFault, environmentErrorOf, thrownFaultOf, unavailableOf } from "./fault-class.js";
import type { EnvironmentError, FaultClass } from "./fault-class.js";
import { ProjectIntentUnavailable, loadProjectIntent } from "./project-intent.js";
import type { ProjectIntentSource } from "./project-intent.js";
import type { TaskSpec } from "./types.js";
import { VerificationInfrastructureFault, finalizeSuccess } from "./gates/finalize.js";
import type { FinalizeDeps, PostMergeVerdict } from "./gates/finalize.js";
import { branchChangedPaths, checkBranchOwnership } from "./gates/ownership.js";
import {
  CheckRecorder,
  FoundationUnbuildable,
  StoredChecksStale,
  checkAreaOf,
  checkBranchName,
  describeFoundationBuild,
  discardCheckWorkdir,
  dropCheckBranch,
  foundationProbeOf,
  formatChecksForBrief,
  formatFoundationForCheckAuthor,
  formatProjectChecksForCheckAuthor,
  harvestCheckFiles,
  headCommit,
  mainCommit,
  previewCheckFiles,
  productChangeOf,
  redRunPreview,
  redRunProblem,
  redRunSetProblem,
  redRunVerdict,
  runChecksOnCheckout,
  runSuitesOnCheckout,
  tentativeMergeCommit,
  worktreeSnapshotCommit,
} from "./task-checks.js";
import type { CheckCells, CheckSuite, CompletedTaskChecks, SuiteRun, TaskCheckStore, TaskChecks } from "./task-checks.js";
import {
  ConflictRetryUnprepared,
  branchExists,
  conflictWithMain,
  discardTaskBranch,
  formatConflictForBrief,
  mainMergedForRetry,
  stagedConflictMarkers,
  taskBranchName,
} from "./merge.js";
import type { MainConflict } from "./merge.js";
import type { KnowledgeSection, KnowledgeSink, KnowledgeScope, KnowledgeSource } from "./knowledge-writer.js";
import type { SuiteReviewing } from "./suite-review.js";
import { buildKnowledgeQueryText, renderKnowledgeContext, storeFailureKnowledge } from "./knowledge-writer.js";

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function cleanupWorkdirBeforeReturn(taskId: string, workDir: string, targetProjectPath: string, why: string): Promise<void> {
  try {
    await cleanupWorkdir(workDir, targetProjectPath);
  } catch (cleanupError) {
    console.warn(`[${taskId}] workdir cleanup failed (${workDir}) after ${why}:`, cleanupError);
  }
}

/**
 * The stage of a dispatch whose substrate or Z0 machinery failed: the probe, the environment, the
 * work plan, the staffing, the worktree, the resumed branch and the task cell before the attempt,
 * the attempt itself, the substrate gate, the red run of a check task's checks on main, and the
 * post-merge verifier cell; postMergeCheckRun, where Z0's own machinery around the merge and its
 * check (the merge itself, a worktree, the tentative merge's commit, a check file, the dirty-tree
 * check) failed and no verdict was reached; and runExecution, a throw out of the dispatch past the
 * cell's creation that no stage caught.
 */
type EnvironmentStage =
  | "probeSubstrate"
  | "resolveEnvironment"
  | "planWork"
  | "buildBrief"
  | "assignAgent"
  | "createWorkdir"
  | "resumeBranch"
  | "prepareConflictRetry"
  | "runExecution"
  | "createCell"
  | "agentAttempt"
  | "commitWork"
  | "branchWork"
  | "substrateGate"
  | "checkRedRun"
  | "deliveredCheckRun"
  | "ownershipGate"
  | "conflictResolution"
  | "postMergeVerify"
  | "postMergeCheckRun";

/**
 * What became of the agent's work when a dispatch ended without done: no agent ran; it is
 * committed on the task branch for the next dispatch; for a check task, discarded (nothing of a
 * check task is kept, its next attempt starts again from main); for an attempt handed a conflict
 * with main, its unfinished merge is discarded with the worktree; git refused the partial commit
 * and the work is lost with the worktree; or not known, when Z0 itself failed mid-dispatch.
 */
type AgentWork = "none" | "kept" | "discarded" | "merge-discarded" | "unknown" | { readonly lost: string };

interface AgentPart {
  readonly outcome: Outcome | null;
  readonly agentWork: AgentWork;
}

const NO_AGENT: AgentPart = { outcome: null, agentWork: "none" };

/** The agent's work as the partial commit left it: stated by what git did, never by the kind of work. */
function agentWorkOf(partial: PartialCommitOutcome): Exclude<AgentWork, "none" | "discarded"> {
  if (partial.committed) return "kept";
  switch (partial.reason) {
    case "no-changes":
      return "kept";
    case "merge-in-progress":
      return "merge-discarded";
    case "git-error":
      return { lost: partial.message };
  }
}

function describeAgentWork(work: AgentWork): string {
  if (typeof work === "object") {
    return `the agent's uncommitted work could not be committed (${work.lost}) and is discarded with the worktree; the task branch is as it was`;
  }
  switch (work) {
    case "none":
      return "no agent ran and nothing executed";
    case "kept":
      return "the agent's work is kept on the task branch";
    case "discarded":
      return "the check task's partial work is discarded; its next attempt starts again from main";
    case "merge-discarded":
      return "the attempt's merge of main is discarded uncommitted; the task branch is as it was and its next attempt merges main again";
    case "unknown":
      return "what became of the attempt's work is not known: Z0 failed mid-dispatch, and the task branch is as Z0's last step left it";
  }
}

/** The dispatch a result or event belongs to: its task and the item's real dispatch ordinal. */
type DispatchRef = Pick<TaskDescriptor, "id" | "attempt">;

interface EnvironmentBlock extends AgentPart {
  readonly task: DispatchRef;
  readonly sessionId: string;
  readonly stage: EnvironmentStage;
  /** Whose failure it is: never the agent's work (fault-class.ts). */
  readonly fault: Exclude<FaultClass, "agent_work">;
  /** The failure's class name, e.g. MountPathRejected; the reason names it. */
  readonly errorClass: string;
  readonly message: string;
  readonly chain: ErrorLayer;
  readonly unavailable: string;
}

/**
 * The substrate cannot host a stage of the task (podman missing or not answering, a cell that
 * cannot start or be mounted, an exec the substrate could not run), or Ashara's own Z0 machinery
 * failed under it (a store, git on the host, a bug): Blocked under its fault class with the stage
 * and error class named, never a host fallback, never a failure for the classifier and never a
 * lesson (s-isolated-worker-m1 C2, at every stage; ADR-080 d3 c).
 */
function environmentBlocked(block: EnvironmentBlock, eventSink: ExecutionEventSink | undefined): ExecutionResult {
  const { task, stage, errorClass } = block;
  const taskId = task.id;
  const kept = describeAgentWork(block.agentWork);
  const failed = block.fault === "substrate" ? "environment failed" : "Ashara's own machinery failed";
  const envelope: ErrorEnvelope = {
    outcome: "blocked",
    summary: `${failed} at stage ${stage} (${errorClass}): ${block.message}; task ${taskId} blocked, ${kept}`,
    chain: block.chain,
    ...(block.outcome !== null ? { agentOutput: outcomeRecord(block.outcome) } : {}),
  };
  console.warn(`[${taskId}] ${envelope.summary}`);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: task.attempt, stage, errorClass, reason: envelope.summary });
  return {
    status: "environment_blocked",
    fault: block.fault,
    unavailable: block.unavailable,
    detail: envelope.summary,
    outcome: block.outcome,
    sessionId: block.sessionId,
    attempt: task.attempt,
    errorEnvelope: envelope,
  };
}

/** An environment block for a typed substrate error raised at `stage`. */
function substrateBlocked(
  task: DispatchRef,
  sessionId: string,
  stage: EnvironmentStage,
  e: EnvironmentError,
  cell: string,
  agent: AgentPart,
  eventSink: ExecutionEventSink | undefined,
  chain?: ErrorLayer,
): ExecutionResult {
  const unavailable = unavailableOf(e, cell);
  return environmentBlocked(
    {
      task,
      sessionId,
      stage,
      fault: "substrate",
      errorClass: e.name,
      message: e.message,
      chain: chain ?? wrapError("development", stage, e, { taskId: task.id, unavailable, errorClass: e.name }),
      unavailable,
      ...agent,
    },
    eventSink,
  );
}

/** What of Ashara's own machinery failed, named for the operator. */
function asharaUnavailableOf(fault: VerificationInfrastructureFault | DispatchFault): string {
  if (fault.cause instanceof WorktreeCommitFailed) return `host git (${fault.cause.step} of the task worktree)`;
  if (fault instanceof VerificationInfrastructureFault) return `verification infrastructure (${fault.step})`;
  return `Ashara's own machinery (${fault.step})`;
}

/** A block of class `ashara`: Z0's own machinery failed at `stage`. */
function asharaBlocked(
  task: DispatchRef,
  sessionId: string,
  stage: EnvironmentStage,
  fault: VerificationInfrastructureFault | DispatchFault,
  agent: AgentPart,
  eventSink: ExecutionEventSink | undefined,
  chain?: ErrorLayer,
): ExecutionResult {
  const unavailable = asharaUnavailableOf(fault);
  return environmentBlocked(
    {
      task,
      sessionId,
      stage,
      fault: "ashara",
      errorClass: fault.name,
      message: fault.message,
      chain: chain ?? wrapError("development", stage, fault, { taskId: task.id, unavailable, errorClass: fault.name }),
      unavailable,
      ...agent,
    },
    eventSink,
  );
}

/**
 * A throw out of a stage of a dispatch, blocked under its class (fault-class.ts): the substrate's,
 * with `cell` named, when its class says so; otherwise Ashara's, as a DispatchFault at `step`. A
 * throw is never the agent's work, so it is never failed against the task nor taught as a lesson.
 */
function thrownBlocked(
  task: DispatchRef,
  sessionId: string,
  stage: EnvironmentStage,
  e: unknown,
  where: { readonly step: string; readonly cell: string },
  agent: AgentPart,
  eventSink: ExecutionEventSink | undefined,
): ExecutionResult {
  const fault = thrownFaultOf(e);
  if (fault.class === "substrate") return substrateBlocked(task, sessionId, stage, fault.error, where.cell, agent, eventSink);
  const asharaFault =
    fault.error instanceof VerificationInfrastructureFault || fault.error instanceof DispatchFault
      ? fault.error
      : new DispatchFault(task.id, where.step, { cause: fault.error });
  return asharaBlocked(task, sessionId, stage, asharaFault, agent, eventSink);
}

/**
 * A run of checks on main that threw before any verdict (a check task's red run, or an
 * implementation's checks run on main when it changed nothing): a substrate failure blocks under
 * `stage` with the cell named; anything else is Z0's own machinery (main's commit, the
 * checkout's worktree or directory) and blocks as a VerificationInfrastructureFault at `step`.
 * Neither says anything about the checks or the task, so neither is ever a failure to route.
 */
function mainRunBlocked(
  task: DispatchRef,
  sessionId: string,
  e: unknown,
  agent: AgentPart,
  eventSink: ExecutionEventSink | undefined,
  stage: Extract<EnvironmentStage, "checkRedRun" | "deliveredCheckRun">,
  step: string,
): ExecutionResult {
  const environmentFailure = environmentErrorOf(e);
  if (environmentFailure !== null) return substrateBlocked(task, sessionId, stage, environmentFailure, "CI cell", agent, eventSink);
  return asharaBlocked(task, sessionId, stage, new VerificationInfrastructureFault(task.id, step, { cause: e }), agent, eventSink);
}

/**
 * A task decided by stored checks, or the product scaffold, reached its ownership gate or its
 * post-merge run without an environment: no recipe to hold its branch to, no test to run on its merge.
 */
class PostMergeEnvironmentMissing extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} is decided by stored checks but was dispatched on the BaseCell: no environment exists to check its work against`);
    this.name = "PostMergeEnvironmentMissing";
  }
}

/**
 * The environment a tentative merge is verified in: the dispatch's own version, unchanged; a new
 * version the merge produced by changing the build context (an input, ADR-074 addendum 2 d72 B3),
 * rebuilt and the product's build and test passed on it (`details` says so); or none the merge can
 * be verified in, which refuses it (`details` says why).
 */
type MergedEnvironment =
  | ({ readonly kind: "unchanged" } & MergedImage)
  | ({ readonly kind: "rebuilt"; readonly statement: string; readonly details: string } & MergedImage)
  | { readonly kind: "refused"; readonly details: string };

/** The image a merge is verified in, and the definition it was built from. */
interface MergedImage {
  readonly version: string;
  /** The image id: what the verifier cells start from. */
  readonly image: string;
  readonly imageRef: string;
  readonly definition: EnvironmentDefinition;
}

/**
 * The verdict on suites run in order (the environment's test, then `regressionCount` earlier
 * tasks' checks, then the task's own) on the task's tentative merge, or on main itself for a task
 * that changed nothing: passed only when every suite ran every one of its checks and each passed.
 * The details open with each failure, naming its suite and check. Only on a merge is an earlier
 * task's failing check this task's regression; on main the task changed nothing to cause it.
 *
 * @testseam execution-service.test.ts shows a check that never ran fails the verdict (c-independent-verify C2)
 */
export function suitesVerdict(
  suites: readonly CheckSuite[],
  runs: readonly SuiteRun[],
  regressionCount: number,
  on: "merge" | "main",
): PostMergeVerdict {
  const failures: string[] = [];
  const sections: string[] = [];
  let regressed = false;
  if (runs.length !== suites.length) failures.push(`${runs.length} of ${suites.length} suites reported a run`);
  suites.forEach((suite, index) => {
    const regression = on === "merge" && index >= 1 && index <= regressionCount;
    const prefix = regression ? "REGRESSION: " : "";
    const run = runs[index];
    if (run === undefined || run.suite !== suite) {
      failures.push(`${prefix}${suite.label}: did not run`);
      regressed ||= regression;
      return;
    }
    if (run.report.kind === "files_refused") {
      failures.push(`${prefix}${suite.label}: its check files could not be written over ${on === "merge" ? "the merged work" : "main"}: ${run.report.detail}`);
      sections.push(`${suite.label}: not run, its check files could not be written: ${run.report.detail}`);
      regressed ||= regression;
      return;
    }
    // Callers turn a product change into CheckRunChangedProduct first (productChangeOf); stated
    // here too, so this verdict never reads one as a pass.
    if (run.report.kind === "product_changed") {
      failures.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      sections.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      return;
    }
    const ran = run.report.runs;
    if (ran.length !== suite.checks.length || ran.length === 0) {
      failures.push(`${prefix}${suite.label}: ${ran.length} of ${suite.checks.length} checks ran`);
      regressed ||= regression;
    }
    for (const failed of ran.filter((check) => !checkPassed(check))) {
      failures.push(`${prefix}${suite.label}: check ${JSON.stringify(failed.name)} ${checkVerdict(failed)}`);
      regressed ||= regression;
    }
    sections.push(`${suite.label}:\n${formatCheckRuns(ran, checkVerdict)}`);
  });
  if (failures.length === 0) return { passed: true, details: sections.join("\n") };
  const head = [`${failures.length} failure(s) on ${on === "merge" ? "the merge" : "main"}:`, ...failures.map((failure) => `- ${failure}`)];
  if (regressed) {
    head.push("This task's merge breaks checks of a task already merged: the regression is this task's, and nothing was merged.");
  }
  return { passed: false, details: [...head, "", ...sections].join("\n") };
}

/** The PreCallRefusal anywhere in the error's cause chain, or null when no model call was refused. */
function preCallRefusalOf(e: unknown): PreCallRefusal | null {
  for (let current: unknown = e; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return current;
  }
  return null;
}

function failedBeforeAgent(task: DispatchRef, sessionId: string, operation: string, e: unknown, summary: string): ExecutionResult {
  const chain = wrapError("development", operation, e, { taskId: task.id });
  const envelope: ErrorEnvelope = { outcome: "failed", summary: `${summary}: ${chain.message}`, chain };
  return {
    status: "failed",
    detail: envelope.summary,
    outcome: null,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: envelope,
  };
}

/**
 * What a dispatch's cells are started from: the BaseCell only for the Sprint 0 task, whose work is
 * defining the environment; the current environment version's image for every other task.
 */
type DispatchEnvironment =
  | { readonly kind: "base-cell"; readonly image: string; readonly digest: string }
  | ({ readonly kind: "environment" } & CurrentEnvironment);

function cellImageOf(environment: DispatchEnvironment): string {
  return environment.kind === "base-cell" ? environment.image : environment.imageId;
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

/**
 * What decides a task's work: the environment substrate (Sprint 0 and every environment task), the
 * product's own build and test from the definition (the product scaffold, ADR-074 addendum 2 d72
 * B2), the checks the check author stored for it (every other implementation task), or, for a check
 * task, Z0's red run of the checks it defines (story s-independent-verify-m1). Resolved before the
 * brief and the worktree.
 */
type WorkPlan =
  | { readonly kind: "substrate" }
  | { readonly kind: "scaffold" }
  | {
      readonly kind: "stored-checks";
      readonly stored: TaskChecks;
      /**
       * The latest checks of every task of the project already merged: the regression suite the
       * merge must pass, any check of which the implementer may dispute (ADR-074 addendum 2 d74 D).
       */
      readonly merged: readonly CompletedTaskChecks[];
    }
  | {
      readonly kind: "check-authoring";
      readonly checkedTaskId: string;
      readonly environment: CurrentEnvironment;
      /** The checked task's latest stored revision, when its checks are being written again. */
      readonly prior: TaskChecks | null;
      /** The commit every authoring of these checks is red-run on (ADR-074 addendum 2 d74 A). */
      readonly foundation: CheckFoundation;
    };

/** The plan revision's foundation a check task red-runs on: the merged task and its recorded merge commit. */
interface CheckFoundation {
  readonly taskId: string;
  readonly commit: string;
}

/** A check task's plan once its throwaway worktree exists. */
interface CheckAuthoring {
  readonly kind: "check-authoring";
  readonly checkedTaskId: string;
  readonly environment: CurrentEnvironment;
  readonly prior: TaskChecks | null;
  readonly foundation: CheckFoundation;
  readonly branch: string;
  /** The main commit the worktree started from: the attempt's files are its diff against it. */
  readonly startCommit: string;
  readonly recorder: CheckRecorder;
}

type DispatchWork = Exclude<WorkPlan, { readonly kind: "check-authoring" }> | CheckAuthoring;

/** A task no work plan can be made for: it fails before the agent, with the reason. */
interface Unplannable {
  readonly kind: "unplannable";
  readonly operation: string;
  readonly reason: string;
}

/** The version recorded on the dispatch's dev_sessions row; null when its cells ran on the BaseCell. */
function sessionEnvironmentVersion(environment: DispatchEnvironment): string | null {
  return environment.kind === "environment" ? environment.version : null;
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

// ---------------------------------------------------------------------------
// Injected dependency interfaces
// ---------------------------------------------------------------------------

/**
 * The dev_sessions attempt log: when an attempt opened and how it ended. Not a verdict on the
 * task and not a record of what was merged (that is the work item's merge commit, migration
 * 041): its terminal write is fail-soft, so nothing is decided on it.
 */
export interface SessionStore {
  /** `environmentVersion` is the version the dispatch's cells were built from; null on the BaseCell. */
  insert(sessionId: string, taskId: string, brief: unknown, environmentVersion: string | null): Promise<void>;
  /** `attempt`: the session's Workplace attempt, or null when no attempt outcome reached it (ended before the model, or the attempt threw). */
  /** `attemptEnd`: the completion's own detail, so a session that completed with no attempt says why. */
  complete(sessionId: string, attempt: SessionAttempt | null, attemptEnd: { readonly outcome: "completed"; readonly detail: string }): Promise<void>;
  fail(sessionId: string, attemptEnd: unknown, attempt: SessionAttempt | null): Promise<void>;
}

/** Where runExecution leaves its attempt for the session's terminal write; null until runAttempt returns. */
interface AttemptSlot {
  attempt: SessionAttempt | null;
}

export interface ExecutionEventSink {
  // open-by-design: log events carry caller-defined fields alongside the required `event` tag
  emit(event: Record<string, unknown> & { readonly event: string }): void;
}

/** What execution needs of the container substrate; execution-infra's PodmanSubstrate satisfies it. */
interface CellSubstrate {
  probeSubstrate(): Promise<SubstrateInfo>;
  createCell(spec: CellSpec): Promise<Cell>;
}

/** The cells every dispatch runs on. */
interface ExecutionCells {
  readonly substrate: CellSubstrate;
  /** The image the Sprint 0 task's cells start from (config/base-cell.toml); no other task uses it. */
  readonly baseCell: BaseCellReference;
  /** The ashara.instance label of every cell this process creates; reconcileOrphans selects on it. */
  readonly instance: string;
}

/** Who works a task and on which model: the task's owner role, as the project's roster names it. */
interface AgentStaff {
  readonly role: AssignmentRole;
  readonly model: ResolvedModel;
}

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

// ---------------------------------------------------------------------------
// Configuration (subset relevant to execution)
// ---------------------------------------------------------------------------

interface DevelopmentConfig {
  readonly workdirBase: string;
}

// ---------------------------------------------------------------------------
// Task descriptor (minimal — no WorkItem aggregate dependency)
// ---------------------------------------------------------------------------

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
   * The task's true Epic ancestor id, walked up by the orchestrator (which owns
   * the WorkItem hierarchy) before constructing this descriptor — @ashara/development
   * has no dependency on @ashara/planning to walk it itself (kl-t2/Q5). `null`
   * means the walk ran and found no Epic ancestor; `undefined` (callers that don't
   * set it, e.g. unit tests) falls back to `parentId` at the write site below.
   */
  readonly epicId?: string | null;
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

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

/**
 * The outcome of a dispatch the execution substrate could not host, or Ashara's own Z0 machinery
 * failed under: the substrate was unavailable before the attempt (no agent ran, nothing
 * executed), a cell failed under a running attempt (environment_failure), the substrate gate, a
 * check task's red run or the post-merge verifier cell could not run, or a store, git on the host
 * or Z0's own code failed at any stage.
 * It is not a task failure (re-dispatching cannot make the substrate appear),
 * so the orchestrator requeues the item uncharged within its infrastructure fault
 * budget (past it the project halts under the fault's class, and a task whose faults outlast
 * the halt is given up with an `environment_unavailable` reason) instead of routing it
 * through the FailureRouter.
 */
interface EnvironmentBlockedResult {
  readonly status: "environment_blocked";
  /**
   * Whose failure it is (fault-class.ts): the substrate's (the project halts on infrastructure past
   * the budget, until the substrate probe passes) or Ashara's own Z0 machinery (the project halts
   * for the operator past the budget, the report naming Ashara). Never the agent's work.
   */
  readonly fault: Exclude<FaultClass, "agent_work">;
  /** What was unavailable, named for the operator (e.g. "container substrate (podman)"). */
  readonly unavailable: string;
  readonly detail: string;
  /** null when no agent ran; the attempt's Outcome when a cell failed under it. */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The project has no environment the task's cells could be built from (none defined on the
 * target's main, its image could not be built, or no statement of it is on record). Nothing ran;
 * the orchestrator gives the item up with an `environment_undefined` reason, for a plan repair.
 */
interface EnvironmentUndefinedResult {
  readonly status: "environment_undefined";
  readonly reason: string;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * A turn's model call was refused before it was sent (Finance's spend cap or price list), so the
 * attempt stopped there. Not a task failure and never a lesson, whatever refused it: a spend cap,
 * or a configuration fault (an unpriced model, a call whose cost cannot be estimated). The
 * orchestrator returns the item to Pending without consuming its dispatch and, for a
 * configuration fault, blocks the project with the refusal's class; no failure router either way.
 * The agent's partial work is committed on the task branch for the next dispatch, except a check
 * task's, which is discarded (its next attempt starts from main); `detail` says which.
 */
interface RefusedResult {
  readonly status: "refused";
  readonly refusal: PreCallRefusal;
  readonly detail: string;
  /** null for a review of a plan's suites, whose one structured call ran without an agent. */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The process's shutdown signal cancelled the attempt mid-flight. Not a task failure and not a
 * lesson: the work was stopped, not tried and found wanting. The orchestrator returns the item to
 * Pending and refunds the dispatch; the partial work is committed on the task branch, or for a
 * check task discarded, and `detail` says which. A wall-clock
 * exhaustion is not this: it is the attempt's own limit and stays a failure.
 */
interface InterruptedResult {
  readonly status: "interrupted";
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The task's stored checks were red-run on another environment version and on the dispatch's no
 * longer all fail on main, nor all pass there (that is work already delivered, d67 b): they cannot
 * decide its work. Not the implementer's failure (no model ran)
 * and no lesson: the orchestrator reopens the check task that must write them again and the item
 * waits on it (planning's exitStaleChecks, bounded by `revision`), never routes it through the
 * FailureRouter, whose replan would meet the same checks.
 */
interface ChecksStaleResult {
  readonly status: "checks_stale";
  readonly checkTaskId: string;
  /** The stale revision of the task's checks: how many times they were written. */
  readonly revision: number;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer disputed one of the task's stored checks with dispute_check (ADR-074 addendum 2
 * d65 c): it holds that the check cannot pass on correct work. Not the task's failure and no
 * lesson: the orchestrator reopens the check task that wrote it, with the dispute in its brief, and
 * the item waits on it (bounded per check task), never routing it through the FailureRouter. The
 * partial work is committed on the task branch for the next dispatch.
 */
interface DisputedResult {
  readonly status: "disputed";
  /**
   * The task whose stored checks hold the disputed check: the dispatched task itself, or a task
   * already merged whose check blocks its merge (ADR-074 addendum 2 d74 D).
   */
  readonly checksOf: string;
  /** The check task that wrote the disputed check: the one to reopen. */
  readonly checkTaskId: string;
  /** The revision of the task's checks the disputed check belongs to. */
  readonly revision: number;
  /** The disputed check as stored. */
  readonly check: { readonly name: string; readonly command: string };
  readonly reason: string;
  /** The output of the attempt's last run_checks; null when it never ran them. */
  readonly evidence: string | null;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer's finished work changed recipe files and nothing else the ownership gate
 * refuses: it needs an environment change, which only the platform role makes (ADR-074
 * addendum 2 d66 b, d72 B1). Nothing was merged, and the task branch is deleted, so the task's next
 * dispatch starts a fresh branch from main once the environment has changed. Not the task's
 * failure and no lesson: the orchestrator opens an environment task carrying `need` and `diff`
 * and the item waits on it (bounded per implementation task), never routing it through the
 * FailureRouter.
 */
interface EnvironmentChangeRequestedResult {
  readonly status: "environment_change_requested";
  /** The recipe files the branch changed. */
  readonly paths: readonly string[];
  /** The implementer's own statement of what it needs: its finish summary. */
  readonly need: string;
  /** The branch's diff of those files against where it left main; a cut is marked. */
  readonly diff: string;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The task has no owner role, or its owner is not in the project's latest roster. Nothing ran;
 * the orchestrator gives the item up with an `owner_unresolved` reason, for a plan repair.
 */
interface OwnerUnresolvedResult {
  readonly status: "owner_unresolved";
  readonly ownerRoleId: string | null;
  /** The roster revision the decision was made against, recorded as evidence; null when the project has none. */
  readonly rosterRevision: number | null;
  readonly reason: string;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The review of a plan revision's suites (ADR-074 addendum 2 d71 c) found problems: checks no
 * product can pass together, or checks of behaviour no vision item asks for. Its schema validated
 * and every check task it names is one whose suite it read. Not the review's failure and no lesson:
 * the orchestrator records the findings, reopens each named check task with them (bounded per check
 * task) and returns the review to Pending to read the new suites, never routing it through the
 * FailureRouter.
 */
interface SuiteReviewProblemsResult {
  readonly status: "suite_review_problems";
  readonly problems: ReadonlyArray<{
    readonly checkTaskIds: readonly string[];
    readonly kind: "contradiction" | "outside-vision";
    readonly problem: string;
    readonly evidence: string;
  }>;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * Every status an ExecutionResult can carry. `satisfies` keeps each member a real status;
 * execution-service.test.ts checks the converse, that no status is missing.
 */
export const EXECUTION_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "suite_review_problems",
  "environment_blocked",
  "environment_undefined",
  "refused",
  "checks_stale",
  "disputed",
  "environment_change_requested",
  "owner_unresolved",
  "interrupted",
] as const satisfies readonly ExecutionResult["status"][];

export type ExecutionResult =
  | AgentExecutionResult
  | CompletedResult
  | SuiteReviewProblemsResult
  | EnvironmentBlockedResult
  | EnvironmentUndefinedResult
  | RefusedResult
  | ChecksStaleResult
  | DisputedResult
  | EnvironmentChangeRequestedResult
  | OwnerUnresolvedResult
  | InterruptedResult;

interface AgentExecutionResult {
  readonly status: "failed" | "blocked";
  readonly detail: string;
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  /**
   * The item's dispatch ordinal (TaskDescriptor.attempt). execute() makes exactly one agent
   * invocation per call; retrying a failed task is the orchestrator's FailureRouter's job.
   */
  readonly attempt: number;
  readonly errorEnvelope?: ErrorEnvelope;
}

/**
 * What a completed task delivered. A merging task's record is the merge commit Z0 made on main,
 * which the orchestrator records on the work item before completing it; a check task merges
 * nothing, it records checks for the task they decide.
 */
type Delivery =
  | { readonly kind: "merged"; readonly mergeCommit: string }
  /**
   * An implementation that changed nothing whose checks and the regression suite already pass on
   * main (ADR-074 addendum 2 d67 b): `mainCommit` is main when they ran, the delivering commit.
   */
  | { readonly kind: "already-delivered"; readonly mainCommit: string }
  | { readonly kind: "checks-recorded"; readonly revision: number }
  /**
   * A check task whose author finished blocked, and whose checked task's stored checks (`revision`),
   * the environment's test and the regression suite all pass on main at `mainCommit` (ADR-074
   * addendum 2 d74 A): no new revision; the checked task's delivered sweep closes it.
   */
  | { readonly kind: "checked-task-delivered"; readonly checkedTaskId: string; readonly mainCommit: string; readonly revision: number }
  /** A review of the plan's suites that found no problem in the suites of `reviewed` check tasks. */
  | { readonly kind: "suites-reviewed"; readonly reviewed: readonly string[] };

/**
 * An acceptance sweep on main HEAD (DevelopmentService.sweepForAcceptance): `ran` with its verdict
 * and the run as the verdict states it, `environmentVersion` null when main defines no environment
 * its cells can be built from; `unrunnable`, nothing decided, when the substrate failed under it
 * (its probe failed, or an EnvironmentError stopped a stage); or `faulted`, nothing decided, when
 * anything else stopped it (Z0's git or checkout machinery, a store, a bug): not the machines, so
 * never reported as the machines. `mainCommit` of a fault is null when main could not be read.
 */
export type AcceptanceSweep =
  | {
      readonly kind: "ran";
      readonly passed: boolean;
      readonly mainCommit: string;
      readonly environmentVersion: string | null;
      /** Completed implementation tasks whose latest stored checks ran. */
      readonly checkedTasks: readonly string[];
      /** Completed implementation tasks with no stored check: nothing of theirs ran, so they are not checked. */
      readonly uncheckedTasks: readonly string[];
      readonly details: string;
    }
  | { readonly kind: "unrunnable"; readonly error: EnvironmentError }
  | { readonly kind: "faulted"; readonly mainCommit: string | null; readonly error: AcceptanceSweepFault };

/** A step of an acceptance sweep failed on something other than the substrate: no verdict exists. */
class AcceptanceSweepFault extends Error {
  constructor(
    readonly projectId: ProjectId,
    /** What Z0 was doing when it failed, e.g. "read main". */
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`the acceptance sweep of project ${projectId} could not run: ${step} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "AcceptanceSweepFault";
  }
}

interface CompletedResult {
  readonly status: "completed";
  readonly delivered: Delivery;
  readonly detail: string;
  /** null for work found already delivered before any model was called, and for a review of the plan's suites (no agent). */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope?: undefined;
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

/** Why an implementer's done with nothing to merge is not taken at its word. */
const NO_CHANGE_REASON = "agent produced no file changes: the task branch holds no change against main";

/** The ashara.role label of the post-merge check's cell. */
const POST_MERGE_VERIFIER_ROLE = "verifier";
/** The ashara.role label of the cell a check task's checks are red-run in on main. */
const RED_RUN_ROLE = "ci";

/** How a substrate-checked task's gate ended: passed with the image it tested, or the dispatch's result. */
type SubstrateGateOutcome =
  | { readonly kind: "passed"; readonly tested: TestedEnvironment }
  | { readonly kind: "ended"; readonly result: ExecutionResult };

// ---------------------------------------------------------------------------
// DevelopmentService
// ---------------------------------------------------------------------------

export interface DevelopmentServiceDeps {
  readonly config: DevelopmentConfig;
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

export class DevelopmentService {
  private readonly deps: DevelopmentServiceDeps;

  constructor(deps: DevelopmentServiceDeps) {
    this.deps = deps;
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
      // Every build_environment call leaves an image (third run N12): once the environment task
      // ends, however it ends, only main's current version and images in use are kept.
      if (task.workKind === "environment") {
        await pruneStaleEnvironmentImages(task.projectId, targetProjectPath, this.deps.environment.images);
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
      goal: task.taskSpec?.goal ?? task.title,
      // The stored grade as it is (ADR-074 addendum 2 d70), never a default: staffing refuses a task
      // without one, and the model it is staffed with is emitted when its attempt starts.
      capability: task.taskSpec?.capability,
    });

    // A review of the plan's suites reads stored checks and the vision in one structured call: no
    // substrate, environment, worktree or cell is involved, so none is probed.
    if (task.taskSpec?.origin === "review") return this.reviewSuites(task, sessionId, targetProjectPath);

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
        version: environment.version,
        commit: environment.commit,
        imageId: environment.imageId,
        imageRef: environment.imageRef,
        reused: environment.reused,
      });
    }

    // Before the brief and any model call: what decides the work. An implementation task with no
    // stored checks, or a check task that decides no single task, is not dispatched.
    let plan: WorkPlan;
    try {
      const planned = await this.planWork(task, environment);
      if (planned.kind === "unplannable") {
        const result = failedBeforeAgent(task, sessionId, planned.operation, planned.reason, `no work plan for ${task.id}`);
        eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
        await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
        return result;
      }
      plan = planned;
    } catch (e) {
      return thrownBlocked(task, sessionId, "planWork", e, { step: "read the checks that decide the work", cell: "CI cell" }, NO_AGENT, eventSink);
    }

    // A retry resumes the task's branch. When it conflicts with main (a batch partner merged the
    // same files first, w12b D2), the attempt starts with main merged into it and the conflict in
    // its worktree, named in its brief: the branch as it is would only conflict again. A conflict
    // that cannot be prepared is Z0's git and blocks under class ashara, never dispatching the branch unchanged.
    // A branch that merges cleanly starts with main merged into it (P6: a tree regression is repaired
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
      brief = await this.buildBrief(task, targetProjectPath, environment, plan, conflict);
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
          work = { ...plan, branch, startCommit: await headCommit(workdir.repo, task.id), recorder: new CheckRecorder() };
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
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the task cell could not be created");
      return thrownBlocked(task, sessionId, "createCell", e, { step: "create the task cell", cell: "task cell" }, NO_AGENT, eventSink);
    }
    eventSink?.emit({ event: "cell_created", taskId: task.id, cellId: cell.id, roleId: staff.role.id, role: staff.role.name, image: cellImageOf(environment), cellImage: attemptCellImage(environment) });

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
      eventSink?.emit({ event: "error", location: "DevelopmentService:execute", taskId: task.id, attempt: task.attempt, error: describeErrorChain(e) });
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "a throw out of the dispatch");
      return thrownBlocked(task, sessionId, "runExecution", e, { step: "run the dispatch", cell: "task cell" }, { outcome: null, agentWork: "unknown" }, eventSink);
    } finally {
      await this.teardownCell(task.id, cell);
    }
  }

  /**
   * The review of the plan revision's suites (ADR-074 addendum 2 d71 c). Clean only once the model's
   * verdict validated against its schema and names only suites it read: the plan's implementations
   * are released by completing it. Problems are returned for the orchestrator to route. A refused
   * model call is a refusal like an agent's; any other error, an unreadable suite or a verdict that
   * never validated included, fails the review, so nothing is released on it.
   */
  private async reviewSuites(task: TaskDescriptor, sessionId: string, targetProjectPath: string): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    let outcome: Awaited<ReturnType<SuiteReviewing["review"]>>;
    try {
      outcome = await this.deps.suiteReview.review(task, targetProjectPath);
    } catch (e) {
      const refusal = preCallRefusalOf(e);
      if (refusal !== null) {
        const summary = `the review of the plan's checks for ${task.id} stopped at a refused model call: ${refusal.message}; nothing was reviewed`;
        return {
          status: "refused",
          refusal,
          detail: summary,
          outcome: null,
          sessionId,
          attempt: task.attempt,
          errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", e, { taskId: task.id }) },
        };
      }
      const result = failedBeforeAgent(task, sessionId, "reviewSuites", e, `the review of the plan's checks for ${task.id} gave no verdict`);
      eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }
    const setAside = outcome.setAside.length === 0 ? "" : `; set aside the abandoned check task(s) ${outcome.setAside.join(", ")}`;
    if (outcome.kind === "clean") {
      const detail = `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found no problem${setAside}`;
      eventSink?.emit({ event: "suites_reviewed", taskId: task.id, attempt: task.attempt, reviewed: outcome.reviewed, setAside: outcome.setAside });
      return {
        status: "completed",
        delivered: { kind: "suites-reviewed", reviewed: outcome.reviewed },
        detail,
        outcome: null,
        sessionId,
        attempt: task.attempt,
      };
    }
    const named = [...new Set(outcome.problems.flatMap((problem) => problem.checkTaskIds))];
    const summary =
      `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found ` +
      `${outcome.problems.length} problem(s) in the checks of ${named.join(", ")}${setAside}:\n` +
      outcome.problems.map((p) => `- [${p.kind}; ${p.checkTaskIds.join(", ")}] ${p.problem}`).join("\n");
    console.warn(`[${task.id}] ${summary}`);
    eventSink?.emit({ event: "suite_review_problems", taskId: task.id, attempt: task.attempt, checkTasks: named, problems: outcome.problems.length });
    return {
      status: "suite_review_problems",
      problems: outcome.problems,
      detail: summary,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", summary, { taskId: task.id, checkTasks: named }) },
    };
  }

  /** A failed teardown is logged at warn with its typed context; the substrate keeps the cell for teardownAll and reconcileOrphans. */
  private async teardownCell(taskId: string, cell: Cell): Promise<void> {
    try {
      await cell.teardown();
    } catch (e) {
      if (!(e instanceof CellTeardownFailed)) throw e;
      console.warn(`[${taskId}] cell teardown failed; teardownAll at shutdown and reconcileOrphans at startup remove it:`, e);
      this.deps.eventSink?.emit({ event: "cell_teardown_failed", taskId, cellId: e.cellId, exitCode: e.exitCode, stderr: e.stderr });
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
      const prior = await this.deps.checks.latest(parseWorkItemId(only, "TaskCheckStore.checkedTasksOf"));
      return {
        kind: "check-authoring",
        checkedTaskId: only,
        environment,
        prior,
        foundation: { taskId: foundation.taskId, commit: foundation.commit },
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

  /** Cells for checks: from the dispatch's environment image, each mounting one throwaway checkout. */
  private checkCells(d: Dispatch): CheckCells {
    const scope = this.environmentScope(d);
    return {
      targetProjectPath: d.targetProjectPath,
      createCell: scope.createCell,
      teardownCell: scope.teardownCell,
      timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
    };
  }

  /** A throwaway checkout of the dispatch, under the workdir base the substrate mounts from. */
  private checkoutDir(
    d: Dispatch,
    purpose:
      | "red-run"
      | "verify"
      | "verify-probe"
      | "post-merge-checks"
      | "delivered-on-main"
      | "delivered-sweep"
      | `run-checks-${number}`
      | `define-check-${number}`
      | `probe-foundation-${number}`
      | "environment-check"
      | "substrate-gate"
      | "foundation-build",
  ): string {
    return join(this.deps.config.workdirBase, "checkouts", `${purpose}-${d.task.id}-${d.sessionId}`);
  }

  private async buildBrief(
    task: TaskDescriptor,
    targetProjectPath: string,
    environment: DispatchEnvironment,
    plan: WorkPlan,
    conflict: MainConflict | null,
  ): Promise<AgentBrief> {
    const taskSpec = task.taskSpec;

    const replanContext = extractReplanContext(task.id, task.blockedReason);
    const priorAttemptFailure = replanContext ? formatPriorAttemptFailure(replanContext) : undefined;

    // A ProjectIntentUnavailable propagates to execute() and blocks the task.
    const projectIntent = await loadProjectIntent(this.deps.intentSource, task.id);

    const spec: TaskSpec = {
      goal: (typeof taskSpec?.goal === "string" ? taskSpec.goal : task.title),
      endState: (typeof taskSpec?.endState === "string" ? taskSpec.endState : `Implement: ${task.title}`),
      scope: (typeof taskSpec?.scope === "string" ? taskSpec.scope : ""),
      deliverables: stringArrayOrEmpty(taskSpec?.deliverables),
    };

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
        ...(priorAttemptFailure !== undefined ? { priorAttemptFailure } : {}),
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
      epicId: task.epicId ?? null,
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
        entries: approaches.map((a) => `- "${a.title}" — Failed: ${a.failureReason} (affected: ${a.affectedArea})\n  Learned: ${a.learned}`),
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
      const stale = await this.revalidateOnBaseline(d, d.work.stored);
      if (stale !== null) return stale;
      const delivered = await this.sweepDelivered(d, d.work.stored);
      if (delivered !== null) return delivered;
    }
    // A check author is dispatched only on a foundation the environment builds (W11 D2): on one it
    // does not, every check fails for that reason alone and the red run could decide nothing.
    if (d.work.kind === "check-authoring") {
      const unbuilt = await this.foundationBuildGate(d, d.work);
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
        workKind: task.workKind,
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
        environment: task.workKind === "environment" ? environmentCheckPort(this.environmentScope(d)) : null,
        checks: d.work.kind === "check-authoring" ? this.checkDefinitionPort(d, d.work) : null,
        taskChecks: d.work.kind === "stored-checks" ? this.taskCheckRunPort(d, d.work.stored, d.work.merged) : null,
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
    if (d.work.kind === "check-authoring") return this.keepChecks(d, d.work, outcome);

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
      if (workChanged.length === 0 && d.work.kind === "stored-checks") return this.deliveredOnMain(d, d.work.stored, { outcome, agentWork: "kept" }, outcome.turnsUsed);
      if (workChanged.length === 0) {
        const reason = NO_CHANGE_REASON;
        eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
        await cleanupWorkdir(workDir, targetProjectPath);
        const chain = wrapError("development", "agentExecution", reason, { taskId: task.id, turnCount: outcome.turnsUsed });
        return {
          status: "failed",
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
      const refused = await this.ownershipGate(d, outcome);
      if (refused !== null) return refused;
    }

    let finalizeDeps: Omit<FinalizeDeps, "presentedConflict" | "workdirBase">;
    if (d.work.kind === "substrate") {
      const gate = await this.substrateGate(d, outcome.statement, outcome);
      if (gate.kind === "ended") return gate.result;
      finalizeDeps = {
        eventSink,
        postMergeOperation: "postMergeVerify",
        postMergeVerify: (path, lease) => this.postMergeEnvironmentTest(d, path, gate.tested, lease),
      };
    } else if (d.work.kind === "scaffold") {
      // No gate ran the scaffold's build and test before its merge: their verdict there is its
      // own attempt's, never a regression of the tree (ADR-074 addendum 2 d74 D).
      finalizeDeps = {
        eventSink,
        postMergeOperation: "postMergeScaffold",
        postMergeVerify: (path, lease) => this.postMergeScaffold(d, path, lease),
      };
    } else {
      const { stored } = d.work;
      finalizeDeps = {
        eventSink,
        postMergeOperation: "postMergeTaskChecks",
        postMergeVerify: (path, lease) => this.postMergeStoredChecks(d, path, stored, lease),
      };
    }

    const finalizeResult = await finalizeSuccess(
      { ...finalizeDeps, presentedConflict: d.conflict, workdirBase: this.deps.config.workdirBase },
      task,
      targetProjectPath,
      task.attempt,
    );
    if (!finalizeResult.success && finalizeResult.fault.class === "substrate") {
      // The merge was aborted and the branch kept: the verifier cell's substrate
      // failed, which is the operator's to fix, not a regression of the tree.
      await cleanupWorkdir(workDir, targetProjectPath);
      return substrateBlocked(
        task,
        sessionId,
        "postMergeVerify",
        finalizeResult.fault.error,
        "verifier cell",
        { outcome, agentWork: "kept" },
        eventSink,
        finalizeResult.errorLayer,
      );
    }
    if (!finalizeResult.success && finalizeResult.fault.class === "ashara") {
      // No verdict was reached, so nothing is known of the task's work: blocked for the operator,
      // the merge aborted and the branch kept, never a failure the task is replanned against.
      await cleanupWorkdir(workDir, targetProjectPath);
      return asharaBlocked(task, sessionId, "postMergeCheckRun", finalizeResult.fault.error, { outcome, agentWork: "kept" }, eventSink, finalizeResult.errorLayer);
    }
    if (!finalizeResult.success) {
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
        detail: envelope.summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: envelope,
      };
    }

    await cleanupWorkdir(workDir, targetProjectPath, taskBranchName(task.id));
    // Stated from the disk, not assumed: cleanupWorkdir's own fallbacks are best-effort.
    if (await pathExists(workDir)) {
      console.warn(`[${task.id}] task completed — but worktree ${workDir} is still on disk after cleanup`);
    } else {
      console.log(`[${task.id}] task completed — worktree ${workDir} removed after the merge`);
    }
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "completed" });
    return {
      status: "completed",
      delivered: { kind: "merged", mergeCommit: finalizeResult.mergeCommit },
      detail: "task completed and verified successfully",
      outcome,
      sessionId,
      attempt: task.attempt,
    };
  }

  /**
   * An implementer that finished done with no change against main (ADR-074 addendum 2 d67 b): an
   * earlier task may have delivered this one's work already. Z0 decides that by the checks, never by
   * the implementer's word: it runs them on main (mainSuitesRun). All pass: completed as already
   * delivered, with main's commit at that time as the delivering commit, the task branch deleted and
   * nothing merged. Any fails: failed as "no changes" with the run's output, the branch kept as
   * today. A run that could not run at all blocks for the operator.
   */
  private async deliveredOnMain(d: Dispatch, stored: TaskChecks, agent: AgentPart, turnCount: number): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const onMain = await this.mainSuitesRun(d, stored, agent);
    if (onMain.kind === "blocked") return onMain.result;
    if (onMain.verdict.passed) return this.alreadyDelivered(d, onMain.main, stored, agent);

    const reason = `${NO_CHANGE_REASON}, and its checks do not all pass on main, so its work is not already delivered:\n${onMain.verdict.details}`;
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
    await cleanupWorkdir(workDir, targetProjectPath);
    const { outcome } = agent;
    return {
      status: "failed",
      detail: reason,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "failed",
        summary: reason,
        chain: wrapError("development", "agentExecution", reason, { taskId: task.id, turnCount }),
        ...(outcome === null ? {} : { agentOutput: outcomeRecord(outcome) }),
      },
    };
  }

  /**
   * Before any model is called, sweepDelivered found every stored check passing on main: an
   * earlier task may have delivered this one's work. All suites pass on main: completed as already
   * delivered. The task's own checks pass but main's environment test or an earlier task's check
   * fails there (ADR-074 addendum 2 d68 a): nothing was delivered and no model ran, so this is not
   * the task's failure: null, and the task goes to its implementer as usual, the post-merge
   * regression suite judging the result. Its own checks failing in this run, after passing in the
   * red run just before, fails the task as before: they do not decide its work either way.
   */
  private async deliveredBeforeModel(d: Dispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const onMain = await this.mainSuitesRun(d, stored, NO_AGENT);
    if (onMain.kind === "blocked") return onMain.result;
    if (onMain.verdict.passed) return this.alreadyDelivered(d, onMain.main, stored, NO_AGENT);
    if (onMain.ownPassed) {
      console.log(
        `[${task.id}] its stored checks pass on main ${onMain.main}, but main's environment test or an earlier task's ` +
          `check fails there, so nothing is already delivered: dispatched to its implementer as usual\n${onMain.verdict.details}`,
      );
      return null;
    }

    const reason =
      `its stored checks pass on main before any implementer ran, but not on the run of every suite there, ` +
      `so its work is not already delivered:\n${onMain.verdict.details}`;
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
    await cleanupWorkdir(workDir, targetProjectPath);
    return {
      status: "failed",
      detail: reason,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "failed",
        summary: reason,
        chain: wrapError("development", "revalidateTaskChecks", reason, { taskId: task.id }),
      },
    };
  }

  /**
   * On a throwaway checkout of main itself, in a CI cell from the dispatch's environment image: the
   * environment's test, the latest checks of every Completed implementation task of the project (the
   * regression suite) and this task's own checks, each with its files written over the checkout.
   * `ownPassed` when every one of this task's own checks ran and passed, whatever the other suites
   * did. A run that could not run at all is environment-blocked, the workdir cleaned. `subject` is
   * the task whose checks `stored` are: the dispatch's own task, or the task a check task decides
   * (whose worktree the caller has already discarded, so it is not cleaned here).
   */
  private async mainSuitesRun(
    d: Dispatch,
    stored: TaskChecks,
    agent: AgentPart,
    subject: { readonly taskId: WorkItemId; readonly cleanWorkdir: boolean } = { taskId: d.task.id, cleanWorkdir: true },
  ): Promise<
    | { readonly kind: "blocked"; readonly result: ExecutionResult }
    | { readonly kind: "ran"; readonly main: string; readonly verdict: PostMergeVerdict; readonly ownPassed: boolean }
  > {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const subjectLabel = subject.taskId === task.id ? "this task's" : `task ${subject.taskId}'s`;
    let main: string;
    let suites: readonly CheckSuite[];
    let own: CheckSuite;
    let runs: readonly SuiteRun[];
    let earlier: readonly CompletedTaskChecks[];
    let unchecked: readonly string[];
    try {
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const environment = d.environment;
      main = await mainCommit(targetProjectPath, task.id);
      const completed = await this.deps.checks.completedOf(task.projectId, subject.taskId);
      earlier = completed.checked;
      unchecked = completed.unchecked;
      own = { label: `${subjectLabel} checks revision ${stored.revision} (check task ${stored.checkTaskId})`, checks: stored.checks, files: stored.files };
      suites = [
        { label: `the environment's test (version ${environment.version})`, checks: [{ name: "environment test", command: environment.definition.test }], files: [] },
        ...earlier.map((prior) => ({
          label: `earlier task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
          checks: prior.checks,
          files: prior.files,
        })),
        own,
      ];
      runs = await runSuitesOnCheckout(this.checkCells(d), RED_RUN_ROLE, environment.imageId, main, this.checkoutDir(d, "delivered-on-main"), suites);
      // A run that changed main's tracked files decided nothing about main: unrunnable, never a verdict.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit: main, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (subject.cleanWorkdir) await cleanupWorkdir(workDir, targetProjectPath);
      return { kind: "blocked", result: mainRunBlocked(task, sessionId, e, agent, eventSink, "deliveredCheckRun", "checks run on main") };
    }
    const ran = suitesVerdict(suites, runs, earlier.length, "main");
    const verdict: PostMergeVerdict =
      unchecked.length === 0
        ? ran
        : { passed: ran.passed, details: `${ran.details}\nNot re-run, no check is stored for them (completed before checks existed): ${unchecked.join(", ")}` };
    eventSink?.emit({
      event: "delivered_on_main_verify",
      taskId: task.id,
      attempt: task.attempt,
      verdict: verdict.passed ? "passed" : "failed",
      mainCommit: main,
      checkedTaskId: subject.taskId,
      revision: stored.revision,
      regressionTasks: earlier.map((prior) => prior.taskId),
      uncheckedTasks: unchecked,
      details: verdict.details,
    });
    const ownRun = runs.find((run) => run.suite === own);
    const ownPassed =
      ownRun !== undefined &&
      ownRun.report.kind === "ran" &&
      ownRun.report.runs.length === own.checks.length &&
      ownRun.report.runs.length > 0 &&
      ownRun.report.runs.every(checkPassed);
    return { kind: "ran", main, verdict, ownPassed };
  }

  /** Every suite passed on main: completed as already delivered at `main`, the task branch deleted, nothing merged. */
  private async alreadyDelivered(d: Dispatch, main: string, stored: TaskChecks, agent: AgentPart): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    await cleanupWorkdir(workDir, targetProjectPath, taskBranchName(task.id));
    console.log(`[${task.id}] already delivered: its checks, the environment's test and the regression suite pass on main ${main}; nothing merged`);
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "already_delivered" });
    return {
      status: "completed",
      delivered: { kind: "already-delivered", mainCommit: main },
      detail: `task already delivered on main at ${main}: its checks revision ${stored.revision} and every suite pass there; nothing merged`,
      outcome: agent.outcome,
      sessionId,
      attempt: task.attempt,
    };
  }

  /**
   * The acceptance sweep (story s-independent-verify-m1 W7, design P11): once every task of a
   * project's plan is settled with its goal tasks done, Z0 runs, on main HEAD in one CI cell from
   * main's environment image, the environment's test and the latest checks of every Completed
   * implementation task (the regression suite), each suite's files written over the checkout, with
   * no model called. Passed only when every suite ran every check and each passed, and every goal
   * task in `goalTaskIds` has checks stored: a goal never checked is not accepted on its word.
   * Completed tasks with no stored check are named apart (`uncheckedTasks`), never counted as
   * passed. A main with no environment its cells can be built from fails the sweep, with the
   * reason. A sweep that could not run is `unrunnable` only when the substrate failed (its probe, or
   * an EnvironmentError); any other error is `faulted`, with the step it stopped at. The caller
   * bounds both (orchestrator acceptance.ts).
   */
  async sweepForAcceptance(projectId: ProjectId, targetProjectPath: string, goalTaskIds: readonly string[]): Promise<AcceptanceSweep> {
    const label = `acceptance-${projectId}`;
    let step = "probe the substrate";
    let main: string | null = null;
    try {
      await this.deps.cells.substrate.probeSubstrate();
      step = "read main";
      main = await mainCommit(targetProjectPath, label);
      return await this.runAcceptanceSweep(projectId, targetProjectPath, goalTaskIds, main, (next) => {
        step = next;
      });
    } catch (e) {
      const substrate = environmentErrorOf(e);
      if (substrate !== null) return { kind: "unrunnable", error: substrate };
      return { kind: "faulted", mainCommit: main, error: new AcceptanceSweepFault(projectId, step, { cause: e }) };
    }
  }

  /** The sweep once the substrate answered and main was read; `at` names each step, for a fault. */
  private async runAcceptanceSweep(
    projectId: ProjectId,
    targetProjectPath: string,
    goalTaskIds: readonly string[],
    main: string,
    at: (step: string) => void,
  ): Promise<AcceptanceSweep> {
    const { cells, eventSink } = this.deps;
    const label = `acceptance-${projectId}`;
    at("resolve main's environment");
    const resolution = await resolveCurrentEnvironment(projectId, targetRepo(targetProjectPath), this.deps.environment.images, this.deps.environment.statements);
    if (resolution.kind === "undefined") {
      return {
        kind: "ran",
        passed: false,
        mainCommit: main,
        environmentVersion: null,
        checkedTasks: [],
        uncheckedTasks: [],
        details: `no environment its cells can be built from: ${resolution.reason}`,
      };
    }
    const environment: CurrentEnvironment = resolution.environment;
    at("read the stored checks of the completed tasks");
    const completed = await this.deps.checks.completedOf(projectId, null);
    const checkedIds = new Set(completed.checked.map((prior) => prior.taskId));
    const neverChecked = goalTaskIds.filter((id) => !checkedIds.has(id));
    const suites: CheckSuite[] = [
      { label: `the environment's test (version ${environment.version})`, checks: [{ name: "environment test", command: environment.definition.test }], files: [] },
      ...completed.checked.map((prior) => ({
        label: `task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
        checks: prior.checks,
        files: prior.files,
      })),
    ];
    at("run the suites on a checkout of main");
    const checkCells: CheckCells = {
      targetProjectPath,
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({ image, project: projectId, task: label, role, instance: cells.instance, mount: { hostPath, shared: true } }),
      teardownCell: (cell) => this.teardownCell(label, cell),
      timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
    };
    const dir = join(this.deps.config.workdirBase, "checkouts", `acceptance-${projectId}-${createSessionId()}`);
    const runs: readonly SuiteRun[] = await runSuitesOnCheckout(checkCells, RED_RUN_ROLE, environment.imageId, main, dir, suites);
    const ran = suitesVerdict(suites, runs, completed.checked.length, "main");
    const gaps = [
      ...(neverChecked.length === 0 ? [] : [`Goal task(s) with no stored checks, so never checked: ${neverChecked.join(", ")}`]),
      ...(completed.unchecked.length === 0 ? [] : [`Not re-run, no check is stored for them: ${completed.unchecked.join(", ")}`]),
    ];
    const passed = ran.passed && neverChecked.length === 0;
    const details = [ran.details, ...gaps].join("\n");
    const checkedTasks = completed.checked.map((prior) => prior.taskId);
    eventSink?.emit({
      event: "acceptance_sweep",
      projectId,
      mainCommit: main,
      verdict: passed ? "passed" : "failed",
      checkedTasks,
      neverChecked,
      details,
    });
    return {
      kind: "ran",
      passed,
      mainCommit: main,
      environmentVersion: environment.version,
      checkedTasks,
      uncheckedTasks: completed.unchecked,
      details,
    };
  }

  /** What an environment check of this dispatch reaches: its worktree, its project's images, and cells mounting a tree. */
  private environmentScope(d: Dispatch): EnvironmentCheckScope {
    const { cells } = this.deps;
    const { task } = d;
    return {
      projectId: task.projectId,
      taskId: task.id,
      workDir: d.workDir,
      repo: d.repo,
      targetProjectPath: d.targetProjectPath,
      checkoutDir: (purpose) => this.checkoutDir(d, purpose),
      images: this.deps.environment.images,
      // Shared label (`:z`): the task cell may still mount the same tree. Its `.git` is a throwaway
      // repository of the cell's own: the checkout's names host paths, and Z0's git reads that
      // repository after the cell ran.
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({
          image,
          project: task.projectId,
          task: task.id,
          role,
          instance: cells.instance,
          mount: { hostPath, shared: true },
        }),
      teardownCell: (cell) => this.teardownCell(task.id, cell),
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
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the conflict markers could not be read");
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
    return { status: "failed", detail: summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) } };
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
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the agent's work could not be committed");
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
      return { status: "failed", detail: envelope.summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: envelope };
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
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the task branch could not be compared with main");
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
   * Separation of duties (s-platform-role-m1, sprint0-run D5; ADR-074 addendum 2 d72 B1), before
   * the tentative merge: the task branch's changes since it left main may not touch the recipe of
   * main's environment (the platform role's) nor any stored check file of the project (the check
   * author's). Every other file is the product's, inputs the image build reads included: the
   * post-merge verification rebuilds the image when one changes. Only recipe files:
   * environment_change_requested with the implementer's need and the diff of those files; the task branch is deleted so the next dispatch starts fresh from main. Any check
   * file: failed with the paths and the rule, the branch kept. Nothing is merged either way. Z0's
   * own git failing blocks for the operator. Null when clean.
   */
  private async ownershipGate(d: Dispatch, outcome: Outcome): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const blockOn = (e: unknown, step: string): ExecutionResult => {
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure !== null) {
        return substrateBlocked(task, sessionId, "ownershipGate", environmentFailure, "host git", { outcome, agentWork: "kept" }, eventSink);
      }
      const fault = new VerificationInfrastructureFault(task.id, step, { cause: e });
      const chain = wrapError("development", "ownershipGate", fault, { taskId: task.id, errorClass: fault.name });
      return asharaBlocked(task, sessionId, "ownershipGate", fault, { outcome, agentWork: "kept" }, eventSink, chain);
    };
    let verdict: Awaited<ReturnType<typeof checkBranchOwnership>>;
    try {
      // Fail closed: a task dispatched without an environment has no recipe to fence and no
      // rebuild to accept an input change against.
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const checkFiles = await this.deps.checks.checkFilesOf(task.projectId);
      verdict = await checkBranchOwnership(targetProjectPath, task.id, taskBranchName(task.id), recipePaths(d.environment.definition), checkFiles);
    } catch (e) {
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the ownership gate could not run");
      return blockOn(e, "ownership gate");
    }
    eventSink?.emit({ event: "ownership_gate", taskId: task.id, attempt: task.attempt, verdict: verdict.kind });
    if (verdict.kind === "clean") return null;

    await cleanupWorkdir(workDir, targetProjectPath);
    const summary = `ownership gate refused the work of ${task.id}: ${verdict.reason}`;
    if (verdict.kind === "environment_change") {
      // The branch holds work made on the environment that is about to change: the next dispatch
      // starts again from main, which then carries the environment task's change.
      try {
        await discardTaskBranch(targetProjectPath, task.id);
      } catch (e) {
        return blockOn(e, "discard the task branch for an environment change");
      }
      const need = attemptSummary(outcome).trim() === "" ? "(the implementer's finish summary is empty: it stated no need)" : attemptSummary(outcome);
      const chain = wrapError("development", "ownershipGate", verdict.reason, { taskId: task.id, environmentPaths: verdict.paths });
      console.warn(`[${task.id}] ${summary}`);
      eventSink?.emit({ event: "environment_change_requested", taskId: task.id, attempt: task.attempt, paths: verdict.paths, reason: summary });
      return {
        status: "environment_change_requested",
        paths: verdict.paths,
        need,
        diff: verdict.diff,
        detail: summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: { outcome: "blocked", summary, chain, agentOutput: outcomeRecord(outcome) },
      };
    }
    const chain = wrapError("development", "ownershipGate", verdict.reason, {
      taskId: task.id,
      checkPaths: verdict.checkPaths,
      recipePaths: verdict.recipePaths,
    });
    eventSink?.emit({ event: "gate_failed", taskId: task.id, attempt: task.attempt, reason: summary });
    return {
      status: "failed",
      detail: summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) },
    };
  }

  /**
   * The Sprint 0 gate (task_spec.checkedBy "substrate"), in place of per-task verify: on the agent's
   * work as committed to the task branch (commitWork), its environment definition must parse, its image
   * build and its `test` pass in a fresh CI cell. A failed gate is a task failure (the definition
   * is the environment role's work), never environment_unavailable; a substrate that cannot run
   * the gate blocks the task. On a pass the finish statement (the stack statement only, never the
   * summary) is kept on the work item; a done without one fails the task before the gate runs.
   */
  private async substrateGate(d: Dispatch, statement: string | null, outcome: Outcome): Promise<SubstrateGateOutcome> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const fail = (summary: string, chain: ReturnType<typeof wrapError>): SubstrateGateOutcome => ({
      kind: "ended",
      result: { status: "failed", detail: summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) } },
    });
    if (statement === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const summary = `substrate gate failed for ${task.id}: the attempt finished done without a stack statement (finish's statement field)`;
      return fail(summary, wrapError("development", "substrateGate", summary, { taskId: task.id }));
    }
    eventSink?.emit({ event: "substrate_gate_started", taskId: task.id, attempt: task.attempt, workDir });

    let run: SubstrateGateRun;
    try {
      run = await runSubstrateGate(this.environmentScope(d), attemptPolicy.perCommandTimeoutSeconds);
    } catch (e) {
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the substrate gate could not run");
      const fault = environmentErrorOf(e) ?? new VerificationInfrastructureFault(task.id, "substrate gate run", { cause: e });
      return { kind: "ended", result: thrownBlocked(task, sessionId, "substrateGate", fault, { step: "substrate gate run", cell: "CI cell" }, { outcome, agentWork: "kept" }, eventSink) };
    }

    const passed = environmentCheckPassed(run.report);
    const gateOutput = formatEnvironmentCheck(run.report);
    eventSink?.emit({ event: "substrate_gate_result", taskId: task.id, attempt: task.attempt, passed, report: run.report.kind, output: gateOutput });
    if (!passed || run.tested === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "substrateGate", gateOutput, { taskId: task.id, report: run.report.kind });
      return fail(`substrate gate failed for ${task.id}:\n${gateOutput}`, chain);
    }

    try {
      await this.deps.environment.statements.record(task.id, statement, run.tested.version);
    } catch (e) {
      // The gate passed; only Z0's store failed to keep its statement, as recordRebuiltStatement's write.
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the stack statement could not be recorded");
      const fault = new VerificationInfrastructureFault(task.id, `record the environment statement for version ${run.tested.version}`, { cause: e });
      return { kind: "ended", result: asharaBlocked(task, sessionId, "substrateGate", fault, { outcome, agentWork: "kept" }, eventSink) };
    }
    return { kind: "passed", tested: run.tested };
  }

  /**
   * An environment task's post-merge check: the gate's run again, the definition's `probe` from the
   * gate's image, on a throwaway checkout of the tentative merge. Sprint 0's merge holds no product,
   * so it runs nothing else (ADR-074 addendum 2 d72 S), nor does an environment change opened with
   * product "absent" (the product scaffold asked before any scaffold completed; its own merge runs
   * them). Any other environment change lands on a product: after the probe, the product's `build`
   * then `test` run on the merge from the same image and must leave the checkout clean.
   */
  private async postMergeEnvironmentTest(d: Dispatch, targetProjectPath: string, tested: TestedEnvironment, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const commit = await tentativeMergeCommit(targetProjectPath, d.task.id);
    const scope = this.environmentScope(d);
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(cellRunBoundMs([timeoutSeconds]), "the post-merge probe cell");
    const probe = await runPostMergeProbe(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
    let passed = environmentProbePassed(probe);
    let details = formatEnvironmentProbe(probe);
    const noProduct = d.task.taskSpec?.origin === "sprint0" || d.task.taskSpec?.product === "absent";
    if (passed && !noProduct) {
      lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
      const commands = await runPostMergeEnvironmentCommands(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
      passed = environmentCommandsPassed(commands);
      details = `${details}\nThe product's build and test on the merge:\n${formatEnvironmentCommands(commands)}`;
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: d.task.id, attempt: d.task.attempt, verdict: passed ? "passed" : "failed", details });
    return { passed, details };
  }

  /**
   * The product scaffold's post-merge check (ADR-074 addendum 2 d72 B2): the environment of the
   * tentative merge (mergedEnvironment: rebuilt when the scaffold wrote an input the recipe reads),
   * then the definition's `build` then `test` on a throwaway checkout of the merge in a verifier
   * cell from that image, which must pass and leave the checkout clean. A rebuilt version passing
   * records the dispatch's statement for it. A substrate failure throws.
   */
  private async postMergeScaffold(d: Dispatch, targetProjectPath: string, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let verdict: PostMergeVerdict;
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        verdict = { passed: false, details: merged.details };
      } else if (merged.kind === "rebuilt") {
        verdict = { passed: true, details: merged.details };
      } else {
        const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
        lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
        const commands = await runPostMergeEnvironmentCommands(
          this.environmentScope(d),
          POST_MERGE_VERIFIER_ROLE,
          { version: merged.version, imageRef: merged.imageRef, definition: merged.definition },
          commit,
          this.deps.attemptPolicy.perCommandTimeoutSeconds,
        );
        verdict = {
          passed: environmentCommandsPassed(commands),
          details: `the product's build and test (environment version ${merged.version}) on the merge:\n${formatEnvironmentCommands(commands)}`,
        };
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "product scaffold build and test", { cause: e });
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: verdict.passed ? "passed" : "failed", details: verdict.details });
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /** The version a verified merge produced carries the statement of the stack it was built from. */
  private async recordRebuiltStatement(taskId: WorkItemId, merged: Extract<MergedEnvironment, { readonly kind: "rebuilt" }>): Promise<void> {
    try {
      await this.deps.environment.statements.record(taskId, merged.statement, merged.version);
    } catch (e) {
      throw new VerificationInfrastructureFault(taskId, `record the environment statement for rebuilt version ${merged.version}`, { cause: e });
    }
  }

  /**
   * Every other task's post-merge check (s-independent-verify-m1, ADR-074 addendum 2 d64 d, d72 B3).
   * First the merge's own environment (mergedEnvironment): when the work changed an input the
   * recipe reads, the merge's version is rebuilt and the product's build and test must pass on it,
   * and that version's image and test replace the dispatch's below; the merge passing records the
   * dispatch's statement for that version. Then, in one verifier cell from that image on a
   * throwaway checkout of the tentative merge, in order:
   * the environment definition's `test`; the latest stored checks of every implementation task of
   * the project already Completed, each with its files written over the checkout; then this task's
   * own stored checks with theirs, so whatever the implementer put at those paths is replaced and it
   * cannot grade itself. An earlier task's checks are not red-run again on this environment: they
   * are regression checks and must pass on the merge whatever version they were red-run on. Every
   * check must exit 0 with output; any failure fails this task naming the suite and the check, and
   * an earlier task's check that fails is this task's regression. Sequential, each check bounded by
   * the per-command timeout: the run takes at most (1 + every check counted) x that timeout, plus
   * the cell's start and teardown, plus, for a rebuilt environment, its image build (bounded by the
   * builder) and its build and test (2 x that timeout). A substrate failure throws, which finalize turns into an
   * environment block.
   */
  private async postMergeStoredChecks(d: Dispatch, targetProjectPath: string, stored: TaskChecks, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let runs: readonly SuiteRun[];
    let suites: readonly CheckSuite[];
    let earlier: readonly CompletedTaskChecks[];
    let unchecked: readonly string[];
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") {
        throw new PostMergeEnvironmentMissing(task.id);
      }
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: "failed", revision: stored.revision, details: merged.details });
        return { passed: false, details: merged.details };
      }
      const completed = await this.deps.checks.completedOf(task.projectId, task.id);
      earlier = completed.checked;
      unchecked = completed.unchecked;
      suites = [
        { label: `the environment's test (version ${merged.version})`, checks: [{ name: "environment test", command: merged.definition.test }], files: [] },
        ...earlier.map((prior) => ({
          label: `earlier task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
          checks: prior.checks,
          files: prior.files,
        })),
        { label: `this task's checks revision ${stored.revision} (check task ${stored.checkTaskId})`, checks: stored.checks, files: stored.files },
      ];
      const checks = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
      const perCheck = this.deps.attemptPolicy.perCommandTimeoutSeconds;
      lease.extend(cellRunBoundMs(Array.from({ length: checks }, () => perCheck)), `the post-merge cell of ${checks} check(s)`);
      runs = await runSuitesOnCheckout(
        this.checkCells(d),
        POST_MERGE_VERIFIER_ROLE,
        merged.image,
        commit,
        this.checkoutDir(d, "post-merge-checks"),
        suites,
      );
      // A run that changed the merge's tracked files is no verdict on the merge (L9): unrunnable,
      // carried out typed in the fault's cause, neither a pass nor the task's failure.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        this.deps.eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "stored-check run", { cause: e });
    }
    const checkCount = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
    const suitesVerdictRun = suitesVerdict(suites, runs, earlier.length, "merge");
    const suitesRun: PostMergeVerdict =
      merged.kind === "rebuilt"
        ? { passed: suitesVerdictRun.passed, details: `${merged.details}\n${suitesVerdictRun.details}` }
        : suitesVerdictRun;
    // A task completed with no stored check has nothing to re-run: skipping it is stated, never
    // silent, and never a block (no transition could ever give a Completed task checks, so every
    // later merge of the project would block on it with no exit).
    const verdict: PostMergeVerdict =
      unchecked.length === 0
        ? suitesRun
        : {
            passed: suitesRun.passed,
            details: `${suitesRun.details}\nNot re-run, no check is stored for them (completed before checks existed): ${unchecked.join(", ")}`,
          };
    if (unchecked.length > 0) {
      console.warn(`[${task.id}] post-merge regression suite skips Completed task(s) with no stored check: ${unchecked.join(", ")}`);
    }
    this.deps.eventSink?.emit({
      event: "post_merge_verify",
      taskId: task.id,
      attempt: task.attempt,
      verdict: verdict.passed ? "passed" : "failed",
      revision: stored.revision,
      regressionTasks: earlier.map((prior) => prior.taskId),
      uncheckedTasks: unchecked,
      boundSeconds: checkCount * this.deps.attemptPolicy.perCommandTimeoutSeconds,
      details: verdict.details,
    });
    // The version this merge produces is the stack the team stated, with inputs a verified merge
    // changed: it carries that statement, so the next dispatch resolves it (current-environment.ts).
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /**
   * The environment of the tentative merge `commit` (ADR-074 addendum 2 d72 B3): its definition and
   * version read from the merge's committed objects, the version being the digest of the build
   * context (environmentVersion, the same function the image build uses). The same version as the
   * dispatch's: its image. Another one (the work changed an input the recipe reads): its image is
   * built and recorded, and the product's `build` then `test` run on a fresh checkout of the merge
   * in a verifier cell from it, which must pass and leave the checkout clean; the caller then runs
   * the stored checks on that image. A definition the merge leaves unreadable, an image that cannot
   * be built and a failed build or test refuse the merge with what failed, the task's failure. A
   * substrate failure throws.
   */
  private async mergedEnvironment(d: Dispatch, current: CurrentEnvironment, commit: string, lease: CheckoutLease): Promise<MergedEnvironment> {
    const { task } = d;
    const gitDir = targetRepo(d.targetProjectPath).gitDir;
    const refused = (details: string): MergedEnvironment => ({ kind: "refused", details });
    let definition: EnvironmentDefinition;
    let version: string;
    try {
      definition = await readEnvironmentDefinition(gitDir, commit);
      version = (await environmentVersion(gitDir, commit, definition)).version;
    } catch (e) {
      if (e instanceof EnvironmentDefinitionInvalid || e instanceof EnvironmentVersionUnresolved) {
        return refused(`The merge leaves no environment that can be built (it was version ${current.version}): ${e.message}`);
      }
      throw e;
    }
    if (version === current.version) {
      return { kind: "unchanged", version, image: current.imageId, imageRef: current.imageRef, definition: current.definition };
    }

    const change = `The merge changes the environment's build context (its inputs): version ${current.version} becomes ${version}`;
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(ENVIRONMENT_BUILD_TIMEOUT_MS + cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the merge's environment rebuild and its build and test cell");
    let built: BuiltEnvironment;
    try {
      built = await this.deps.environment.images.build({ projectId: task.projectId, repoGitDir: gitDir, commit, definition });
    } catch (e) {
      if (e instanceof EnvironmentBuildFailed) {
        return refused(
          `${change}, and its image could not be built: ${e.detail}\nBuild log:\n${renderElided(e.log).trim() || "(empty)"}`,
        );
      }
      if (e instanceof EnvironmentVersionUnresolved) return refused(`${change}, and it cannot be built: ${e.message}`);
      throw e;
    }
    if (built.version !== version) {
      throw new VerificationInfrastructureFault(task.id, "rebuild the merge's environment", {
        cause: `version ${version} was resolved at ${commit}, but the image was built for ${built.version}`,
      });
    }
    this.deps.eventSink?.emit({
      event: "environment_rebuilt",
      taskId: task.id,
      attempt: task.attempt,
      from: current.version,
      to: version,
      imageId: built.imageId,
      imageRef: built.imageRef,
      reused: built.reused,
    });
    const commands = await runPostMergeEnvironmentCommands(
      this.environmentScope(d),
      POST_MERGE_VERIFIER_ROLE,
      { version, imageRef: built.imageRef, definition },
      commit,
      this.deps.attemptPolicy.perCommandTimeoutSeconds,
    );
    const ran = `the product's build and test on the rebuilt environment (version ${version}) on the merge:\n${formatEnvironmentCommands(commands)}`;
    if (!environmentCommandsPassed(commands)) return refused(`${change}, and ${ran}`);
    return {
      kind: "rebuilt",
      version,
      image: built.imageId,
      imageRef: built.imageRef,
      definition,
      statement: current.statement,
      details: `${change}; ${ran}`,
    };
  }

  /**
   * run_checks' port: the stored checks, with their stored files written over a throwaway checkout
   * of a snapshot of the implementer's current worktree, run in a fresh CI cell from the dispatch's
   * image. The implementer's worktree itself is never written. A substrate failure throws as it
   * is; a failure of Z0's own machinery (the snapshot commit, the checkout) throws as a
   * VerificationInfrastructureFault. Either ends the attempt as its environment failing, and
   * endWithoutDone names which.
   */
  private taskCheckRunPort(d: Dispatch, stored: TaskChecks, merged: readonly CompletedTaskChecks[]): TaskCheckRunPort {
    let runs = 0;
    return {
      checkNames: stored.checks.map((check) => check.name),
      mergedChecks: merged.flatMap((prior) => prior.checks.map((check) => ({ taskId: prior.taskId, name: check.name }))),
      run: async (timeoutSeconds) => {
        runs += 1;
        let report: CheckRunReport;
        try {
          const commit = await worktreeSnapshotCommit(d.repo, d.task.id, "run_checks");
          report = await runChecksOnCheckout(
            { ...this.checkCells(d), timeoutSeconds },
            RED_RUN_ROLE,
            cellImageOf(d.environment),
            commit,
            this.checkoutDir(d, `run-checks-${runs}`),
            stored.checks,
            stored.files,
          );
        } catch (e) {
          if (environmentErrorOf(e) !== null) throw e;
          throw new VerificationInfrastructureFault(d.task.id, "run_checks", { cause: e });
        }
        this.deps.eventSink?.emit({
          event: "task_checks_run",
          taskId: d.task.id,
          attempt: d.task.attempt,
          run: runs,
          revision: stored.revision,
          ...(report.kind === "ran"
            ? { passed: report.runs.filter(checkPassed).map((run) => run.name) }
            : report.kind === "files_refused"
              ? { refused: report.detail }
              : { productChanged: describeProductChange(report) }),
        });
        return report;
      },
    };
  }

  /**
   * Before a check author's model is called (W11 D2): the environment's `build` from this dispatch's
   * image on a fresh checkout of the plan's foundation, as the merge gate builds before it runs
   * anything. Passing: null, and every red run of the attempt (define_check's and the one at
   * finish) is on a foundation that builds, so a check failing there fails for its own reason. Failing:
   * the red run is unrunnable, never accepted. A re-dispatch would meet the same foundation in the
   * same environment, so the task is not failed: it ends `environment_undefined`, which gives it up
   * for a plan repair with the build as evidence. A build that could not run at all is environment-blocked.
   */
  private async foundationBuildGate(d: Dispatch, work: CheckAuthoring): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, sessionId, targetProjectPath } = d;
    let build: EnvironmentTestRun;
    try {
      build = await runFoundationBuild(
        this.environmentScope(d),
        RED_RUN_ROLE,
        work.environment.imageId,
        work.foundation.commit,
        work.environment.definition,
        this.deps.attemptPolicy.perCommandTimeoutSeconds,
      );
    } catch (e) {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
      return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "build on the foundation");
    }
    const passed = environmentBuildPassed(build);
    eventSink?.emit({
      event: "foundation_build",
      taskId: task.id,
      attempt: task.attempt,
      foundationTaskId: work.foundation.taskId,
      baselineCommit: work.foundation.commit,
      environmentVersion: work.environment.version,
      exitCode: build.exitCode,
      timedOut: build.timedOut,
      passed,
      ...(passed ? {} : { build: describeFoundationBuild(build) }),
    });
    if (passed) return null;

    await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
    const unbuildable = new FoundationUnbuildable(task.id, work.foundation.taskId, work.environment.version, build);
    const summary = `no check of task ${task.id} can be red-run: ${unbuildable.message}; no agent ran`;
    console.warn(`[${task.id}] ${summary}`);
    eventSink?.emit({ event: "task_blocked", taskId: task.id, attempt: task.attempt, stage: "foundationBuild", errorClass: unbuildable.name, reason: summary });
    return {
      status: "environment_undefined",
      reason: unbuildable.message,
      detail: summary,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "blocked",
        summary,
        chain: wrapError("development", "foundationBuild", unbuildable, {
          taskId: task.id,
          foundationTaskId: work.foundation.taskId,
          environmentVersion: work.environment.version,
          exitCode: build.exitCode,
          timedOut: build.timedOut,
        }),
      },
    };
  }

  /**
   * define_check's port (ADR-074 addendum 2 d65 a): records the definition, the last of a name
   * winning, then red-runs that one check at once by the harvest's own machinery: the files the
   * attempt has changed so far (a snapshot of its throwaway worktree, by the harvest's rules) are
   * written over a fresh checkout of the plan's foundation (ADR-074 addendum 2 d74 A), and the check
   * runs in a CI cell from the environment image. The author is shown its exit code and output and
   * whether the red run at finish would reject it; that red run still decides, unchanged. A
   * substrate failure throws as it is; a failure of Z0's own machinery throws as a
   * VerificationInfrastructureFault.
   */
  private checkDefinitionPort(d: Dispatch, work: CheckAuthoring): CheckDefinitionPort {
    let runs = 0;
    // One command on a fresh checkout of the foundation with the attempt's check files so far over
    // it, by the harvest's own rules: define_check's red run and probe_foundation's look alike.
    const onFoundation = async (
      check: CheckDefinition,
      timeoutSeconds: number,
      purpose: "define-check" | "probe-foundation",
    ): Promise<{ readonly report: CheckRunReport; readonly dir: string; readonly discarded: readonly string[] }> => {
      runs += 1;
      const dir = this.checkoutDir(d, `${purpose}-${runs}`);
      try {
        const harvest = await previewCheckFiles(
          d.repo,
          d.task.id,
          work.startCommit,
          buildContextPaths(work.environment.definition),
          work.recorder.writtenFiles(),
          checkAreaOf(work.checkedTaskId),
        );
        if (harvest.kind === "rejected") return { report: { kind: "files_refused", detail: harvest.reason }, dir, discarded: [] };
        const report = await runChecksOnCheckout(
          { ...this.checkCells(d), timeoutSeconds },
          RED_RUN_ROLE,
          work.environment.imageId,
          work.foundation.commit,
          dir,
          [check],
          harvest.files,
        );
        return { report, dir, discarded: harvest.discarded };
      } catch (e) {
        if (environmentErrorOf(e) !== null) throw e;
        throw new VerificationInfrastructureFault(d.task.id, purpose === "define-check" ? "define_check red run" : "probe_foundation run", { cause: e });
      }
    };
    return {
      fileWritten: (path) => work.recorder.fileWritten(path),
      probe: async (command, timeoutSeconds): Promise<FoundationProbe> => {
        const { report, dir } = await onFoundation({ name: "probe", command }, timeoutSeconds, "probe-foundation");
        this.deps.eventSink?.emit({
          event: "foundation_probed",
          taskId: d.task.id,
          attempt: d.task.attempt,
          command,
          ...(report.kind === "ran"
            ? { exitCode: report.runs[0]?.exitCode ?? null, timedOut: report.runs[0]?.timedOut ?? false }
            : { notRun: report.kind }),
        });
        return foundationProbeOf(report, timeoutSeconds, dir);
      },
      define: async (check, timeoutSeconds) => {
        const recording = work.recorder.record(check);
        if (recording.kind === "refused") return recording;
        const { report, dir, discarded } = await onFoundation(check, timeoutSeconds, "define-check");
        const redRun: CheckRedRunPreview = redRunPreview(report, timeoutSeconds, dir);
        this.deps.eventSink?.emit({
          event: "check_defined",
          taskId: d.task.id,
          attempt: d.task.attempt,
          name: check.name,
          command: check.command,
          replaced: recording.replaced,
          defined: recording.defined,
          ...(redRun.kind === "ran"
            ? { exitCode: redRun.run.exitCode, timedOut: redRun.run.timedOut, rejection: redRun.rejection }
            : redRun.kind === "files_refused"
              ? { filesRefused: redRun.detail }
              : { productChanged: redRun.detail }),
          ...(discarded.length > 0 ? { discarded } : {}),
        });
        return { ...recording, redRun, discarded };
      },
    };
  }

  /**
   * The delivered sweep, before every dispatch of an implementation task and before any model is
   * called (ADR-074 addendum 2 d74 A), once revalidateOnBaseline has trusted them: the task's stored
   * checks run on main in a CI cell from this dispatch's image. Every one passing: the task's work may be on main already, whoever delivered
   * it, and deliveredBeforeModel decides it by the environment's test, the regression suite and those
   * checks on main (d67 b, d68 a). Any failing: null, and the dispatch goes on; partial progress is
   * not staleness. A run that could not run at all is environment-blocked.
   */
  private async sweepDelivered(d: Dispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, sessionId, workDir, targetProjectPath } = d;
    let onMain: CheckRunReport;
    let main: string;
    try {
      main = await mainCommit(targetProjectPath, task.id);
      onMain = await runChecksOnCheckout(
        this.checkCells(d),
        RED_RUN_ROLE,
        cellImageOf(d.environment),
        main,
        this.checkoutDir(d, "delivered-sweep"),
        stored.checks,
        stored.files,
      );
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "deliveredCheckRun", "delivered sweep on main");
    }
    const passed = onMain.kind === "ran" ? onMain.runs.filter(checkPassed).map((run) => run.name) : [];
    const allPass = onMain.kind === "ran" && onMain.runs.length === stored.checks.length && passed.length === stored.checks.length;
    eventSink?.emit({
      event: "delivered_sweep",
      taskId: task.id,
      attempt: task.attempt,
      mainCommit: main,
      revision: stored.revision,
      passed,
      allPass,
      ...(onMain.kind === "files_refused" ? { filesRefused: onMain.detail } : {}),
      ...(onMain.kind === "product_changed" ? { productChanged: describeProductChange(onMain) } : {}),
    });
    if (onMain.kind === "product_changed") {
      console.warn(`[${task.id}] the delivered sweep on main ${main} reached no verdict: ${describeProductChange(onMain)}`);
    }
    return allPass ? this.deliveredBeforeModel(d, stored) : null;
  }

  /**
   * Stored checks were red-run on their baseline in their check task's environment version. On a
   * dispatch from another version they are red-run again on that baseline in a CI cell from this
   * dispatch's image, by the same set rule (ADR-074 addendum 2 d74 A): every check runs to a verdict
   * and at least one fails decisively. Holding: trusted, null. Not holding, or no baseline on record
   * (a revision stored before migration 045): checks_stale before the model is called, naming both
   * versions and the check task, since such a set cannot tell the task's work from its absence and
   * the implementer could not answer for it. A red run that could not run at all is environment-blocked.
   */
  private async revalidateOnBaseline(d: Dispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, sessionId, workDir, targetProjectPath } = d;
    const current = sessionEnvironmentVersion(d.environment);
    if (current === stored.environmentVersion) return null;

    let problem: string | null;
    if (stored.baselineCommit === null) {
      problem = `revision ${stored.revision} records no baseline commit (it was stored before baselines were recorded), so it cannot be red-run again`;
    } else {
      // As at authoring (W11 D2): on a baseline the environment no longer builds, every check fails
      // for that reason alone, which is no evidence the set still tells the task's work from its absence.
      // The BaseCell (Sprint 0's cells only) defines no build: its run is the red run alone, as before.
      let build: EnvironmentTestRun | null = null;
      if (d.environment.kind === "environment") {
        try {
          build = await runFoundationBuild(
            this.environmentScope(d),
            RED_RUN_ROLE,
            d.environment.imageId,
            stored.baselineCommit,
            d.environment.definition,
            this.deps.attemptPolicy.perCommandTimeoutSeconds,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "build on the baseline");
        }
      }
      let redRun: CheckRunReport | { readonly kind: "unbuilt"; readonly build: EnvironmentTestRun };
      if (build !== null && !environmentBuildPassed(build)) {
        redRun = { kind: "unbuilt", build };
      } else {
        try {
          redRun = await runChecksOnCheckout(
            this.checkCells(d),
            RED_RUN_ROLE,
            cellImageOf(d.environment),
            stored.baselineCommit,
            this.checkoutDir(d, "red-run"),
            stored.checks,
            stored.files,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "red run on the baseline");
        }
      }
      if (redRun.kind === "unbuilt") {
        problem = `the environment's build fails on the baseline, so no check there can be red-run: ${describeFoundationBuild(redRun.build)}`;
      } else if (redRun.kind === "files_refused") {
        problem = `the check files cannot be placed on the baseline: ${redRun.detail}`;
      } else if (redRun.kind === "product_changed") {
        problem = `on the baseline, ${describeProductChange(redRun)}`;
      } else {
        const setProblem = redRunSetProblem(redRun.runs);
        problem =
          redRun.runs.some((run) => redRunProblem(run) !== null) || setProblem !== null
            ? `${formatCheckRuns(redRun.runs, redRunVerdict)}${setProblem === null ? "" : `\nREJECTED, the set: ${setProblem}`}`
            : null;
      }
    }
    eventSink?.emit({
      event: "checks_revalidated",
      taskId: task.id,
      attempt: task.attempt,
      revision: stored.revision,
      storedVersion: stored.environmentVersion,
      currentVersion: current,
      baselineCommit: stored.baselineCommit,
      trusted: problem === null,
    });
    if (problem === null) return null;

    await cleanupWorkdir(workDir, targetProjectPath);
    const stale = new StoredChecksStale(task.id, stored, current, problem);
    console.warn(`[${task.id}] ${stale.message}`);
    eventSink?.emit({ event: "task_blocked", taskId: task.id, attempt: task.attempt, stage: "revalidateTaskChecks", errorClass: stale.name, reason: stale.message });
    return {
      status: "checks_stale",
      checkTaskId: stored.checkTaskId,
      revision: stored.revision,
      detail: stale.message,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "blocked",
        summary: stale.message,
        chain: wrapError("development", "revalidateTaskChecks", stale, {
          taskId: task.id,
          checkTaskId: stored.checkTaskId,
          revision: stored.revision,
          storedVersion: stored.environmentVersion,
          currentVersion: current,
          baselineCommit: stored.baselineCommit,
        }),
      },
    };
  }

  /** A check task's work that cannot be kept: failed with the reason, nothing stored, nothing merged. */
  private checksRejected(
    d: Dispatch,
    outcome: Outcome,
    reason: string,
    // open-by-design: what the operator needs beyond the author's reason, per rejection
    operator: Record<string, unknown>,
  ): ExecutionResult {
    const { task, sessionId } = d;
    // The summary and the chain, its context included, become the next check attempt's brief
    // (formatPriorAttemptFailure renders the chain verbatim), so neither names a commit the cell
    // cannot reach (eighth run E5); `operator`, the foundation's commit among it, goes only to the event.
    const summary = `the checks of check task ${task.id} were rejected: ${reason}`;
    this.deps.eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: summary, ...operator });
    const chain = wrapError("development", "keepChecks", reason, { taskId: task.id });
    return {
      status: "failed",
      detail: summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) },
    };
  }

  /**
   * Harvests a finished check attempt: its defined checks and the files it added or changed, then
   * the red run on a fresh checkout of the plan's foundation in a CI cell from the environment
   * image (ADR-074 addendum 2 d74 A), whatever authoring this is: the first, or one after a dispute,
   * a review or staleness. A check that times out or whose command cannot run rejects the whole
   * set; a check that passes there is kept as a guard of behaviour that already holds; the set is
   * kept only when at least one of its checks fails there decisively. The kept revision is appended
   * to Quality's task_checks for the implementation task with the foundation as its baseline; the
   * throwaway branch is discarded either way.
   */
  private async keepChecks(d: Dispatch, work: CheckAuthoring, outcome: Outcome): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, sessionId, targetProjectPath } = d;
    const { foundation } = work;
    try {
      const defined = work.recorder.checks();
      if (defined.length === 0) return this.checksRejected(d, outcome, "no check was defined with define_check", {});
      const harvest = await harvestCheckFiles(
        d.repo,
        task.id,
        work.startCommit,
        buildContextPaths(work.environment.definition),
        work.recorder.writtenFiles(),
        checkAreaOf(work.checkedTaskId),
      );
      if (harvest.kind === "rejected") return this.checksRejected(d, outcome, harvest.reason, {});
      if (harvest.discarded.length > 0) {
        eventSink?.emit({ event: "check_files_discarded", taskId: task.id, attempt: task.attempt, area: checkAreaOf(work.checkedTaskId), paths: harvest.discarded });
      }

      let redRun: CheckRunReport;
      try {
        redRun = await runChecksOnCheckout(
          this.checkCells(d),
          RED_RUN_ROLE,
          work.environment.imageId,
          foundation.commit,
          this.checkoutDir(d, "red-run"),
          defined,
          harvest.files,
        );
      } catch (e) {
        return mainRunBlocked(task, sessionId, e, { outcome, agentWork: "discarded" }, eventSink, "checkRedRun", "red run on the foundation");
      }
      const atFoundation = { baselineCommit: foundation.commit, foundationTaskId: foundation.taskId };
      if (redRun.kind === "files_refused") {
        return this.checksRejected(
          d,
          outcome,
          `the check files cannot be placed on the foundation (the merge of task ${foundation.taskId}): ${redRun.detail}`,
          atFoundation,
        );
      }
      if (redRun.kind === "product_changed") {
        return this.checksRejected(
          d,
          outcome,
          `red run on the foundation (the merge of task ${foundation.taskId}): ${describeProductChange(redRun)}`,
          atFoundation,
        );
      }
      const runsReport = formatCheckRuns(redRun.runs, redRunVerdict);
      const problems = redRun.runs.filter((run) => redRunProblem(run) !== null);
      const setProblem = redRunSetProblem(redRun.runs);
      const report = setProblem === null ? runsReport : `${runsReport}\nREJECTED, the set: ${setProblem}`;
      eventSink?.emit({
        event: "check_red_run",
        taskId: task.id,
        attempt: task.attempt,
        baselineCommit: foundation.commit,
        foundationTaskId: foundation.taskId,
        rejected: problems.map((run) => run.name),
        holdsAlready: redRun.runs.filter((run) => run.exitCode === 0 && redRunProblem(run) === null).map((run) => run.name),
        setRejected: setProblem !== null,
        report,
      });
      if (problems.length > 0 || setProblem !== null) {
        return this.checksRejected(d, outcome, `red run on the foundation (the merge of task ${foundation.taskId}):\n${report}`, atFoundation);
      }

      const revision = await this.deps.checks.append({
        projectId: task.projectId,
        taskId: work.checkedTaskId,
        checkTaskId: task.id,
        environmentVersion: work.environment.version,
        baselineCommit: foundation.commit,
        checks: defined,
        files: harvest.files,
      });
      eventSink?.emit({
        event: "task_checks_recorded",
        taskId: task.id,
        checkedTaskId: work.checkedTaskId,
        revision,
        baselineCommit: foundation.commit,
        checks: defined.map((check) => check.name),
        files: harvest.files.map((file) => file.path),
      });
      eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "completed" });
      return {
        status: "completed",
        delivered: { kind: "checks-recorded", revision },
        detail:
          `${defined.length} check(s) recorded as revision ${revision} for task ${work.checkedTaskId}, red-run on the ` +
          `foundation ${foundation.commit}`,
        outcome,
        sessionId,
        attempt: task.attempt,
      };
    } finally {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
    }
  }

  /**
   * A check author that finished `blocked` (ADR-074 addendum 2 d74 A): its reason may be that the
   * task its checks decide is already on main. Z0 does not take that word for it: when the checked
   * task has stored checks, they run on main with the environment's test and the regression suite
   * (mainSuitesRun), the evaluation that closes delivered work. Every suite passing: the check task is
   * completed with no new revision, and the checked task's delivered sweep closes it before any
   * implementer is dispatched. Otherwise null: the blocked result stands, with what the evaluation
   * found. The check task's worktree is already discarded.
   */
  private async checkedTaskOnMain(d: Dispatch, work: CheckAuthoring, outcome: Outcome): Promise<ExecutionResult | { readonly kind: "not-delivered"; readonly why: string }> {
    const { task, sessionId } = d;
    if (work.prior === null) {
      return { kind: "not-delivered", why: `task ${work.checkedTaskId} has no stored checks to run on main, so nothing shows it is delivered` };
    }
    const checkedTaskId = parseWorkItemId(work.checkedTaskId, "CheckAuthoring.checkedTaskId");
    const onMain = await this.mainSuitesRun(d, work.prior, { outcome, agentWork: "discarded" }, { taskId: checkedTaskId, cleanWorkdir: false });
    if (onMain.kind === "blocked") return onMain.result;
    if (!onMain.verdict.passed) {
      return {
        kind: "not-delivered",
        why: `task ${work.checkedTaskId}'s checks revision ${work.prior.revision} and every suite do not all pass on main:\n${onMain.verdict.details}`,
      };
    }
    console.log(`[${task.id}] the check author finished blocked and task ${work.checkedTaskId} is delivered on main ${onMain.main}: its checks and every suite pass there`);
    this.deps.eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "checked_task_delivered" });
    return {
      status: "completed",
      delivered: { kind: "checked-task-delivered", checkedTaskId: work.checkedTaskId, mainCommit: onMain.main, revision: work.prior.revision },
      detail:
        `the check author finished blocked (${attemptSummary(outcome)}); task ${work.checkedTaskId}'s checks revision ` +
        `${work.prior.revision}, the environment's test and the regression suite all pass on main ${onMain.main}, so no ` +
        `new revision is written: its delivered sweep closes it`,
      outcome,
      sessionId,
      attempt: task.attempt,
    };
  }


  /**
   * Every terminal except finished(done): finished(blocked) is `blocked`; a cell that failed under
   * the attempt is environment-blocked (the operator's to fix); every other terminal is `failed`
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
      const evaluated = await this.checkedTaskOnMain(d, d.work, outcome);
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
        detail: envelope.summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: envelope,
      };
    }


    const cause = outcome.kind === "transport_exhausted" ? outcome.error : outcome.kind === "cancelled" ? outcome.reason : outcome.detail;
    const chain = wrapError("development", "agentAttempt", cause, context);
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: `attempt ended as ${outcome.kind} after ${outcome.turnsUsed} turn(s) on ${staff.model.provider}/${staff.model.modelId}: ${outcome.detail}`,
      chain,
      agentOutput: outcomeRecord(outcome),
    };
    return {
      status: "failed",
      detail: envelope.summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: envelope,
    };
  }
}

/**
 * Opens the dev_sessions row and OWNS its terminal write. Every exit from
 * `body` — every return, every throw — lands on a `complete` or a `fail`, so a
 * failure return added to runExecution later cannot leak a `Preparing` row the
 * way the six existing ones did: E2E Run 39 stranded 6 rows, which
 * `listActive()` then reported as live agents indefinitely. This is the ONLY
 * writer of a terminal phase — the success path used to write its own inside
 * finalizeSuccess, and that split is what made "success transitions, failure
 * does not" expressible at all.
 *
 * The terminal write itself is fail-SOFT: a DB error here must not un-complete a
 * task that already passed its gates. A row left non-terminal by such an error is
 * resolved by the startup reconciler, the durable backstop Discipline B requires
 * — no in-process handler survives a crash.
 * @testseam execution-service.test.ts asserts the terminal write directly
 */
export async function withSessionLifecycle(
  sessionStore: SessionStore,
  session: { readonly sessionId: string; readonly taskId: string; readonly brief: AgentBrief; readonly environmentVersion: string | null },
  body: (slot: AttemptSlot) => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  const { sessionId, taskId } = session;
  await sessionStore.insert(sessionId, taskId, session.brief, session.environmentVersion);

  // The attempt, when body ran one, is written with the terminal phase on every exit, a throw included.
  const slot: AttemptSlot = { attempt: null };
  let outcome: ExecutionResult;
  try {
    outcome = await body(slot);
  } catch (e) {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(
        sessionId,
        {
          outcome: "errored",
          detail: describeErrorChain(e),
        },
        slot.attempt,
      ),
    );
    throw e;
  }

  if (outcome.status === "completed") {
    await closeSession(taskId, sessionId, () =>
      sessionStore.complete(sessionId, slot.attempt, { outcome: "completed", detail: outcome.detail }),
    );
  } else {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(
        sessionId,
        {
          outcome: outcome.status,
          detail: outcome.detail,
          ...(outcome.errorEnvelope !== undefined ? { errorEnvelope: outcome.errorEnvelope } : {}),
        },
        slot.attempt,
      ),
    );
  }
  return outcome;
}

async function closeSession(taskId: string, sessionId: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (e) {
    console.warn(
      `[${taskId}] failed to write the terminal dev_session phase for ${sessionId}; ` +
        `the row stays non-terminal until startup reconciliation resolves it:`,
      e,
    );
  }
}

/** Narrows an untyped jsonb value to a `string[]`, dropping non-string members. */
function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// ---------------------------------------------------------------------------
// Replan context injection (redteam L1, docs/investigations/run9-readiness-
// redteam.md): FailureRouter.route() replans a failed item back to Pending and
// the orchestrator (failure-recovery.ts applyReplan) persists the raw failure
// context on WorkItem.blockedReason.replanContext. Without this, attempt 2's
// brief was byte-identical to attempt 1's — the failure context was write-only.
// Surfacing it here — read BEFORE the agent dispatch, never cleared in between
// (startWorkItem does not touch blockedReason) — is what makes a replan an
// INFORMED retry instead of a repeat of the exact attempt that just failed.
// ---------------------------------------------------------------------------

interface ReplanContext {
  readonly attempt: number;
  readonly detail: string;
  readonly raw: unknown;
}

function isReplanContext(value: unknown): value is ReplanContext {
  if (typeof value !== "object" || value === null) return false;
  // contract-erasing: narrowing for ReplanContext, which has a known shape
  const candidate = value as Record<string, unknown>;
  return typeof candidate.attempt === "number" && typeof candidate.detail === "string";
}

/**
 * Fail-safe (Discipline A): blockedReason is untyped jsonb round-tripped
 * through the DB, so a malformed or absent replanContext must never crash
 * brief assembly — it just means the "Prior Attempt Failure" section is
 * omitted. Absence is the normal (non-replanned) case and is silent; a
 * present-but-malformed shape is unexpected and is logged.
 */
function extractReplanContext(
  taskId: string,
  blockedReason: StoredBlockedReason | undefined,
): ReplanContext | null {
  if (!blockedReason) return null;
  // Only the "replan" variant carries replanContext; other variants do not.
  if (blockedReason.source !== "replan") return null;
  const candidate = blockedReason.replanContext;
  if (candidate === undefined) return null;

  if (!isReplanContext(candidate)) {
    console.warn(
      `[${taskId}] malformed blockedReason.replanContext (expected {attempt: number, detail: string, raw}); ` +
        `omitting Prior Attempt Failure section from brief:`,
      candidate,
    );
    return null;
  }
  return candidate;
}

function innermostLayer(layer: ErrorLayer): ErrorLayer {
  let current = layer;
  while (current.cause) {
    current = current.cause;
  }
  return current;
}

function formatPriorAttemptFailure(ctx: ReplanContext): string {
  const envelopeParsed = errorEnvelopeSchema.safeParse(ctx.raw);
  if (envelopeParsed.success) {
    const envelope = envelopeParsed.data;
    const diagnostic = innermostLayer(envelope.chain).message;

    const lines: string[] = [
      `# CRITICAL: Previous attempt FAILED — read this FIRST`,
      ``,
      `Your previous attempt (attempt ${ctx.attempt}) failed. You MUST address this before doing anything else.`,
      ``,
      `## What failed`,
      diagnostic,
      ``,
      `## Do NOT repeat`,
      `YOU MUST fix: ${diagnostic}. Previous attempt failed because ${ctx.detail}.`,
      ``,
      renderChainForBrief(envelope),
    ];
    return lines.join("\n");
  }

  let rawText: string;
  try {
    rawText = JSON.stringify(ctx.raw, null, 2);
  } catch {
    rawText = String(ctx.raw);
  }

  return [
    `# CRITICAL: Previous attempt FAILED — read this FIRST`,
    ``,
    `Your previous attempt (attempt ${ctx.attempt}) failed. You MUST address this before doing anything else.`,
    ``,
    `## What failed`,
    `Detail: ${ctx.detail}`,
    ``,
    `## Do NOT repeat`,
    `Do NOT repeat the same approach that produced this failure.`,
    ``,
    `## Previous attempt's raw failure payload`,
    "```",
    rawText,
    "```",
  ].join("\n");
}

