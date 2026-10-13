import { access } from "node:fs/promises";
import type { BaseCellReference, Cell, CellSpec, SubstrateInfo } from "@ashara/execution-infra";
import { CellTeardownFailed, SubstrateUnavailable, createCellBackend } from "@ashara/execution-infra";
import type { ContextualTurnLlm, ResolvedModel } from "@ashara/llm-gateway";
import type { ProjectId, WorkItemId, AgentBrief, ProjectContract, ErrorEnvelope, ErrorLayer, StoredTaskSpec, StoredBlockedReason, WorkKind } from "@ashara/shared";
import { createSessionId, createAgentBrief, nodeByKind, wrapError, errorEnvelopeSchema, renderChainForBrief } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { AttemptCellImage, Outcome } from "@ashara/workplace";
import {
  environmentCheckPassed,
  environmentTestPassed,
  formatEnvironmentCheck,
  formatEnvironmentTest,
  runAttempt,
} from "@ashara/workplace";
import { formatAcceptanceCriteria, formatTaskSpec } from "./brief-assembly.js";
import { DispatchRecords, cellAsRunner, toAgentOutput } from "./cell-execution.js";
import { buildContextMap } from "./context-map.js";
import { resolveCurrentEnvironment } from "./current-environment.js";
import type { CurrentEnvironment } from "./current-environment.js";
import { environmentCheckPort, runEnvironmentTest, runSubstrateGate } from "./environment-check.js";
import type { EnvironmentCheckScope, EnvironmentImages, EnvironmentStatementStore, SubstrateGateRun, TestedEnvironment } from "./environment-check.js";
import { environmentErrorOf, unavailableOf } from "./environment-failure.js";
import type { EnvironmentError } from "./environment-failure.js";
import { targetRepo } from "./host-git.js";
import { ProjectIntentUnavailable, loadProjectIntent } from "./project-intent.js";
import type { ProjectIntentSource } from "./project-intent.js";
import type { TaskSpec } from "./types.js";
import { finalizeSuccess } from "./gates/finalize.js";
import type { FinalizeDeps, PostMergeVerdict } from "./gates/finalize.js";
import { runVerifyCore } from "./verify-core.js";
import type { CommandRunner } from "./verify-core.js";
import {
  cleanupWorkdir,
  commitAllChanges,
  commitPartialWork,
  createWorkdir,
  createWorkdirForRetry,
  getChangedFiles,
} from "./workspace.js";
import type { WorkdirInfo } from "./workspace.js";
import { branchExists, taskBranchName } from "./merge.js";
import type { KnowledgeSink, KnowledgeScope, KnowledgeSource } from "./knowledge-writer.js";
import { buildKnowledgeQueryText, storeFailureKnowledge, storeKnowledge } from "./knowledge-writer.js";

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
 * The stage of a dispatch whose substrate failed: the probe and the task cell before the attempt,
 * the attempt itself, the task cell's checks, and the post-merge verifier cell.
 */
type EnvironmentStage = "probeSubstrate" | "resolveEnvironment" | "createCell" | "agentAttempt" | "taskVerify" | "substrateGate" | "postMergeVerify";

interface AgentPart {
  readonly output: AgentOutputJson | null;
  readonly agentInvoked: boolean;
}

const NO_AGENT: AgentPart = { output: null, agentInvoked: false };

interface EnvironmentBlock extends AgentPart {
  readonly taskId: WorkItemId;
  readonly sessionId: string;
  readonly stage: EnvironmentStage;
  /** The failure's class name, e.g. MountPathRejected; the reason names it. */
  readonly errorClass: string;
  readonly message: string;
  readonly chain: ErrorLayer;
  readonly unavailable: string;
}

/**
 * The substrate cannot host a stage of the task (podman missing or not answering, a cell that
 * cannot start or be mounted, an exec the substrate could not run): Blocked for the operator with
 * the stage and error class named, never a host fallback and never a failure for the classifier
 * (s-isolated-worker-m1 C2, at every stage).
 */
function environmentBlocked(block: EnvironmentBlock, eventSink: ExecutionEventSink | undefined): ExecutionResult {
  const { taskId, stage, errorClass } = block;
  const kept = block.agentInvoked
    ? "the agent's work is kept on the task branch"
    : "no agent ran and nothing executed";
  const envelope: ErrorEnvelope = {
    outcome: "blocked",
    summary: `environment failed at stage ${stage} (${errorClass}): ${block.message}; task ${taskId} blocked, ${kept}`,
    chain: block.chain,
    ...(block.output !== null ? { agentOutput: block.output } : {}),
  };
  console.warn(`[${taskId}] ${envelope.summary}`);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: 1, stage, errorClass, reason: envelope.summary });
  return {
    status: "environment_blocked",
    unavailable: block.unavailable,
    detail: envelope.summary,
    output: block.output,
    sessionId: block.sessionId,
    attempt: 1,
    errorEnvelope: envelope,
    agentInvoked: block.agentInvoked,
  };
}

