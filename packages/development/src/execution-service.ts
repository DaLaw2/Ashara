import path from "node:path";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type { WorkItemId, AgentBrief, ProjectContract, ErrorEnvelope, ErrorLayer, StoredTaskSpec, StoredBlockedReason } from "@ashara/shared";
import { ASHARA_CONTROL_DIR, createSessionId, createAgentBrief, nodeByKind, wrapError, errorEnvelopeSchema, renderChainForBrief, ProjectFrameUnresolvable } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { LLMGateway } from "@ashara/llm-gateway";
import type { Provisioner, ProvisionedEnv } from "./provisioner.js";
import { formatAcceptanceCriteria, formatTaskSpec, EMPTY_WORKDIR_CONTEXT_MAP } from "./brief-assembly.js";
import type { ProjectIntentSource, StackDeriver } from "./project-frame.js";
import { resolveProjectFrame } from "./project-frame.js";
import type { TaskSpec } from "./types.js";
import { finalizeSuccess } from "./gates/finalize.js";
import { readVerifyConfig } from "./verify-config.js";
import { runVerifyCore } from "./verify-core.js";
import type { CommandRunner } from "./verify-core.js";
import { defaultRunCommand } from "./check-runner.js";
import { readManifestContext } from "./dispatch-utils.js";
import { deriveEnvironmentSpec } from "./env-spec-derivation.js";
import {
  buildFileTree,
  cleanupWorkdir,
  commitPartialWork,
  createWorkdir,
  createWorkdirForRetry,
  getChangedFiles,
  persistConversationRecord,
} from "./workspace.js";
import { branchExists, taskBranchName } from "./merge.js";
import type { KnowledgeSink, KnowledgeScope, KnowledgeSource } from "./knowledge-writer.js";
import { buildKnowledgeQueryText, storeFailureKnowledge, storeKnowledge } from "./knowledge-writer.js";

// ---------------------------------------------------------------------------
// Provisioner → CommandRunner bridge
// ---------------------------------------------------------------------------

function provisionerAsRunner(provisioner: Provisioner, env: ProvisionedEnv, hostMountRoot: string): CommandRunner {
  const containerMount = env.spec.projectMount;
  return async (command: string[], cwd: string, timeout: number) => {
    const rel = path.relative(hostMountRoot, cwd);
    const containerCwd = rel && !rel.startsWith("..") ? path.posix.join(containerMount, rel) : containerMount;
    const result = await provisioner.execute(env, command, { timeout, cwd: containerCwd });
    return { exitCode: result.exitCode ?? 1, output: (result.stdout + result.stderr).trim() };
  };
}

// ---------------------------------------------------------------------------
// Injected dependency interfaces
// ---------------------------------------------------------------------------

export interface SessionStore {
  insert(sessionId: string, taskId: string, brief: unknown): Promise<void>;
  complete(sessionId: string): Promise<void>;
  fail(sessionId: string, verificationResult: unknown): Promise<void>;
}

export interface AgentInvoker {
  spawn(opts: AgentSpawnOptions): Promise<AgentOutputJson>;
}

export interface AgentSpawnOptions {
  readonly workDir: string;
  readonly briefPath: string;
  readonly outputPath: string;
  readonly taskId: string;
  readonly dispatchCount: number;
  readonly blockedReason?: StoredBlockedReason;
}

export interface ExecutionEventSink {
  // open-by-design: log events carry caller-defined fields alongside the required `event` tag
  emit(event: Record<string, unknown> & { readonly event: string }): void;
}

// ---------------------------------------------------------------------------
// Configuration (subset relevant to execution)
// ---------------------------------------------------------------------------

export interface DevelopmentConfig {
  readonly workdirBase: string;
}

// ---------------------------------------------------------------------------
// Task descriptor (minimal — no WorkItem aggregate dependency)
// ---------------------------------------------------------------------------

