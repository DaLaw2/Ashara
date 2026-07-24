import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { WorkItemId, AgentBrief, ProjectContract, ErrorEnvelope, ErrorLayer } from "@ashara/shared";
import { createSessionId, parseAgentBrief, nodeByKind, nodeLabel, wrapError, errorEnvelopeSchema, renderChainForBrief, flattenChain } from "@ashara/shared";
import type { LLMGateway } from "@ashara/llm-gateway";
import type { RetrievalResult } from "@ashara/memory";
import type { VerifyLogOptions } from "./verify.js";
import { verify } from "./verify.js";
import type { ProjectProfile } from "./brief-assembly.js";
import { buildBriefWithRetry } from "./brief-assembly.js";
import type { ContractSource } from "./contract-slice.js";
import { formatContractSlice } from "./contract-slice.js";
import type { ContractAmender } from "./contract-completion.js";
import { selectModulePaths } from "./contract-completion.js";
import { deriveEndpoints } from "./gates/endpoints.js";
import type { TaskSpec } from "./types.js";
import { finalizeSuccess } from "./gates/finalize.js";
import { readVerifyConfig } from "./verify-config.js";
import {
  buildFileTree,
  cleanupWorkdir,
  createWorkdir,
  createWorkdirForRetry,
  getChangedFiles,
} from "./workspace.js";
import { branchExists, taskBranchName } from "./merge.js";
import type { KnowledgeSink, KnowledgeScope, KnowledgeSource } from "./knowledge-writer.js";
import { buildKnowledgeQueryText, storeFailureKnowledge, storeKnowledge } from "./knowledge-writer.js";

// ---------------------------------------------------------------------------
// Injected dependency interfaces
// ---------------------------------------------------------------------------

export interface SessionStore {
  insert(sessionId: string, taskId: string, brief: unknown): Promise<void>;
  complete(sessionId: string): Promise<void>;
  fail(sessionId: string, verificationResult: unknown): Promise<void>;
}

export interface AgentInvoker {
  spawn(opts: AgentSpawnOptions): Promise<Record<string, unknown>>;
}

export interface AgentSpawnOptions {
  readonly workDir: string;
  readonly briefPath: string;
  readonly outputPath: string;
  readonly taskId: string;
  readonly dispatchCount?: number;
  readonly blockedReason?: Record<string, unknown>;
}

export interface ConventionsExtractor {
  extract(workDir: string): Promise<string | null>;
}