/** An environment block for a typed substrate error raised at `stage`. */
function substrateBlocked(
  taskId: WorkItemId,
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
      taskId,
      sessionId,
      stage,
      errorClass: e.name,
      message: e.message,
      chain: chain ?? wrapError("development", stage, e, { taskId, unavailable, errorClass: e.name }),
      unavailable,
      ...agent,
    },
    eventSink,
  );
}

function failedBeforeAgent(taskId: WorkItemId, sessionId: string, operation: string, e: unknown, summary: string): ExecutionResult {
  const chain = wrapError("development", operation, e, { taskId });
  const envelope: ErrorEnvelope = { outcome: "failed", summary: `${summary}: ${chain.message}`, chain };
  return {
    status: "failed",
    detail: envelope.summary,
    output: null,
    sessionId,
    attempt: 1,
    errorEnvelope: envelope,
    agentInvoked: false,
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
  return { kind: "defined", version: environment.version, commit: environment.commit, statement: environment.statement };
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
  taskId: WorkItemId,
  sessionId: string,
  reason: string,
  eventSink: ExecutionEventSink | undefined,
): ExecutionResult {
  const chain = wrapError("development", "resolveCurrentEnvironment", reason, { taskId });
  const summary = `no environment for task ${taskId}: ${reason}; no agent ran and nothing executed`;
  console.warn(`[${taskId}] ${summary}`);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: 1, stage: "resolveCurrentEnvironment", reason: summary });
  return {
    status: "environment_undefined",
    reason,
    detail: summary,
    output: null,
    sessionId,
    attempt: 1,
    errorEnvelope: { outcome: "blocked", summary, chain },
    agentInvoked: false,
  };
}

// ---------------------------------------------------------------------------
// Injected dependency interfaces
// ---------------------------------------------------------------------------

export interface SessionStore {
  /** `environmentVersion` is the version the dispatch's cells were built from; null on the BaseCell. */
  insert(sessionId: string, taskId: string, brief: unknown, environmentVersion: string | null): Promise<void>;
  complete(sessionId: string): Promise<void>;
  fail(sessionId: string, verificationResult: unknown): Promise<void>;
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

/** Who works a task and on which model. */
interface AgentStaff {
  readonly role: string;
  readonly model: ResolvedModel;
}

/**
 * Builds the agent half of a task's Assignment: its role and its model, resolved once per
 * attempt and never inside it (ADR-074 d44). The composition root supplies it.
 */
export interface AgentStaffing {
  staff(task: TaskDescriptor): AgentStaff;
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
 * The outcome of a dispatch the execution substrate could not host: the
 * substrate was unavailable before the attempt (no agent ran, nothing
 * executed), a cell failed under a running attempt (environment_failure), or
 * the task cell's checks or the post-merge verifier cell could not run.
 * It is not a task failure (re-dispatching cannot make the substrate appear),
 * so the orchestrator parks the item at Blocked with an
 * `environment_unavailable` reason instead of routing it through the
 * FailureRouter.
 */
interface EnvironmentBlockedResult {
  readonly status: "environment_blocked";
  /** What was unavailable, named for the operator (e.g. "container substrate (podman)"). */
  readonly unavailable: string;
  readonly detail: string;
  /** null when no agent ran; the attempt's output when a cell failed under it. */
  readonly output: AgentOutputJson | null;
  readonly sessionId: string;
  readonly attempt: 1;
  readonly errorEnvelope: ErrorEnvelope;
  readonly agentInvoked: boolean;
}

/**
 * The project has no environment the task's cells could be built from (none defined on the
 * target's main, its image could not be built, or no statement of it is on record). Nothing ran;
 * the orchestrator parks the item at Blocked with an `environment_undefined` reason.
 */
interface EnvironmentUndefinedResult {
  readonly status: "environment_undefined";
  readonly reason: string;
  readonly detail: string;
  readonly output: null;
  readonly sessionId: string;
  readonly attempt: 1;
  readonly errorEnvelope: ErrorEnvelope;
  readonly agentInvoked: false;
}

export type ExecutionResult = AgentExecutionResult | EnvironmentBlockedResult | EnvironmentUndefinedResult;

interface AgentExecutionResult {
  readonly status: "completed" | "failed" | "blocked";
  readonly detail: string;
  readonly output: AgentOutputJson | null;
  readonly sessionId: string;
  /**
   * Always 1 — execute() makes exactly one agent invocation per call. Retrying a
   * failed task is the orchestrator's FailureRouter's job (re-dispatch, tracked via
   * WorkItem.dispatchCount), not this service's.
   */
  readonly attempt: number;
  readonly errorEnvelope?: ErrorEnvelope;
  /**
   * Whether the attempt loop was started for this dispatch.
   */
  readonly agentInvoked: boolean;
}

/**
 * Mutable across the runExecution call so the outer catch can still report
 * whether the attempt had been started when the throw happened: a throw after
 * the model was called is exactly the case where `agentInvoked` must survive
 * the stack unwind.
 */
interface DispatchRecord {
  agentInvoked: boolean;
}

type VerifyTaskOutcome =
  | {
      readonly verdict: "passed" | "failed" | "unverified";
      readonly details?: string;
      readonly checks?: ReadonlyArray<{ name: string; passed: boolean; output?: string }>;
    }
  /** The cell could not run the checks: no verdict on the work at all. */
  | { readonly verdict: "environment_failed"; readonly error: EnvironmentError };

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
  readonly contract: ProjectContract | null;
  /** What the task cell, its checks and the post-merge verifier cell are started from. */
  readonly environment: DispatchEnvironment;
  readonly record: DispatchRecord;
}

/** The ashara.role label of the post-merge check's cell. */
const POST_MERGE_VERIFIER_ROLE = "verifier";

/** How a substrate-checked task's gate ended: passed with the image it tested, or the dispatch's result. */
type SubstrateGateOutcome =
  | { readonly kind: "passed"; readonly tested: TestedEnvironment }
  | { readonly kind: "ended"; readonly result: ExecutionResult };

// ---------------------------------------------------------------------------
// DevelopmentService
// ---------------------------------------------------------------------------

/**
 * Port that yields the current ProjectContract for the project a task belongs to,
 * or null when the project has no contract. Injected so the BC stays free of any
 * db dependency (ADR-027); the composition root resolves task → project → latest
 * contract.
 */
export interface ContractSource {
  loadForTask(taskId: string): Promise<ProjectContract | null>;
}

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
   * Yields the ProjectContract for a task's project; its knowledge graph feeds the entry-point
   * context. Absent (or a null result) means the project has no contract.
   */
  readonly contractSource?: ContractSource;
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
  /** Aborted on shutdown: an attempt in flight ends as cancelled. */
  readonly shutdownSignal: AbortSignal;
}