export interface TaskDescriptor {
  readonly id: WorkItemId;
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

export interface ExecutionResult {
  readonly status: "completed" | "failed" | "blocked";
  readonly detail: string;
  readonly output: AgentOutputJson | null;
  readonly sessionId: string;
  /**
   * Always 1 — execute() makes exactly one agent invocation per call. Retrying a
   * failed task is the orchestrator's FailureRouter's job (re-dispatch, tracked via
   * WorkItem.dispatchCount), not this service's. Kept as a field (rather than
   * removed) because it still flows into TaskCostInfo.attempt and the
   * task_cost_history.attempt column downstream.
   */
  readonly attempt: number;
  readonly errorEnvelope?: ErrorEnvelope;
  /**
   * Whether the agent subprocess was actually launched for this dispatch. The
   * budget reads it to tell "no agent ran, therefore $0" apart from "an agent ran
   * and we cannot tell what it cost" — the second must never be charged as $0
   * (Discipline A: an evidence default in a number that gates dispatch).
   */
  readonly agentInvoked: boolean;
}

/**
 * Mutable across the runExecution call so the outer catch can still report
 * whether the agent had been launched when the throw happened. A thrown
 * AgentSpawnError — the runner crashed after burning tokens — is exactly the
 * case where `agentInvoked` must survive the stack unwind.
 */
interface DispatchRecord {
  agentInvoked: boolean;
}

interface VerifyTaskOutcome {
  readonly verdict: "passed" | "failed" | "unverified";
  readonly details?: string;
  readonly checks?: ReadonlyArray<{ name: string; passed: boolean; output?: string }>;
}

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
  readonly agentInvoker: AgentInvoker;
  readonly llmGateway: LLMGateway | null;
  readonly eventSink?: ExecutionEventSink;
  /**
   * Supplies the owner's own vision text for a task's project (ADR-046). Absent ⇒
   * the frame ladder has no intent and every dispatch blocks — deliberately: a
   * brief with an invented intent is the failure this port exists to prevent.
   */
  readonly intentSource?: ProjectIntentSource;
  /**
   * Last-resort stack derivation from the vision prose, used only until the
   * project has a scaffold or a contract knowledge graph to read instead.
   */
  readonly stackDeriver?: StackDeriver;
  /**
   * Yields the ProjectContract for a task's project; its knowledge graph feeds
   * the project frame ladder and the entry-point context. Absent (or a null
   * result) means the project has no contract.
   */
  readonly contractSource?: ContractSource;
  readonly provisioner?: Provisioner;
  readonly provisionedEnv?: ProvisionedEnv;
}

export class DevelopmentService {
  private readonly deps: DevelopmentServiceDeps;

  constructor(deps: DevelopmentServiceDeps) {
    this.deps = deps;
  }

  private buildRunners(env?: ProvisionedEnv): { runCommand: CommandRunner; prepareRunCommand: CommandRunner } {
    if (this.deps.provisioner && env) {
      const runner = provisionerAsRunner(this.deps.provisioner, env, this.deps.config.workdirBase);
      return { runCommand: runner, prepareRunCommand: runner };
    }
    return {
      runCommand: defaultRunCommand,
      prepareRunCommand: defaultRunCommand,
    };
  }