export interface ExecutionEventSink {
  emit(event: Record<string, unknown> & { readonly event: string }): void;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Configuration (subset relevant to execution)
// ---------------------------------------------------------------------------

export interface DevelopmentConfig {
  readonly workdirBase: string;
  readonly useRealAgent: boolean;
}

// ---------------------------------------------------------------------------
// Task descriptor (minimal — no WorkItem aggregate dependency)
// ---------------------------------------------------------------------------

export interface TaskDescriptor {
  readonly id: WorkItemId;
  readonly title: string;
  readonly parentId?: string;
  readonly taskSpec?: Record<string, unknown>;
  /** WorkItem.blockedReason, carried through so a replanned attempt can see why the prior attempt failed. */
  readonly blockedReason?: Record<string, unknown>;
  /**
   * The task's true Epic ancestor id, walked up by the orchestrator (which owns
   * the WorkItem hierarchy) before constructing this descriptor — @ashara/development
   * has no dependency on @ashara/planning to walk it itself (kl-t2/Q5). `null`
   * means the walk ran and found no Epic ancestor; `undefined` (callers that don't
   * set it, e.g. unit tests) falls back to `parentId` at the write site below.
   */
  readonly epicId?: string | null;
  readonly dispatchCount?: number;
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly status: "completed" | "failed" | "blocked";
  readonly detail: string;
  readonly output: Record<string, unknown>;
  readonly sessionId: string;
  readonly filesChanged: string[];
  /**
   * Always 1 — execute() makes exactly one agent invocation per call. Retrying a
   * failed task is the orchestrator's FailureRouter's job (re-dispatch, tracked via
   * WorkItem.dispatchCount), not this service's. Kept as a field (rather than
   * removed) because it still flows into TaskCostInfo.attempt and the
   * task_cost_history.attempt column downstream.
   */
  readonly attempt: number;
  readonly errorEnvelope?: ErrorEnvelope;
}

interface VerifyTaskOutcome {
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// DevelopmentService
// ---------------------------------------------------------------------------

export interface DevelopmentServiceDeps {
  readonly config: DevelopmentConfig;
  readonly sessionStore: SessionStore;
  readonly knowledgeSink: KnowledgeSink;
  readonly knowledgeSource?: KnowledgeSource;
  readonly agentInvoker: AgentInvoker;
  readonly conventionsExtractor: ConventionsExtractor;
  readonly llmGateway: LLMGateway | null;
  readonly projectProfile: ProjectProfile;
  readonly retrieveFn: (query: string, mentionedSymbols?: string[]) => Promise<RetrievalResult[]>;
  readonly eventSink?: ExecutionEventSink;
  /**
   * Yields the ProjectContract for a task's project so the brief can carry a
   * task-relevant slice — reuse-only modules, endpoints to expose, wiring to
   * preserve (mig-phase-9 t3). Optional: absent (or null result) leaves the brief
   * unchanged, exactly as before contracts existed.
   */
  readonly contractSource?: ContractSource;
  /**
   * Records a completed task's actual deliverables (mounted endpoints, created
   * modules) onto the project contract via the amend protocol (mig9-t4). Optional
   * and applied fail-soft — a contract-less project or an amend failure never
   * un-completes a task that passed its gates.
   */
  readonly contractAmender?: ContractAmender;
  readonly populateIndex?: (targetPath: string) => void;
}

export class DevelopmentService {
  private readonly deps: DevelopmentServiceDeps;
  private indexed = false;

  constructor(deps: DevelopmentServiceDeps) {
    this.deps = deps;
  }

  async execute(
    task: TaskDescriptor,
    targetProjectPath: string | null,
  ): Promise<ExecutionResult> {
    const { config, eventSink } = this.deps;
    const sessionId = createSessionId();
    const base = config.workdirBase || join(tmpdir(), "ashara-work");

    eventSink?.emit({
      event: "task_started",
      taskId: task.id,
      goal: task.taskSpec?.goal ?? task.title,
      model: task.taskSpec?.capability ?? "Strong",
    });

    const contract = await this.loadContract(task.id);
    const brief = await this.buildBrief(task, targetProjectPath, contract);

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
          output: {},
          sessionId,
          filesChanged: [],
          attempt: 1,
          errorEnvelope: envelope,
        };
        await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
        return result;
      }
    } else {
      const { mkdtemp } = await import("node:fs/promises");
      workDir = await mkdtemp(join(base, "task-"));
    }