export class DevelopmentService {
  private readonly deps: DevelopmentServiceDeps;

  constructor(deps: DevelopmentServiceDeps) {
    this.deps = deps;
  }

  async execute(
    task: TaskDescriptor,
    targetProjectPath: string | null,
  ): Promise<ExecutionResult> {
    const { config, eventSink, cells } = this.deps;
    const sessionId = createSessionId();
    const base = config.workdirBase;

    eventSink?.emit({
      event: "task_started",
      taskId: task.id,
      goal: task.taskSpec?.goal ?? task.title,
      model: task.taskSpec?.capability ?? "Strong",
    });

    // First, before the contract, the brief (which may call an LLM) or the
    // worktree: a substrate that cannot host the task blocks it here, so no
    // later path can fall through to host execution.
    try {
      await cells.substrate.probeSubstrate();
    } catch (e) {
      if (!(e instanceof SubstrateUnavailable)) throw e;
      return substrateBlocked(task.id, sessionId, "probeSubstrate", e, "container substrate", NO_AGENT, eventSink);
    }

    // Z0's git never discovers a repository from a tree a cell writes (host-git.ts),
    // and only a target checkout gives the worktree a git dir Z0 owns. Without one
    // nothing could be merged either, so the dispatch ends before any model call.
    if (targetProjectPath === null) {
      const result = failedBeforeAgent(
        task.id,
        sessionId,
        "resolveTargetWorkspace",
        "target project path unresolved; nothing could be merged",
        `no target workspace for ${task.id}`,
      );
      eventSink?.emit({ event: "error", location: "DevelopmentService:resolveTargetWorkspace", taskId: task.id, attempt: 1, error: result.detail });
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }

    // Only the environment role's work is checked by the substrate: any other task so marked
    // would skip verification without being able to build what the gate checks.
    if (task.taskSpec?.checkedBy === "substrate" && task.workKind !== "environment") {
      const result = failedBeforeAgent(
        task.id,
        sessionId,
        "checkSubstrateGate",
        `task_spec.checkedBy is "substrate" but the task's work kind is ${task.workKind ?? "unrecorded"}, not environment`,
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
        if (resolution.kind === "undefined") {
          const result = environmentUndefined(task.id, sessionId, resolution.reason, eventSink);
          await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
          return result;
        }
        environment = { kind: "environment", ...resolution.environment };
      } catch (e) {
        const environmentFailure = environmentErrorOf(e);
        if (environmentFailure !== null) {
          return substrateBlocked(task.id, sessionId, "resolveEnvironment", environmentFailure, "environment image build", NO_AGENT, eventSink);
        }
        const result = failedBeforeAgent(task.id, sessionId, "resolveCurrentEnvironment", e, `the current environment of ${task.id} could not be resolved`);
        eventSink?.emit({ event: "error", location: "DevelopmentService:resolveCurrentEnvironment", taskId: task.id, attempt: 1, error: result.detail });
        await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
        return result;
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

    let contract: ProjectContract | null = null;
    try {
      contract = await this.loadContract(task.id);
    } catch (e) {
      console.warn(`[${task.id}] contract load failed; dispatching without contract context:`, e);
    }

    let brief: AgentBrief;
    try {
      brief = await this.buildBrief(task, targetProjectPath, contract, environment);
    } catch (e) {
      // A missing intent is a PLANNING-INPUT gap, not an agent failure, so the
      // result is `blocked` with the lookup's own detail. The orchestrator
      // nevertheless routes a `blocked` result like `failed`: the item goes to
      // Failed and through the FailureRouter (executeTask in
      // orchestrator/src/execution.ts). Only `environment_blocked` and
      // `environment_undefined` park an item at Blocked.
      if (!(e instanceof ProjectIntentUnavailable)) throw e;
      const chain = wrapError("development", "loadProjectIntent", e, { taskId: task.id });
      const envelope: ErrorEnvelope = {
        outcome: "blocked",
        summary: `project intent unavailable for ${task.id}: ${chain.message}`,
        chain,
      };
      eventSink?.emit({
        event: "task_blocked",
        taskId: task.id,
        attempt: 1,
        reason: envelope.summary,
      });
      const result: ExecutionResult = {
        status: "blocked",
        detail: envelope.summary,
        output: null,
        sessionId,
        attempt: 1,
        errorEnvelope: envelope,
        agentInvoked: false,
      };
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }

    // The Assignment's agent half, once per attempt: a model that cannot be
    // resolved (routing, budget) fails the dispatch before any worktree exists.
    let staff: AgentStaff;
    let records: DispatchRecords;
    try {
      staff = this.deps.staffing.staff(task);
      records = new DispatchRecords(base, task.id, sessionId);
      await records.writeBrief(brief);
    } catch (e) {
      const result = failedBeforeAgent(task.id, sessionId, "assignAgent", e, `agent assignment failed for ${task.id}`);
      eventSink?.emit({ event: "error", location: "DevelopmentService:assignAgent", taskId: task.id, attempt: 1, error: result.detail });
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }

    let workdir: WorkdirInfo;
    const branch = taskBranchName(task.id);
    try {
      workdir = (await branchExists(targetProjectPath, branch))
        ? await createWorkdirForRetry(base, targetProjectPath, branch)
        : await createWorkdir(base, targetProjectPath, branch);
    } catch (e) {
      const result = failedBeforeAgent(task.id, sessionId, "createWorkdir", e, `workdir creation failed for ${task.id}`);
      eventSink?.emit({
        event: "error",
        location: "DevelopmentService:createWorkdir",
        taskId: task.id,
        attempt: 1,
        error: result.detail,
      });
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }
    const { workDir, repo } = workdir;

    // The task's cell mounts only its worktree, with the gitlink read-only. A substrate
    // that vanished since the probe, or a cell that cannot start, still blocks: never a
    // host fallback.
    let cell: Cell;
    try {
      cell = await cells.substrate.createCell({
        image: cellImageOf(environment),
        project: task.projectId,
        task: task.id,
        role: staff.role,
        instance: cells.instance,
        mount: { hostPath: workDir, readOnlyEntries: [".git"] },
      });
    } catch (e) {
      await cleanupWorkdirBeforeReturn(task.id, workDir, targetProjectPath, "the task cell could not be created");
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure !== null) {
        return substrateBlocked(task.id, sessionId, "createCell", environmentFailure, "task cell", NO_AGENT, eventSink);
      }
      const result = failedBeforeAgent(task.id, sessionId, "createCell", e, `task cell refused for ${task.id}`);
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }
    eventSink?.emit({ event: "cell_created", taskId: task.id, cellId: cell.id, role: staff.role, image: cellImageOf(environment), cellImage: attemptCellImage(environment) });

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
      contract,
      environment,
      record: { agentInvoked: false },
    };

    try {
      const result = await withSessionLifecycle(
        this.deps.sessionStore,
        { sessionId, taskId: task.id, brief, environmentVersion: sessionEnvironmentVersion(environment) },
        () => this.runExecution(dispatch),
      );
      // Every non-completed terminal outcome carries a blocking/failure reason
      // worth keeping (kl-t4): capturing it here, ONE seam covering every return
      // path inside runExecution, is what closes the success-only gap without
      // touching its many return sites.
      if (result.status !== "completed") {
        await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      }
      return result;
    } catch (e) {
      const chain = wrapError("development", "execute", e, { taskId: task.id });
      eventSink?.emit({
        event: "error",
        location: "DevelopmentService:execute",
        taskId: task.id,
        attempt: 1,
        error: chain.message,
      });
      await cleanupWorkdir(workDir, targetProjectPath);
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `execution error for ${task.id}: ${chain.message}`,
        chain,
      };
      const result: ExecutionResult = {
        status: "failed",
        detail: envelope.summary,
        output: null,
        sessionId,
        attempt: 1,
        errorEnvelope: envelope,
        agentInvoked: dispatch.record.agentInvoked,
      };
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    } finally {
      await this.teardownCell(task.id, cell);
    }
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
   * Runs `verify` with a runner into a short-lived role=verifier cell that mounts
   * the target checkout with a shared label (`:z`): two cells may mount it. Its
   * `.git` is read-only: Z0 commits the merge in that repository after the checks,
   * so a check able to write its config or hooks would run code on the host.
   */
  private async withVerifierCell<T>(d: Dispatch, targetProjectPath: string, verify: (runCommand: CommandRunner) => Promise<T>): Promise<T> {
    const { cells } = this.deps;
    const { task } = d;
    const cell = await cells.substrate.createCell({
      image: cellImageOf(d.environment),
      project: task.projectId,
      task: task.id,
      role: POST_MERGE_VERIFIER_ROLE,
      instance: cells.instance,
      mount: { hostPath: targetProjectPath, shared: true, readOnlyEntries: [".git"] },
    });
    try {
      return await verify(cellAsRunner(cell, targetProjectPath));
    } finally {
      await this.teardownCell(task.id, cell);
    }
  }