  async execute(
    task: TaskDescriptor,
    targetProjectPath: string | null,
  ): Promise<ExecutionResult> {
    const { config, eventSink } = this.deps;
    const sessionId = createSessionId();
    const base = config.workdirBase;

    eventSink?.emit({
      event: "task_started",
      taskId: task.id,
      goal: task.taskSpec?.goal ?? task.title,
      model: task.taskSpec?.capability ?? "Strong",
    });

    let contract: ProjectContract | null = null;
    try {
      contract = await this.loadContract(task.id);
    } catch (e) {
      console.warn(`[${task.id}] contract load failed; dispatching without contract context:`, e);
    }

    let brief: AgentBrief;
    try {
      brief = await this.buildBrief(task, targetProjectPath, contract);
    } catch (e) {
      // A missing ProjectFrame is a PLANNING-INPUT gap, not an agent failure
      // (ADR-046): nothing about re-dispatching the same task makes the vision
      // reachable, so routing it as a retryable failure would loop forever.
      // Blocked parks it for the owner with the full derivation trace intact.
      if (!(e instanceof ProjectFrameUnresolvable)) throw e;
      const chain = wrapError("development", "resolveProjectFrame", e, { taskId: task.id });
      const envelope: ErrorEnvelope = {
        outcome: "blocked",
        summary: `project frame unresolvable for ${task.id}: ${chain.message}`,
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

    let workDir: string;
    if (targetProjectPath) {
      const branch = taskBranchName(task.id);
      const isRetry = await branchExists(targetProjectPath, branch);
      try {
        if (isRetry) {
          ({ workDir } = await createWorkdirForRetry(base, targetProjectPath, branch));
        } else {
          ({ workDir } = await createWorkdir(base, targetProjectPath, branch));
        }
      } catch (e) {
        const chain = wrapError("development", "createWorkdir", e, { taskId: task.id });
        eventSink?.emit({
          event: "error",
          location: "DevelopmentService:createWorkdir",
          taskId: task.id,
          attempt: 1,
          error: chain.message,
        });
        const envelope: ErrorEnvelope = {
          outcome: "failed",
          summary: `workdir creation failed for ${task.id}: ${chain.message}`,
          chain,
        };
        const result: ExecutionResult = {
          status: "failed",
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
    } else {
      const { mkdtemp } = await import("node:fs/promises");
      workDir = await mkdtemp(join(base, "task-"));
    }

    let localEnv: ProvisionedEnv | undefined;
    const preSuppliedEnv = this.deps.provisionedEnv;
    if (!preSuppliedEnv && this.deps.provisioner && this.deps.llmGateway && targetProjectPath) {
      try {
        const manifestContent = await readManifestContext(targetProjectPath);
        if (manifestContent) {
          const spec = await deriveEnvironmentSpec(manifestContent, this.deps.llmGateway);
          localEnv = await this.deps.provisioner.provision(spec);
        }
      } catch (e) {
        console.warn(`[${task.id}] environment provisioning failed, falling back to containerized execution:`, e);
      }
    }
    const envForRunners = preSuppliedEnv ?? localEnv;

    const dispatch: DispatchRecord = { agentInvoked: false };

    try {
      const result = await withSessionLifecycle(this.deps.sessionStore, sessionId, task.id, brief, () =>
        this.runExecution(task, brief, targetProjectPath, workDir, sessionId, contract, dispatch, envForRunners),
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
      await persistConversationRecord(workDir, task.id, base, dispatch.agentInvoked ? "agent-ran" : "pre-launch");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
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
        agentInvoked: dispatch.agentInvoked,
      };
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    } finally {
      if (localEnv && this.deps.provisioner) {
        try {
          await this.deps.provisioner.teardown(localEnv);
        } catch (e) {
          console.warn(`[${task.id}] environment teardown failed:`, e);
        }
      }
    }
  }

  private async buildBrief(
    task: TaskDescriptor,
    targetProjectPath: string | null,
    contract: ProjectContract | null,
  ): Promise<AgentBrief> {
    const taskSpec = task.taskSpec;

    const replanContext = extractReplanContext(task.id, task.blockedReason);
    const priorAttemptFailure = replanContext ? formatPriorAttemptFailure(replanContext) : undefined;

    // A ProjectFrameUnresolvable propagates to execute() and blocks the task: a
    // brief with no stated target is the fail-open this ladder replaces (ADR-046).
    const projectFrame = await resolveProjectFrame({
      taskId: task.id,
      contract,
      targetProjectPath,
      intentSource: this.deps.intentSource,
      stackDeriver: this.deps.stackDeriver,
    });

    const spec: TaskSpec = {
      goal: (typeof taskSpec?.goal === "string" ? taskSpec.goal : task.title),
      endState: (typeof taskSpec?.endState === "string" ? taskSpec.endState : `Implement: ${task.title}`),
      scope: (typeof taskSpec?.scope === "string" ? taskSpec.scope : ""),
      deliverables: stringArrayOrEmpty(taskSpec?.deliverables),
      // POLICY default: empty checks → verify-core.ts:320 verdict "unverified" → line 823 routes as "failed".
      checks: stringArrayOrEmpty(taskSpec?.checks),
    };

    const contractEntryPoint = contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null;
    const contextMap = await this.buildContextMap(targetProjectPath, contractEntryPoint ?? undefined);
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
        projectFrame,
        context: taskContext,
        tools: ["read_file", "write_file", "edit_file", "run_command", "search_codebase", "list_directory"],
        constraints: spec.checks,
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

  /**
   * Renders what can be OBSERVED about the target tree. An empty tree returns an
   * explicit statement of that emptiness rather than "" (ADR-046): "" renders as
   * no context section at all, which the agent cannot distinguish from a normal
   * project whose context happened to be omitted — so it proceeds on its prior.
   * Saying the directory is empty is what makes the frame the only thing known.
   */
  private async buildContextMap(
    targetProjectPath: string | null,
    contractEntryPointPath?: string,
  ): Promise<string> {
    if (!targetProjectPath) return EMPTY_WORKDIR_CONTEXT_MAP;

    const sections: string[] = ["# Project Context"];

    try {
      const tree = await buildFileTree(targetProjectPath, 4, 200);
      if (tree) {
        sections.push("## File Tree\n" + tree);
      }
    } catch (e: unknown) {
      console.warn(`[buildContextMap] Failed to build file tree for ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    let hasNodeManifest = false;
    try {
      const pkgPath = join(targetProjectPath, "package.json");
      const pkgContent = await readFile(pkgPath, "utf-8");
      hasNodeManifest = true;
      // contract-erasing: package.json has a well-known shape (npm spec)
      const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
      // contract-erasing: dependencies/devDependencies are Record<string, string>
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      const devDeps = pkg.devDependencies as Record<string, unknown> | undefined; // contract-erasing
      const depsStr = deps ? Object.keys(deps).join(", ") : "";
      const devDepsStr = devDeps ? Object.keys(devDeps).join(", ") : "";
      if (depsStr || devDepsStr) {
        const depLines = ["## Dependencies"];
        if (depsStr) depLines.push(`Runtime: ${depsStr}`);
        if (devDepsStr) depLines.push(`Dev: ${devDepsStr}`);
        sections.push(depLines.join("\n"));
      }
    } catch (e: unknown) {
      console.warn(`[buildContextMap] Failed to read package.json in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Target-generality fallback (kl-t2/Q5 gap): package.json is Node-specific.
    // readManifestContext reads ALL non-dot, non-binary root-level files —
    // no hardcoded manifest list (Target Generality).
    if (!hasNodeManifest) {
      try {
        const manifestContent = await readManifestContext(targetProjectPath);
        if (manifestContent) {
          sections.push(`## Project Manifests\n${manifestContent}`);
        }
      } catch (e: unknown) {
        console.warn(`[buildContextMap] Failed to read manifests in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (contractEntryPointPath) {
      try {
        const content = await readFile(join(targetProjectPath, contractEntryPointPath), "utf-8");
        const head = content.split("\n").slice(0, 50).join("\n");
        sections.push(`## Entry Point (${contractEntryPointPath})\n\`\`\`\n${head}\n\`\`\``);
      } catch (e: unknown) {
        console.warn(`[buildContextMap] Failed to read entry point ${contractEntryPointPath} in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      const verifyConfig = await readVerifyConfig(targetProjectPath);
      if (verifyConfig.checks.length > 0) {
        const lines = ["## Verification Checks (verify.toml)"];
        for (const check of verifyConfig.checks) {
          lines.push(`- ${check.name}: \`${check.command}\``);
        }
        sections.push(lines.join("\n"));
      }
    } catch (e: unknown) {
      console.warn(`[buildContextMap] Failed to read verify.toml in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    return sections.length > 1 ? sections.join("\n\n") : EMPTY_WORKDIR_CONTEXT_MAP;
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

  private async runExecution(
    task: TaskDescriptor,
    brief: AgentBrief,
    targetProjectPath: string | null,
    workDir: string,
    sessionId: string,
    contract: ProjectContract | null,
    dispatch: DispatchRecord,
    provisionedEnv?: ProvisionedEnv,
  ): Promise<ExecutionResult> {
    const { config, eventSink, agentInvoker } = this.deps;
    const recordsBase = config.workdirBase;

    const asharaDir = join(workDir, ASHARA_CONTROL_DIR);
    await mkdir(asharaDir, { recursive: true });

    const briefPath = join(asharaDir, "brief.json");
    const outputPath = join(asharaDir, "output.json");
    await writeFile(briefPath, JSON.stringify(brief, null, 2));

    eventSink?.emit({
      event: "agent_launched",
      taskId: task.id,
      attempt: 1,
      workDir,
      briefPath,
    });

    dispatch.agentInvoked = true;
    const output: AgentOutputJson = await agentInvoker.spawn({ workDir, briefPath, outputPath, taskId: task.id, dispatchCount: task.dispatchCount, blockedReason: task.blockedReason });

    const agentStatus = output.status;

    if (agentStatus === "failed") {
      const { summary, turn_count: turnCount, finish_reason: finishReason } = output;
      // Observe the workdir BEFORE cleanup — after cleanupWorkdir the
      // worktree is gone and git status would fail.
      const filesChanged = await getChangedFiles(workDir);
      eventSink?.emit({
        event: "agent_completed",
        taskId: task.id,
        attempt: 1,
        status: "failed",
        turns: turnCount,
        summary,
        filesChanged,
      });
      if (targetProjectPath) {
        await commitPartialWork(
          workDir,
          `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, agent-failed)`,
        );
      }
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", summary, {
        taskId: task.id,
        turnCount,
        finishReason,
      });
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `agent reported failure after ${turnCount} turns: ${summary}`,
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

    if (agentStatus === "blocked") {
      const { summary, turn_count: turnCount } = output;
      // Observe the workdir BEFORE cleanup — after cleanupWorkdir the
      // worktree is gone and git status would fail.
      const filesChanged = await getChangedFiles(workDir);
      eventSink?.emit({
        event: "agent_completed",
        taskId: task.id,
        attempt: 1,
        status: "blocked",
        turns: turnCount,
        summary,
        filesChanged,
      });
      if (targetProjectPath) {
        await commitPartialWork(
          workDir,
          `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, agent-blocked)`,
        );
      }
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", summary, {
        taskId: task.id,
        turnCount,
      });
      const envelope: ErrorEnvelope = {
        outcome: "blocked",
        summary: `agent reported blocked after ${turnCount} turns: ${summary}`,
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

    const changedCount = (await getChangedFiles(workDir)).length;
    if (changedCount === 0) {
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "agent produced no file changes",
      });
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", "agent produced no file changes", {
        taskId: task.id,
        turnCount: output.turn_count,
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

    const filesChanged = await getChangedFiles(workDir);
    eventSink?.emit({
      event: "agent_completed",
      taskId: task.id,
      attempt: 1,
      status: "done",
      turns: output.turn_count,
      cost: output.total_cost,
      filesChanged,
    });

    eventSink?.emit({ event: "verify_started", taskId: task.id, attempt: 1, workDir });
    const verifyOutcome = await this.verifyTask(task, workDir, output, 1, contract, provisionedEnv);

    if (verifyOutcome.verdict === "unverified") {
      // Zero executable checks: a verdict computed from nothing must not read
      // as success (Discipline A). The orchestrator commits this as Failed and
      // routes it through the FailureRouter to replan-or-abandon — same path
      // as a failed verification, bounded by the replan limit.
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "verification unverified — no executable checks",
      });
      if (targetProjectPath) {
        await commitPartialWork(
          workDir,
          `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, verify-unverified)`,
        );
      }
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
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
      if (targetProjectPath) {
        await commitPartialWork(
          workDir,
          `ashara: partial work for retry (task ${task.id}, dispatch ${task.dispatchCount}, verify-failed)`,
        );
      }
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
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

    // Per-task verify uses only verify.toml; contract and taskSpec checks are
    // deferred to integration verify (they reference project-wide files that may
    // not exist in this task's worktree).
    const finalizeDeps = {
      ...this.deps,
      ...this.buildRunners(provisionedEnv),
    };
    const finalizeResult = await finalizeSuccess(finalizeDeps, workDir, task, targetProjectPath, 1, {
      entryPointPath: contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null,
    });
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
      await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
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

    await persistConversationRecord(workDir, task.id, recordsBase, "agent-ran");
    await cleanupWorkdir(workDir, targetProjectPath ?? undefined, targetProjectPath ? taskBranchName(task.id) : undefined);
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

  private async verifyTask(
    task: TaskDescriptor,
    workDir: string,
    _output: AgentOutputJson,
    attempt: number,
    _contract: ProjectContract | null,
    provisionedEnv?: ProvisionedEnv,
  ): Promise<VerifyTaskOutcome> {
    // Per-task verify uses only verify.toml; contract and taskSpec checks are
    // deferred to integration verify (they reference project-wide files that may
    // not exist in this task's worktree).
    try {
      const { runCommand, prepareRunCommand } = this.buildRunners(provisionedEnv);
      const response = await runVerifyCore(
        { workDir, gitRoot: workDir, checks: [], contractChecks: [] },
        {
          runCommand,
          prepareRunCommand,
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
      // Discipline A: verification unreachable -> false, never true. The agent's
      // own self-reported verify result is not part of the AgentOutputJson contract
      // (the field never existed in the schema) and was always discarded — trusting
      // it when real verification errored lets an optimistic/dishonest agent grade
      // itself (Run 9 readiness review X1).
      console.warn(
        `[${task.id}] verify failed, failing closed:`,
        e,
      );
      this.deps.eventSink?.emit({
        event: "error",
        location: "DevelopmentService:verifyTask",
        taskId: task.id,
        attempt,
        error: String(e).slice(0, 500),
      });
      return { verdict: "failed" };
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
 */
export async function withSessionLifecycle(
  sessionStore: SessionStore,
  sessionId: string,
  taskId: string,
  brief: AgentBrief,
  body: () => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  await sessionStore.insert(sessionId, taskId, brief);

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