    try {
      const result = await this.runExecution(task, brief, targetProjectPath, workDir, sessionId, contract);
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
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const envelope: ErrorEnvelope = {
        outcome: "failed",
        summary: `execution error for ${task.id}: ${chain.message}`,
        chain,
      };
      const result: ExecutionResult = {
        status: "failed",
        detail: envelope.summary,
        output: {},
        sessionId,
        filesChanged: [],
        attempt: 1,
        errorEnvelope: envelope,
      };
      await storeFailureKnowledge(this.deps.knowledgeSink, task, result);
      return result;
    }
  }

  private async buildBrief(
    task: TaskDescriptor,
    targetProjectPath: string | null,
    contract: ProjectContract | null,
  ): Promise<AgentBrief> {
    const { projectProfile, retrieveFn } = this.deps;
    const taskSpec = task.taskSpec;

    const replanContext = extractReplanContext(task.id, task.blockedReason);
    const priorAttemptFailure = replanContext ? formatPriorAttemptFailure(replanContext) : undefined;

    const contractSlice = contract ? await this.renderContractSlice(contract, task.id) : undefined;

    const spec: TaskSpec = {
      goal: (typeof taskSpec?.goal === "string" ? taskSpec.goal : task.title),
      endState: (typeof taskSpec?.endState === "string" ? taskSpec.endState : `Implement: ${task.title}`),
      scope: (typeof taskSpec?.scope === "string" ? taskSpec.scope : ""),
      deliverables: stringArrayOrEmpty(taskSpec?.deliverables),
      checks: stringArrayOrEmpty(taskSpec?.checks),
    };

    const contractEntryPoint = contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null;
    const contextMap = await this.buildContextMap(targetProjectPath, contractEntryPoint ?? undefined, contract?.excludePaths);
    const knowledgeContext = await this.buildKnowledgeContext(task, spec);

    try {
      const { brief } = await buildBriefWithRetry(
        spec,
        projectProfile,
        retrieveFn,
        {},
        contextMap,
        knowledgeContext,
      );
      // parseAgentBrief validates the on-wire shape at the producing boundary:
      // a field this seam is meant to carry (codeContext / knowledgeContext /
      // contextMap — the finding-g drop) is now explicit and validated, and an
      // unexpected extra field fails closed here rather than leaking silently.
      return parseAgentBrief(
        {
          taskId: task.id,
          goal: spec.goal,
          context: brief.taskSpec,
          tools: ["read_file", "write_file", "edit_file", "run_command", "search_codebase", "list_directory"],
          constraints: spec.checks,
          deliverables: spec.deliverables,
          ...(taskSpec !== undefined ? { task_spec: taskSpec } : {}),
          codeContext: brief.codeContext,
          knowledgeContext: brief.knowledgeContext,
          contextMap: brief.contextMap,
          ...(priorAttemptFailure !== undefined ? { priorAttemptFailure } : {}),
          ...(contractSlice !== undefined ? { contractSlice } : {}),
        },
        "development:buildBrief",
      );
    } catch (e) {
      console.warn(`[${task.id}] brief assembly failed, falling back to basic brief:`, e);
      return buildBasicBrief(task, priorAttemptFailure, contractSlice);
    }
  }

  /**
   * Loads this task's ProjectContract via the injected port. Returns null when no
   * contract source is wired, the project has no contract, or the load fails — so
   * both the contract slice and the entry-point resolution below share ONE fetch
   * and ONE fail-soft path (a port error never blocks dispatch; the contract is
   * advisory context, not a gate).
   */
  private async loadContract(taskId: string): Promise<ProjectContract | null> {
    const source = this.deps.contractSource;
    if (!source) return null;
    try {
      return await source.loadForTask(taskId);
    } catch (e) {
      console.warn(`[${taskId}] contract load failed; proceeding without it:`, e);
      return null;
    }
  }

  /**
   * Renders the brief slice for an already-loaded contract. Returns undefined
   * when the contract has nothing to say to this task, so the brief is left
   * byte-identical in every contract-less case.
   */
  private async renderContractSlice(contract: ProjectContract, taskId: string): Promise<string | undefined> {
    try {
      const siblingDeclarers = [
        ...new Set(
          contract.endpoints
            .map((e) => e.declaredBy)
            .filter((id): id is string => id !== undefined && id !== taskId),
        ),
      ];
      const completedTaskIds =
        siblingDeclarers.length > 0
          ? await this.deps.contractSource?.loadCompletedTaskIds?.(siblingDeclarers)
          : undefined;
      return formatContractSlice(contract, taskId, completedTaskIds);
    } catch (e) {
      console.warn(`[${taskId}] contract slice render failed; proceeding without it:`, e);
      return undefined;
    }
  }

  private async buildContextMap(targetProjectPath: string | null, contractEntryPointPath?: string, contractExcludePaths?: readonly string[]): Promise<string> {
    if (!targetProjectPath) return "";

    const sections: string[] = ["# Project Context"];

    try {
      const tree = await buildFileTree(targetProjectPath, 4, 200, contractExcludePaths);
      if (tree) sections.push("## File Tree\n" + tree);
    } catch {
      // target project may not exist yet
    }

    let hasNodeManifest = false;
    try {
      const pkgPath = join(targetProjectPath, "package.json");
      const pkgContent = await readFile(pkgPath, "utf-8");
      hasNodeManifest = true;
      const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
      const depsStr = deps ? Object.keys(deps).join(", ") : "";
      const devDepsStr = devDeps ? Object.keys(devDeps).join(", ") : "";
      if (depsStr || devDepsStr) {
        const depLines = ["## Dependencies"];
        if (depsStr) depLines.push(`Runtime: ${depsStr}`);
        if (devDepsStr) depLines.push(`Dev: ${devDepsStr}`);
        sections.push(depLines.join("\n"));
      }
    } catch {
      // no package.json
    }

    // Target-generality fallback (kl-t2/Q5 gap): package.json is Node-specific.
    // A Rust/Go/Python target has no dependency manifest visible to the agent at
    // all otherwise — this reads whichever one is present, raw, the same way the
    // entry point below is read raw.
    if (!hasNodeManifest) {
      try {
        for (const manifest of ["Cargo.toml", "go.mod", "pyproject.toml"]) {
          try {
            const content = await readFile(join(targetProjectPath, manifest), "utf-8");
            sections.push(`## Project Manifest (${manifest})\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
            break;
          } catch {
            continue;
          }
        }
      } catch {
        // no non-Node manifest found
      }
    }

    if (contractEntryPointPath) {
      try {
        const content = await readFile(join(targetProjectPath, contractEntryPointPath), "utf-8");
        const head = content.split("\n").slice(0, 50).join("\n");
        sections.push(`## Entry Point (${contractEntryPointPath})\n\`\`\`\n${head}\n\`\`\``);
      } catch {
        // contract entry point does not exist yet
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
    } catch {
      // no verify.toml or parse error
    }

    try {
      const conventions = await this.deps.conventionsExtractor.extract(targetProjectPath);
      if (conventions) sections.push("## Conventions\n" + conventions);
    } catch {
      // conventions extraction failed
    }

    return sections.length > 1 ? sections.join("\n\n") : "";
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
    } catch {
      // knowledge retrieval failed
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
    } catch {
      // failed approach retrieval failed
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
  ): Promise<ExecutionResult> {
    const { config, eventSink, sessionStore, agentInvoker } = this.deps;

    const asharaDir = join(workDir, ".ashara");
    await mkdir(asharaDir, { recursive: true });

    const briefPath = join(asharaDir, "brief.json");
    const outputPath = join(asharaDir, "output.json");
    await writeFile(briefPath, JSON.stringify(brief, null, 2));

    await sessionStore.insert(sessionId, task.id, brief);

    eventSink?.emit({
      event: "agent_launched",
      taskId: task.id,
      attempt: 1,
      workDir,
      briefPath,
    });

    let output: Record<string, unknown>;

    if (config.useRealAgent) {
      output = await agentInvoker.spawn({ workDir, briefPath, outputPath, taskId: task.id, dispatchCount: task.dispatchCount, blockedReason: task.blockedReason });
    } else {
      output = stubAgentOutput();
      await writeFile(outputPath, JSON.stringify(output, null, 2));
      console.log(`[${task.id}] agent execution stub — set useRealAgent to enable real execution`);
    }

    const agentStatus = typeof output.status === "string" ? output.status : "failed";

    if (agentStatus === "failed") {
      const summary = typeof output.summary === "string" ? output.summary : "no summary";
      const turnCount = typeof output.turn_count === "number" ? output.turn_count : 0;
      eventSink?.emit({
        event: "agent_completed",
        taskId: task.id,
        attempt: 1,
        status: "failed",
        turns: turnCount,
        summary,
      });
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", summary, {
        taskId: task.id,
        turnCount,
        finishReason: typeof output.finish_reason === "string" ? output.finish_reason : undefined,
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
        filesChanged: [],
        attempt: 1,
        errorEnvelope: envelope,
      };
    }

    if (agentStatus === "blocked") {
      const summary = typeof output.summary === "string" ? output.summary : "no summary";
      const turnCount = typeof output.turn_count === "number" ? output.turn_count : 0;
      eventSink?.emit({
        event: "agent_completed",
        taskId: task.id,
        attempt: 1,
        status: "blocked",
        turns: turnCount,
        summary,
      });
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
        filesChanged: [],
        attempt: 1,
        errorEnvelope: envelope,
      };
    }

    if (agentStatus === "stub") {
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", "stub agent output — skipping verify", { taskId: task.id });
      return {
        status: "failed",
        detail: "stub agent output — skipping verify",
        output,
        sessionId,
        filesChanged: [],
        attempt: 1,
        errorEnvelope: { outcome: "failed", summary: "stub agent output — skipping verify", chain, agentOutput: output },
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
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "agentExecution", "agent produced no file changes", {
        taskId: task.id,
        turnCount: typeof output.turn_count === "number" ? output.turn_count : undefined,
      });
      return {
        status: "failed",
        detail: "agent produced no file changes",
        output,
        sessionId,
        filesChanged: [],
        attempt: 1,
        errorEnvelope: { outcome: "failed", summary: "agent produced no file changes", chain, agentOutput: output },
      };
    }

    const filesChanged = await getChangedFiles(workDir);
    eventSink?.emit({
      event: "agent_completed",
      taskId: task.id,
      attempt: 1,
      status: "done",
      turns: typeof output.turn_count === "number" ? output.turn_count : null,
      cost: typeof output.total_cost === "number" ? output.total_cost : null,
      filesChanged,
    });

    eventSink?.emit({ event: "verify_started", taskId: task.id, attempt: 1, workDir });
    const verifyOutcome = await this.verifyTask(task, workDir, output, 1);

    if (!verifyOutcome.passed) {
      eventSink?.emit({
        event: "task_failed",
        taskId: task.id,
        attempt: 1,
        reason: "verification failed",
      });
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      const chain = wrapError("development", "verify", "verification failed", { taskId: task.id });
      return {
        status: "failed",
        detail: "verification failed",
        output,
        sessionId,
        filesChanged: [],
        attempt: 1,
        errorEnvelope: { outcome: "failed", summary: "verification failed", chain, agentOutput: output },
      };
    }

    const taskChecks = stringArrayOrEmpty(task.taskSpec?.checks);
    const finalizeResult = await finalizeSuccess(this.deps, workDir, sessionId, task, targetProjectPath, 1, taskChecks, {
      entryPointPath: contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null,
    });
    if (!finalizeResult.success) {
      const gateChain = finalizeResult.errorLayer
        ?? wrapError("development", "finalizeSuccess", finalizeResult.gateFailureContext ?? "unknown gate failure", { taskId: task.id });
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
      await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
      return {
        status: "failed",
        detail: envelope.summary,
        output,
        sessionId,
        filesChanged: [],
        attempt: 1,
        errorEnvelope: envelope,
      };
    }

    await cleanupWorkdir(workDir, targetProjectPath ?? undefined);
    await this.amendContractOnCompletion(task, targetProjectPath, filesChanged);
    this.tryPopulateIndex(targetProjectPath);
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: 1, result: "completed" });
    await storeKnowledge(this.deps.knowledgeSink, task, output);
    return {
      status: "completed",
      detail: "task completed and verified successfully",
      output,
      sessionId,
      filesChanged,
      attempt: 1,
    };
  }

  private async verifyTask(
    task: TaskDescriptor,
    workDir: string,
    output: Record<string, unknown>,
    attempt: number,
  ): Promise<VerifyTaskOutcome> {
    const taskSpec = task.taskSpec;

    const verifyRequest = {
      session_id: createSessionId(),
      task_id: task.id,
      task_spec: taskSpec
        ? {
            checks: Array.isArray(taskSpec.checks) ? (taskSpec.checks as string[]) : undefined,
          }
        : undefined,
      working_directory: workDir,
      git_root: workDir,
    };

    try {
      const verifyLogOpts: VerifyLogOptions | undefined = this.deps.eventSink
        ? { logPath: this.deps.eventSink.path }
        : undefined;
      const response = await verify(verifyRequest, verifyLogOpts);
      console.log(
        `[${task.id}] verify: deterministic=${response.tiers.deterministic.status}, passed=${response.passed}`,
      );
      this.deps.eventSink?.emit({
        event: "verify_result",
        taskId: task.id,
        attempt,
        deterministic: response.tiers.deterministic.status,
        deterministicDetails: response.tiers.deterministic.details,
        deterministicChecks: response.tiers.deterministic.checks ?? [],
        passed: response.passed,
      });

      return { passed: response.passed };
    } catch (e) {
      // Discipline A: verification unreachable -> false, never true. The agent's
      // own self-reported output.verify.passed is discarded here — trusting it
      // when real verification errored lets an optimistic/dishonest agent grade
      // itself (Run 9 readiness review X1). It is still logged (Discipline C)
      // so the discarded self-report is visible for diagnosis.
      const inlineVerify = output.verify as Record<string, unknown> | undefined;
      const selfReportedPassed =
        typeof inlineVerify?.passed === "boolean" ? inlineVerify.passed : "unknown";
      console.warn(
        `[${task.id}] verify failed, failing closed (self-reported passed=${selfReportedPassed} discarded):`,
        e,
      );
      this.deps.eventSink?.emit({
        event: "error",
        location: "DevelopmentService:verifyTask",
        taskId: task.id,
        attempt,
        error: String(e).slice(0, 500),
      });
      return { passed: false };
    }
  }

  /**
   * Records what this completed task actually delivered onto the project contract
   * (mig9-t4): concrete endpoints derived from the synced target tree plus the
   * created source modules from its diff. Fail-SOFT (Discipline C): the task has
   * already passed its gates and been marked complete, so an amend failure — a
   * contract-less project, a divergent-redeclaration conflict, a transient DB error
   * — is logged with context and swallowed, never allowed to un-complete the task.
   */
  private async amendContractOnCompletion(
    task: TaskDescriptor,
    targetProjectPath: string | null,
    filesChanged: readonly string[],
  ): Promise<void> {
    const amender = this.deps.contractAmender;
    if (!amender || !targetProjectPath) return;
    try {
      const contract = await this.loadContract(task.id);
      const entryPointPath = contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null;
      const contractLanguage = contract ? nodeLabel(contract.knowledge, "language") ?? null : null;
      const { endpoints } = await deriveEndpoints(targetProjectPath, entryPointPath, contractLanguage);
      const modulePaths = selectModulePaths(filesChanged, entryPointPath);
      if (endpoints.length === 0 && modulePaths.length === 0) return;
      await amender.amendOnCompletion(task.id, {
        endpoints: endpoints.map((e) => ({ method: e.method, path: e.path })),
        modulePaths,
      });
    } catch (e) {
      console.warn(
        `[${task.id}] contract completion amend failed; task stays completed (fail-soft):`,
        e,
      );
    }
  }

  private tryPopulateIndex(targetProjectPath: string | null): void {
    if (this.indexed || !targetProjectPath || !this.deps.populateIndex) return;
    try {
      this.deps.populateIndex(targetProjectPath);
      this.indexed = true;
    } catch (e) {
      console.warn("Codebase index population failed:", e);
    }
  }

}