  private async buildBrief(
    task: TaskDescriptor,
    targetProjectPath: string | null,
    contract: ProjectContract | null,
    environment: DispatchEnvironment,
  ): Promise<AgentBrief> {
    const taskSpec = task.taskSpec;

    const replanContext = extractReplanContext(task.id, task.blockedReason);
    const priorAttemptFailure = replanContext ? formatPriorAttemptFailure(replanContext) : undefined;

    // A ProjectIntentUnavailable propagates to execute() and blocks the task.
    const intent = await loadProjectIntent(this.deps.intentSource, task.id);

    const spec: TaskSpec = {
      goal: (typeof taskSpec?.goal === "string" ? taskSpec.goal : task.title),
      endState: (typeof taskSpec?.endState === "string" ? taskSpec.endState : `Implement: ${task.title}`),
      scope: (typeof taskSpec?.scope === "string" ? taskSpec.scope : ""),
      deliverables: stringArrayOrEmpty(taskSpec?.deliverables),
    };

    const contractEntryPoint = contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null;
    const contextMap = await buildContextMap(targetProjectPath, contractEntryPoint ?? undefined);
    const knowledgeContext = await this.buildKnowledgeContext(task, spec);

    // createAgentBrief: the compiler checks the shape at this construction site,
    // and the Zod parse underneath throws on a malformed brief, which blocks the
    // task rather than shipping a degraded one.
    const acceptanceSection = formatAcceptanceCriteria(task.successCriteria);
    const formattedTaskSpec = formatTaskSpec(spec);
    const taskContext = acceptanceSection ? `${formattedTaskSpec}\n\n${acceptanceSection}` : formattedTaskSpec;
    return createAgentBrief(
      {
        taskId: task.id,
        goal: spec.goal,
        intent,
        projectEnvironment: briefEnvironment(environment),
        context: taskContext,
        deliverables: spec.deliverables,
        knowledgeContext,
        contextMap,
        ...(priorAttemptFailure !== undefined ? { priorAttemptFailure } : {}),
      },
      "development:buildBrief",
    );
  }