function buildBasicBrief(
  task: TaskDescriptor,
  priorAttemptFailure?: string,
  contractSlice?: string,
): AgentBrief {
  const spec = task.taskSpec;
  const shortGoal = typeof spec?.goal === "string" ? spec.goal : task.title;
  const deliverables = stringArrayOrEmpty(spec?.deliverables);
  const goalParts = [task.title];
  if (shortGoal !== task.title) goalParts.push(shortGoal);
  if (deliverables.length > 0) goalParts.push(`Deliverables: ${deliverables.join(", ")}`);
  const goal = goalParts.join(". ");
  const endState = typeof spec?.endState === "string" ? spec.endState : `Implement: ${task.title}`;

  const constraints = stringArrayOrEmpty(spec?.checks);

  return parseAgentBrief(
    {
      taskId: task.id,
      goal,
      context: `End state: ${endState}`,
      tools: ["read_file", "write_file", "edit_file", "run_command", "search_codebase", "list_directory"],
      constraints,
      deliverables,
      ...(spec !== undefined ? { task_spec: spec } : {}),
      ...(priorAttemptFailure !== undefined ? { priorAttemptFailure } : {}),
      ...(contractSlice !== undefined ? { contractSlice } : {}),
    },
    "development:buildBasicBrief",
  );
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
  blockedReason: Record<string, unknown> | undefined,
): ReplanContext | null {
  if (!blockedReason) return null;
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

type GateKind = "entry-point" | "merge" | "agent" | "verify" | "unknown";

function detectGateKind(envelope: ErrorEnvelope): GateKind {
  const layers = flattenChain(envelope.chain);
  for (const layer of layers) {
    switch (layer.operation) {
      case "entryPointRewriteCheck": return "entry-point";
      case "tentativeMerge": return "merge";
      case "agentExecution": return "agent";
      case "postMergeVerify":
      case "verify": return "verify";
    }
  }
  return "unknown";
}

function innermostLayer(layer: ErrorLayer): ErrorLayer {
  let current = layer;
  while (current.cause) {
    current = current.cause;
  }
  return current;
}

function extractFilePathsFromChain(envelope: ErrorEnvelope): readonly string[] {
  const paths: string[] = [];
  const filePattern = /[\w@./-]+\/[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|html)/g;
  for (const layer of flattenChain(envelope.chain)) {
    const msgMatches = layer.message.match(filePattern);
    if (msgMatches) paths.push(...msgMatches);
    if (layer.context) {
      for (const value of Object.values(layer.context)) {
        if (typeof value === "string") {
          const ctxMatches = value.match(filePattern);
          if (ctxMatches) paths.push(...ctxMatches);
        }
      }
    }
  }
  return [...new Set(paths)];
}

function collectDiagnosticText(envelope: ErrorEnvelope): string {
  const parts: string[] = [envelope.summary];
  for (const layer of flattenChain(envelope.chain)) {
    parts.push(layer.message);
  }
  return parts.join(" ").toLowerCase();
}

function derivePrescriptiveInstruction(envelope: ErrorEnvelope): string {
  const gateKind = detectGateKind(envelope);
  const text = collectDiagnosticText(envelope);
  const filePaths = extractFilePathsFromChain(envelope);
  const fileRef = filePaths.length > 0
    ? ` The affected file(s): ${filePaths.join(", ")}.`
    : "";

  if (/error ts\d{4}/.test(text) || /tsc.*(fail|error)/.test(text) || text.includes("typescript compilation")) {
    return `TypeScript compilation fails. Fix the type errors listed below before any other work.${fileRef}`;
  }

  switch (gateKind) {
    case "entry-point":
      return `The entry point file was rewritten, breaking existing routes. Modify the entry point additively — do not replace its contents.${fileRef}`;

    case "merge":
      return `The changes conflict with code merged since your last attempt. Resolve the merge conflicts in the listed files, keeping both sets of changes intact.${fileRef}`;

    case "agent":
      if (text.includes("no file changes")) {
        return "The agent completed but made no file changes. Ensure you actually write the implementation to disk, not just plan it.";
      }
      return "The agent execution failed. Review the failure summary and take a fundamentally different approach.";

    case "verify":
      return `Verification failed. The changes do not pass the required checks. Fix the failing checks listed below before proceeding.${fileRef}`;

    default:
      return `Review the failure details below and address the root cause before proceeding.${fileRef}`;
  }
}

function formatPriorAttemptFailure(ctx: ReplanContext): string {
  const envelopeParsed = errorEnvelopeSchema.safeParse(ctx.raw);
  if (envelopeParsed.success) {
    const envelope = envelopeParsed.data;
    const diagnostic = innermostLayer(envelope.chain).message;
    const prescriptive = derivePrescriptiveInstruction(envelope);

    const lines: string[] = [
      `# CRITICAL: Previous attempt FAILED — read this FIRST`,
      ``,
      `Your previous attempt (attempt ${ctx.attempt}) failed. You MUST address this before doing anything else.`,
      ``,
      `## What failed`,
      diagnostic,
      ``,
      `## What you MUST do differently`,
      prescriptive,
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
    `## What you MUST do differently`,
    `Review the failure details below and address the root cause before proceeding.`,
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

// ---------------------------------------------------------------------------
// Pure utility functions (no BC dependencies)
// ---------------------------------------------------------------------------

function stubAgentOutput(): Record<string, unknown> {
  return {
    status: "stub",
    summary: "agent execution not yet wired — orchestration flow complete",
    files_changed: [],
    findings: [],
    build_log: null,
    test_log: null,
    error: null,
  };
}