  /**
   * Loads this task's ProjectContract via the injected port. Returns null when no
   * contract source is wired or the project has no contract. Throws on load
   * errors so callers can distinguish "no contract" from "load failed" and route
   * their own fail-soft policy at the appropriate level.
   */
  private async loadContract(taskId: string): Promise<ProjectContract | null> {
    const source = this.deps.contractSource;
    if (!source) return null;
    return await source.loadForTask(taskId);
  }

  private async buildKnowledgeContext(task: TaskDescriptor, spec: TaskSpec): Promise<string> {
    const source = this.deps.knowledgeSource;
    if (!source) return "";

    const scope: KnowledgeScope = {
      epicId: task.epicId ?? null,
      queryText: buildKnowledgeQueryText(task.title, spec),
    };

    const MAX_CHARS = 8000; // ~2K tokens
    const sections: string[] = ["# Prior Knowledge"];
    let charCount = sections[0].length;

    try {
      const findings = await source.recentFindings(scope, 10);
      if (findings.length > 0) {
        const lines = ["## Recent Findings"];
        for (const f of findings) {
          const line = `- "${f.title}" (source: ${f.source})\n  ${f.contentSnippet}`;
          if (charCount + line.length > MAX_CHARS) break;
          lines.push(line);
          charCount += line.length;
        }
        if (lines.length > 1) sections.push(lines.join("\n"));
      }
    } catch (e: unknown) {
      console.warn(`[buildKnowledgeContext] Failed to retrieve recent findings: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const approaches = await source.failedApproaches(scope, 10);
      if (approaches.length > 0) {
        const lines = ["## Failed Approaches — do not repeat"];
        for (const a of approaches) {
          const line = `- "${a.title}" — Failed: ${a.failureReason} (affected: ${a.affectedArea})\n  Learned: ${a.learned}`;
          if (charCount + line.length > MAX_CHARS) break;
          lines.push(line);
          charCount += line.length;
        }
        if (lines.length > 1) sections.push(lines.join("\n"));
      }
    } catch (e: unknown) {
      console.warn(`[buildKnowledgeContext] Failed to retrieve failed approaches: ${e instanceof Error ? e.message : String(e)}`);
    }

    return sections.length > 1 ? sections.join("\n\n") : "";
  }

  private async runExecution(d: Dispatch): Promise<ExecutionResult> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, brief, staff, workDir, targetProjectPath, sessionId } = d;

    eventSink?.emit({
      event: "agent_launched",
      taskId: task.id,
      attempt: 1,
      workDir,
      cellId: d.cell.id,
      role: staff.role,
      provider: staff.model.provider,
      model: staff.model.modelId,
      records: d.records.dir,
    });

    d.record.agentInvoked = true;
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
        clock: { now: () => Date.now() },
        records: d.records,
        signal: this.deps.shutdownSignal,
        environment: task.workKind === "environment" ? environmentCheckPort(this.environmentScope(d)) : null,
      },
    );
    const output = toAgentOutput(outcome, staff.model.modelId, d.records.tokens());
    // Observe the workdir BEFORE cleanup: after cleanupWorkdir the worktree is gone.
    const filesChanged = await getChangedFiles(d.repo);
    eventSink?.emit({
      event: "agent_completed",
      taskId: task.id,
      attempt: 1,
      status: output.status,
      outcome: outcome.kind,
      turns: outcome.turnsUsed,
      cost: output.total_cost,
      costMeasured: output.cost_measured,
      summary: output.summary,
      filesChanged,
    });

    if (!(outcome.kind === "finished" && outcome.status === "done")) {
      return this.endWithoutDone(d, outcome, output);
    }

    if (filesChanged.length === 0) {
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "agent produced no file changes",
      });
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "agentExecution", "agent produced no file changes", {
        taskId: task.id,
        turnCount: outcome.turnsUsed,
      });
      return {
        status: "failed",
        detail: "agent produced no file changes",
        output,
        sessionId,
        attempt: 1,
        errorEnvelope: { outcome: "failed", summary: "agent produced no file changes", chain, agentOutput: output },
        agentInvoked: true,
      };
    }

    let postMergeVerify: (path: string) => Promise<PostMergeVerdict>;
    if (task.taskSpec?.checkedBy === "substrate") {
      const gate = await this.substrateGate(d, outcome.summary, output);
      if (gate.kind === "ended") return gate.result;
      postMergeVerify = (path) => this.postMergeEnvironmentTest(d, path, gate.tested);
    } else {
      const verified = await this.verifyTaskOrEnd(d, output);
      if (verified !== null) return verified;
      postMergeVerify = (path) => this.postMergeChecks(d, path);
    }

    const finalizeDeps: FinalizeDeps = { eventSink, postMergeVerify };
    const finalizeResult = await finalizeSuccess(finalizeDeps, d.repo, task, targetProjectPath, 1, {
      entryPointPath: d.contract ? nodeByKind(d.contract.knowledge, "entry_point")?.label ?? null : null,
    });
    if (!finalizeResult.success && finalizeResult.environmentFailure !== null) {
      // The merge was aborted and the branch kept: the verifier cell's substrate
      // failed, which is the operator's to fix, not a regression of the tree.
      await cleanupWorkdir(workDir, targetProjectPath);
      return substrateBlocked(
        task.id,
        sessionId,
        "postMergeVerify",
        finalizeResult.environmentFailure,
        "verifier cell",
        { output, agentInvoked: true },
        eventSink,
        finalizeResult.errorLayer,
      );
    }
    if (!finalizeResult.success) {
      const gateChain = finalizeResult.errorLayer;
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `post-merge verify failed for ${task.id}`,
        chain: gateChain,
        agentOutput: output,
      };
      eventSink?.emit({
        event: "gate_failed",
        taskId: task.id,
        attempt: 1,
        reason: envelope.summary,
      });
      await cleanupWorkdir(workDir, targetProjectPath);
      return {
        status: "failed",
        detail: envelope.summary,
        output,
        sessionId,
        attempt: 1,
        errorEnvelope: envelope,
        agentInvoked: true,
      };
    }

    await cleanupWorkdir(workDir, targetProjectPath, taskBranchName(task.id));
    // Stated from the disk, not assumed: cleanupWorkdir's own fallbacks are best-effort.
    if (await pathExists(workDir)) {
      console.warn(`[${task.id}] task completed — but worktree ${workDir} is still on disk after cleanup`);
    } else {
      console.log(`[${task.id}] task completed — worktree ${workDir} removed after the merge`);
    }
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: 1, result: "completed" });
    await storeKnowledge(this.deps.knowledgeSink, task, output, filesChanged);
    return {
      status: "completed",
      detail: "task completed and verified successfully",
      output,
      sessionId,
      attempt: 1,
      agentInvoked: true,
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
      images: this.deps.environment.images,
      // Shared label (`:z`): the task cell may still mount the same tree. `.git` read-only: Z0's git
      // reads that repository after the cell ran.
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({
          image,
          project: task.projectId,
          task: task.id,
          role,
          instance: cells.instance,
          mount: { hostPath, shared: true, readOnlyEntries: [".git"] },
        }),
      teardownCell: (cell) => this.teardownCell(task.id, cell),
    };
  }

  /**
   * The Sprint 0 gate (task_spec.checkedBy "substrate"), in place of per-task verify: the agent's
   * work is committed to the task branch, then its environment definition must parse, its image
   * build and its `test` pass in a fresh CI cell. A failed gate is a task failure (the definition
   * is the environment role's work), never environment_unavailable; a substrate that cannot run
   * the gate blocks the task. On a pass the finish statement is kept on the work item.
   */
  private async substrateGate(d: Dispatch, statement: string, output: AgentOutputJson): Promise<SubstrateGateOutcome> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    eventSink?.emit({ event: "substrate_gate_started", taskId: task.id, attempt: 1, workDir });
    await commitAllChanges(d.repo, `ashara: agent output for task ${task.id}`);

    let run: SubstrateGateRun;
    try {
      run = await runSubstrateGate(this.environmentScope(d), attemptPolicy.perCommandTimeoutSeconds);
    } catch (e) {
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure === null) throw e;
      await cleanupWorkdir(workDir, targetProjectPath);
      return {
        kind: "ended",
        result: substrateBlocked(task.id, sessionId, "substrateGate", environmentFailure, "CI cell", { output, agentInvoked: true }, eventSink),
      };
    }

    const passed = environmentCheckPassed(run.report);
    const gateOutput = formatEnvironmentCheck(run.report);
    eventSink?.emit({ event: "substrate_gate_result", taskId: task.id, attempt: 1, passed, report: run.report.kind, output: gateOutput });
    if (!passed || run.tested === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "substrateGate", gateOutput, { taskId: task.id, report: run.report.kind });
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `substrate gate failed for ${task.id}:\n${gateOutput}`,
        chain,
        agentOutput: output,
      };
      return {
        kind: "ended",
        result: { status: "failed", detail: envelope.summary, output, sessionId, attempt: 1, errorEnvelope: envelope, agentInvoked: true },
      };
    }

    await this.deps.environment.statements.record(task.id, statement);
    return { kind: "passed", tested: run.tested };
  }

  /** A substrate-checked task's post-merge check: the environment's test, from the gate's image, on the merged tree. */
  private async postMergeEnvironmentTest(d: Dispatch, targetProjectPath: string, tested: TestedEnvironment): Promise<PostMergeVerdict> {
    const test = await runEnvironmentTest(
      this.environmentScope(d),
      POST_MERGE_VERIFIER_ROLE,
      tested.imageRef,
      targetProjectPath,
      tested.test,
      this.deps.attemptPolicy.perCommandTimeoutSeconds,
    );
    const passed = environmentTestPassed(test);
    const details = formatEnvironmentTest(test);
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: d.task.id, attempt: 1, verdict: passed ? "passed" : "failed", details });
    return { passed, details };
  }

  /** Every other task's post-merge check: its verify checks in a verifier cell from the dispatch's image. */
  private async postMergeChecks(d: Dispatch, targetProjectPath: string): Promise<PostMergeVerdict> {
    const { task } = d;
    // Per-task verify uses only verify.toml; contract checks are deferred to
    // integration verify (they reference project-wide files that may not exist
    // in this task's worktree).
    const result = await this.withVerifierCell(d, targetProjectPath, (runCommand) =>
      runVerifyCore(
        { workDir: targetProjectPath, gitRoot: targetProjectPath, contractChecks: [] },
        {
          runCommand,
          log: (event) => this.deps.eventSink?.emit({ ...event, event: "post_merge_verify", taskId: task.id, attempt: 1 }),
        },
      ),
    );
    return { passed: result.verdict === "passed", details: result.tiers.deterministic.details };
  }

  /** Per-task verify of the worktree in the task cell; null when it passed, else the dispatch's result. */
  private async verifyTaskOrEnd(d: Dispatch, output: AgentOutputJson): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    eventSink?.emit({ event: "verify_started", taskId: task.id, attempt: 1, workDir });
    const verifyOutcome = await this.verifyTask(task, workDir, cellAsRunner(d.cell, workDir), 1);

    if (verifyOutcome.verdict === "environment_failed") {
      await commitPartialWork(
        d.repo,
        `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, verify-environment-failed)`,
      );
      await cleanupWorkdir(workDir, targetProjectPath);
      return substrateBlocked(task.id, sessionId, "taskVerify", verifyOutcome.error, "task cell", { output, agentInvoked: true }, eventSink);
    }

    if (verifyOutcome.verdict === "unverified") {
      // Zero executable checks: a verdict computed from nothing must not read
      // as success (Discipline A). The orchestrator commits this as Failed and
      // routes it through the FailureRouter to replan-or-abandon — same path
      // as a failed verification, bounded by the replan limit. Since the
      // scaffold task was replaced by Sprint 0 nothing in a plan asks for a
      // verify.toml, so every task not checked by the substrate ends here until
      // t-verify-checks-from-plan supplies its checks.
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "verification unverified — no executable checks",
      });
      await commitPartialWork(
        d.repo,
        `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, verify-unverified)`,
      );
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "verify", "zero executable checks — task unverified", { taskId: task.id });
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: "verification unverified — no executable checks exist to confirm task output",
        chain,
        agentOutput: output,
      };
      return {
        status: "failed",
        detail: envelope.summary,
        output,
        sessionId,
        attempt: 1,
        errorEnvelope: envelope,
        agentInvoked: true,
      };
    }

    if (verifyOutcome.verdict !== "passed") {
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "verification failed",
      });
      await commitPartialWork(
        d.repo,
        `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, verify-failed)`,
      );
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "verify", verifyOutcome.details ?? "verification failed", {
        taskId: task.id,
        checks: verifyOutcome.checks,
      });
      return {
        status: "failed",
        detail: "verification failed",
        output,
        sessionId,
        attempt: 1,
        errorEnvelope: { outcome: "failed", summary: verifyOutcome.details ?? "verification failed", chain, agentOutput: output },
        agentInvoked: true,
      };
    }

    return null;
  }

  /**
   * Every terminal except finished(done): finished(blocked) is `blocked`; a cell that failed under
   * the attempt is environment-blocked (the operator's to fix); every other terminal is `failed`
   * with the terminal named. None of them is ever read as completed.
   */
  private async endWithoutDone(d: Dispatch, outcome: Outcome, output: AgentOutputJson): Promise<ExecutionResult> {
    const { task, staff, workDir, targetProjectPath, sessionId } = d;
    await commitPartialWork(
      d.repo,
      `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, ${outcome.kind})`,
    );
    await cleanupWorkdir(workDir, targetProjectPath);

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
      const errorClass = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error;
      const typed = environmentErrorOf(outcome.error);
      const unavailable = outcome.source === "records" ? "attempt records" : typed !== null ? unavailableOf(typed, "task cell") : "task cell";
      return environmentBlocked(
        {
          taskId: task.id,
          sessionId,
          stage: "agentAttempt",
          errorClass,
          message: `the attempt's environment failed (${outcome.source}) after ${outcome.turnsUsed} turn(s): ${outcome.detail}`,
          chain: wrapError("development", "agentAttempt", outcome.error, { ...context, source: outcome.source, errorClass }),
          unavailable,
          output,
          agentInvoked: true,
        },
        this.deps.eventSink,
      );
    }

    if (outcome.kind === "finished") {
      const chain = wrapError("development", "agentAttempt", outcome.blockedReason ?? outcome.summary, context);
      const envelope: ErrorEnvelope = {
        outcome: "blocked",
        summary: `agent reported blocked after ${outcome.turnsUsed} turns: ${output.summary}`,
        chain,
        agentOutput: output,
      };
      return {
        status: "blocked",
        detail: envelope.summary,
        output,
        sessionId,
        attempt: 1,
        errorEnvelope: envelope,
        agentInvoked: true,
      };
    }

    const cause = outcome.kind === "transport_exhausted" ? outcome.error : outcome.kind === "cancelled" ? outcome.reason : outcome.detail;
    const chain = wrapError("development", "agentAttempt", cause, context);
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: `attempt ended as ${outcome.kind} after ${outcome.turnsUsed} turn(s) on ${staff.model.provider}/${staff.model.modelId}: ${outcome.detail}`,
      chain,
      agentOutput: output,
    };
    return {
      status: "failed",
      detail: envelope.summary,
      output,
      sessionId,
      attempt: 1,
      errorEnvelope: envelope,
      agentInvoked: true,
    };
  }

  private async verifyTask(
    task: TaskDescriptor,
    workDir: string,
    runCommand: CommandRunner,
    attempt: number,
  ): Promise<VerifyTaskOutcome> {
    // Per-task verify uses only verify.toml; contract checks are
    // deferred to integration verify (they reference project-wide files that may
    // not exist in this task's worktree).
    try {
      const response = await runVerifyCore(
        { workDir, gitRoot: workDir, contractChecks: [] },
        {
          runCommand,
          log: (event) => this.deps.eventSink?.emit({
            ...event,
            event: typeof event["event"] === "string" ? event["event"] : "verify_log",
            taskId: task.id,
            attempt,
          }),
        },
      );
      console.log(
        `[${task.id}] verify: deterministic=${response.tiers.deterministic.status}, verdict=${response.verdict}`,
      );
      this.deps.eventSink?.emit({
        event: "verify_result",
        taskId: task.id,
        attempt,
        deterministic: response.tiers.deterministic.status,
        deterministicDetails: response.tiers.deterministic.details,
        deterministicChecks: response.tiers.deterministic.checks ?? [],
        verdict: response.verdict,
      });

      return {
        verdict: response.verdict,
        details: response.tiers.deterministic.details,
        checks: response.tiers.deterministic.checks?.map(c => ({ name: c.name, passed: c.passed, output: c.output })),
      };
    } catch (e) {
      // A substrate that could not run the checks says nothing about the work:
      // the caller blocks on the environment instead of failing the task.
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure !== null) return { verdict: "environment_failed", error: environmentFailure };
      // Discipline A: verification unreachable -> false, never true. The agent's
      // own finish summary is never a verification result.
      console.warn(
        `[${task.id}] verify failed, failing closed:`,
        e,
      );
      this.deps.eventSink?.emit({
        event: "error",
        location: "DevelopmentService:verifyTask",
        taskId: task.id,
        attempt,
        error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : String(e).slice(0, 500),
      });
      return { verdict: "failed", details: `verification could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
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
  body: () => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  const { sessionId, taskId } = session;
  await sessionStore.insert(sessionId, taskId, session.brief, session.environmentVersion);

  let outcome: ExecutionResult;
  try {
    outcome = await body();
  } catch (e) {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(sessionId, {
        passed: false,
        outcome: "errored",
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    throw e;
  }

  if (outcome.status === "completed") {
    await closeSession(taskId, sessionId, () => sessionStore.complete(sessionId));
  } else {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(sessionId, {
        passed: false,
        outcome: outcome.status,
        detail: outcome.detail,
        ...(outcome.errorEnvelope !== undefined ? { errorEnvelope: outcome.errorEnvelope } : {}),
      }),
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

