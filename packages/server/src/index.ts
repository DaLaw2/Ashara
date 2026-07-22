import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";

import {
  createDb,
  WorkItemRepository as DbWorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ConfigRepository,
  CostRepository,
  KnowledgeRepository,
  BrainstormLogRepository,
  FailedApproachRepository,
  ContextBriefRepository,
  ContractRepository,
  withPlanningTransaction,
} from "@ashara/db";
import {
  CoreLoop,
  ContinuousRunner,
  EventLogger,
  reconcileOnStartup,
} from "@ashara/orchestrator";
import type { CoreLoopDeps } from "@ashara/orchestrator";
import type { ContractRegistryLookup } from "@ashara/planning";
import {
  BrainstormEngine,
  StubBrainstormLLM,
  NorthStarChecker,
  StubNorthStarLLM,
  DecompositionEngine,
  Router,
  FailureRouter,
  createGatewayBrainstormLLM,
  createGatewayNorthStarLLM,
  createGatewayDecompositionLLM,
  createGatewaySpecDerivationLLM,
  createGatewayAcceptanceLLM,
  createGatewayReplanLLM,
  createBulkPlanWithContract,
  deriveCompletionEndpoint,
  deriveCompletionModule,
} from "@ashara/planning";
import type { BrainstormLLM, NorthStarLLM, DecompositionLLM, SpecDerivationLLM, AcceptanceLLM, ReplanLLM } from "@ashara/planning";
import {
  buildDefaultProfile,
  createRetrievalFn,
  DevelopmentService,
  observeProduct,
} from "@ashara/development";
import type {
  SessionStore,
  KnowledgeSink,
  KnowledgeSource,
  AgentInvoker,
  AgentSpawnOptions,
  ConventionsExtractor,
  ExecutionEventSink,
  ContractSource,
  ContractAmender,
  CompletionDeliverables,
} from "@ashara/development";
import { buildSanitizedEnv, extractProjectConventions } from "@ashara/agent-runner";
import { BudgetLedger, loadGatewayConfig, LLMGateway, NoLLMProvidersConfigured, withStructuredLadder } from "@ashara/llm-gateway";
import type { LadderAttemptEvent, LLMCallRecord } from "@ashara/llm-gateway";
import { createEmbedderFromEnv, createInProcessGraphClient } from "@ashara/memory";
import type { GraphClient } from "@ashara/memory";
import { CodebaseIndexer, initParser } from "@ashara/memory";
import type { WorkItemId, WorkItemLevel, WorkItemStatus, DomainEvent, ProjectContract, ContractDelta } from "@ashara/shared";
import { parseWorkItemLevel, parseWorkItemStatus, parseProjectId, HttpMethodSchema } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning";
import { adaptWorkItemRepo } from "./work-item-adapter.js";
import { PlanningService, ContractVersionConflict } from "@ashara/planning";

import { loadServerConfig } from "./config.js";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";
import { resolveAgentOutput } from "./agent-output.js";
import { buildAgentSpawnLocation } from "./agent-spawn.js";
import { terminateProcessTree } from "./process-group.js";
import { wireLlmGateway } from "./gateway-wiring.js";

async function main(): Promise<void> {
  const dotenvPath = `${process.cwd()}/.env`;
  try {
    if (existsSync(dotenvPath)) {
      const text = readFileSync(dotenvPath, "utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // .env not found, that's fine
  }

  const config = loadServerConfig();

  const db = createDb(config.databaseUrl);

  const dbWorkItemRepo = new DbWorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const configRepo = new ConfigRepository(db);
  const costRepo = new CostRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const brainstormLogRepo = new BrainstormLogRepository(db);
  const failedApproachRepo = new FailedApproachRepository(db);
  const contextBriefRepo = new ContextBriefRepository(db);
  const contractRepo = new ContractRepository(db);

  const workItemRepo: WorkItemRepository = adaptWorkItemRepo(dbWorkItemRepo);

  // Seed providers with API keys from env
  await configRepo.seedProviders([
    { name: "anthropic", providerType: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: null },
    { name: "openai", providerType: "openai", apiKey: process.env.OPENAI_API_KEY, baseUrl: null },
    { name: "deepseek", providerType: "openai-compatible", apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1" },
    { name: "mistral", providerType: "openai-compatible", apiKey: process.env.MISTRAL_API_KEY, baseUrl: null },
    { name: "xai", providerType: "openai-compatible", apiKey: process.env.XAI_API_KEY, baseUrl: null },
    { name: "google", providerType: "openai-compatible", apiKey: process.env.GOOGLE_API_KEY, baseUrl: null },
    { name: "local", providerType: "openai-compatible", apiKey: null, baseUrl: process.env.LOCAL_LLM_URL ?? null },
  ]);

  // Single composition-root call for the LLM gateway (ADR-030). There is no
  // silent fallback here: providers configured -> real gateway; zero
  // providers + ASHARA_TEST_STUB_LLM=1 -> explicit stub mode; zero providers
  // and no test flag -> NoLLMProvidersConfigured propagates out of this
  // block and the server refuses to start (see catch below).
  //
  // budgetLedger is the ONE in-memory, per-run budget gate for this process
  // (structural simplification: replaces the file-based CostTracker). Its
  // total cap is overridden from config.coreLoop.budgetLimitUsd -- the same
  // single number the orchestrator's BudgetTracker enforces -- so
  // ASHARA_BUDGET_LIMIT_USD / ASHARA_BUDGET_TOTAL has exactly one parse site
  // (loadServerConfig) instead of two independently-defaulted readers.
  const pipelineLogPath = join(
    config.coreLoop.workdirBase || join(process.cwd(), "ashara-work"),
    "pipeline.jsonl",
  );
  const eventLogger = new EventLogger(pipelineLogPath);
  console.log(`Pipeline event log: ${pipelineLogPath}`);

  const llmLogSink = (record: LLMCallRecord): void => {
    eventLogger.emit({ event: "llm_call", ...record });
  };

  const ladderAttemptSink = (attempt: LadderAttemptEvent): void => {
    eventLogger.emit({ event: "ladder_attempt", ...attempt });
  };

  const budgetLedger = new BudgetLedger();
  let llmGateway: LLMGateway | null;
  try {
    const gwConfig = loadGatewayConfig();
    gwConfig.budget = {
      maxCostTotal: config.coreLoop.budgetLimitUsd,
      maxCostPerProvider: gwConfig.budget?.maxCostPerProvider,
    };
    const wired = await wireLlmGateway(
      gwConfig,
      (models) => configRepo.seedModelsFromToml(models),
      budgetLedger,
      llmLogSink,
    );
    llmGateway = wired.llmGateway;

    if (wired.mode === "real") {
      console.log("LLM gateway initialized");
      console.log(`Model catalog seeded: ${wired.seededModelCount} models`);
    } else {
      console.warn(
        "STUB MODE ACTIVE (ASHARA_TEST_STUB_LLM=1): no real LLM provider is configured. " +
          "Planning LLMs will run on Stub* implementations -- this must never happen in production.",
      );
    }
  } catch (err) {
    if (err instanceof NoLLMProvidersConfigured) {
      console.error("FATAL: LLM gateway refused to start (ADR-030) -- server will not boot.");
      console.error(`  checked sources: ${err.checkedSources.join(", ") || "none"}`);
      console.error(`  how to fix: ${err.howToFix}`);
      console.error(`  ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Initialize tree-sitter parser and codebase indexer
  try {
    await initParser();
  } catch (e) {
    console.warn("Failed to initialize tree-sitter parser:", e);
  }
  const indexer = new CodebaseIndexer();

  // In-process GraphClient: avoids HTTP round-trips for server-side retrieval.
  const inProcessGraphClient: GraphClient = createInProcessGraphClient(indexer);

  let brainstormLlm: BrainstormLLM;
  let northstarLlm: NorthStarLLM;
  let decompositionLlm: DecompositionLLM | null = null;
  let specDerivationLlm: SpecDerivationLLM | null = null;
  let acceptanceLlm: AcceptanceLLM | null = null;
  let replanLlm: ReplanLLM | null = null;
  if (llmGateway) {
    // Route ALL structured planning calls (brainstorm, northstar, decomposition)
    // through the shared reliability ladder (Phase 4 t1, ADR-030 G5): temperature
    // 0, validated attempt on the requested model, escalate ONE capability tier
    // on persistent schema failure, then a typed StructuredOutputExhausted —
    // never silently accept a drifted enum. The wrapper is a drop-in for the
    // gateway's generateStructured, so the planning adapters are unchanged.
    //
    // Separate ladder instances (distinct "brainstorm"/"northstar" sites,
    // rather than one shared "planning" site) so the routing-profiles story
    // can route each independently — a shared site would have collapsed both
    // under one playbook entry.
    const brainstormLadder = withStructuredLadder(llmGateway, { site: "brainstorm", onAttempt: ladderAttemptSink });
    const northstarLadder = withStructuredLadder(llmGateway, { site: "northstar", onAttempt: ladderAttemptSink });
    brainstormLlm = createGatewayBrainstormLLM(brainstormLadder);
    northstarLlm = createGatewayNorthStarLLM(northstarLadder);
    // Decomposition gets its OWN ladder (createGatewayDecompositionLLM): it runs a
    // SEMANTIC phantom-dependsOn-ref validation inside each attempt and re-asks with
    // the feedback on retry, so a single malformed emission is corrected instead of
    // exploding the run (mig-run10, the Run-10 "task-0017" phantom-ref blocker).
    decompositionLlm = createGatewayDecompositionLLM(llmGateway, ladderAttemptSink);
    // Spec derivation (ADR-032 §2, mig9-t1) gets its OWN ladder-wrapped provider
    // with a distinct site so an exhaustion error is attributed to it, not to the
    // shared "planning" site. It is the auditor half of the endpoint set — an
    // INDEPENDENT vision read that recovers endpoints the plan omitted.
    const specDerivationLadder = withStructuredLadder(llmGateway, { site: "spec-derivation", onAttempt: ladderAttemptSink });
    specDerivationLlm = createGatewaySpecDerivationLLM(specDerivationLadder);
    const acceptanceLadder = withStructuredLadder(llmGateway, { site: "acceptance", onAttempt: ladderAttemptSink });
    acceptanceLlm = createGatewayAcceptanceLLM(acceptanceLadder);
    const replanLadder = withStructuredLadder(llmGateway, { site: "replan", onAttempt: ladderAttemptSink });
    replanLlm = createGatewayReplanLLM(replanLadder);
    console.log("Planning LLMs: gateway-backed (brainstorm, northstar, decomposition, spec-derivation, acceptance, replan)");
  } else {
    brainstormLlm = new StubBrainstormLLM();
    northstarLlm = new StubNorthStarLLM();
    console.warn("Planning LLMs: STUB MODE (ASHARA_TEST_STUB_LLM=1) -- no real LLM calls");
  }
  const brainstormEngine = new BrainstormEngine(brainstormLlm);
  const northstarChecker = new NorthStarChecker(northstarLlm);
  const decompositionEngine = new DecompositionEngine(decompositionLlm);
  const planningRouter = new Router(northstarChecker, brainstormEngine);
  // Bounded replan attempts before the router switches strategy (substitute) or
  // abandons — see FailureRouter's rule ladder (migration Phase 6, ADR-029).
  const failureRouter = new FailureRouter(2);

  const projectProfile = buildDefaultProfile();
  const retrieveFn = await createRetrievalFn(inProcessGraphClient);

  const proposalEmbedder = createEmbedderFromEnv();
  if (proposalEmbedder === null) {
    console.log("No embedder configured; brainstorm proposal dedup will use lexical similarity only");
  }

  const sessionStore: SessionStore = {
    insert: (sid, tid, brief) => devSessionRepo.insert(sid, tid, brief),
    complete: (sid) => devSessionRepo.complete(sid),
    fail: (sid, vr) => devSessionRepo.fail(sid, vr),
  };

  const knowledgeSink: KnowledgeSink = {
    storeFinding: (tid, eid, title, content, tags) =>
      knowledgeRepo.storeKnowledgeFinding(tid, eid, title, content, tags),
    storeInsight: (tid, eid, title, content) =>
      knowledgeRepo.storeKnowledgeInsight(tid, eid, title, content),
  };

  // Every in-flight agent-runner process, so shutdown can reap the whole tree
  // (findings e+f). Populated on spawn, drained on exit; iterated on shutdown.
  const activeAgentProcs = new Set<ChildProcess>();

  const agentInvoker: AgentInvoker = {
    async spawn(opts: AgentSpawnOptions): Promise<Record<string, unknown>> {
      // GIT-SAFETY (b): cwd is the task's own worktree, never the Ashara repo
      // checkout — see agent-spawn.ts for why. Only runnerScript's location
      // still derives from asharaSourceDir; it is resolved absolute so it
      // doesn't need cwd to be asharaSourceDir to be found.
      const { cwd, runnerScript } = buildAgentSpawnLocation(config.coreLoop.asharaSourceDir, opts.workDir);
      console.log(`[${opts.taskId}] launching agent-runner subprocess`);

      const proc = spawn("npx", ["tsx", runnerScript], {
        cwd,
        env: {
          ...buildSanitizedEnv(),
          ASHARA_BRIEF_PATH: opts.briefPath,
          ASHARA_OUTPUT_PATH: opts.outputPath,
          ASHARA_WORKING_DIR: opts.workDir,
          ASHARA_SERVER_URL: config.coreLoop.selfUrl,
          ASHARA_API_TOKEN: config.coreLoop.apiToken,
          AGENT_CAPABILITY: "Strong",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Own a process group (finding e): the runner is an npx -> tsx -> node
        // wrapper chain. detached:true makes `proc` the group leader so a
        // timeout or shutdown can signal the WHOLE tree via
        // terminateProcessTree(-pid); a plain proc.kill() would orphan tsx/node.
        detached: true,
      });
      activeAgentProcs.add(proc);

      const timer = setTimeout(() => {
        console.warn(
          `[${opts.taskId}] agent-runner exceeded ${config.coreLoop.agentTimeoutMs}ms — terminating process group`,
        );
        void terminateProcessTree(proc);
      }, config.coreLoop.agentTimeoutMs);
      try {
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          proc.on("close", resolve);
          proc.on("error", reject);
        });

        if (stderr) console.log(`[${opts.taskId}] agent stderr:`, stderr.slice(0, 500));

        // Do NOT throw on a non-zero exit (r9f-t2). The agent-runner writes output.json
        // — carrying the REAL status ("blocked"/"failed") and total_cost — BEFORE it
        // exits non-zero on a routine bad outcome (agent-runner/runner.ts). Throwing here
        // discarded that output, so the orchestrator saw an empty result: zero cost, no
        // dispatch counted, the retry bound never bound (Run-9). Read the output
        // regardless of exit code; only a genuinely absent/unparseable file is
        // fail-closed as a typed throw inside resolveAgentOutput. The exit code rides
        // into that error for diagnosis (Discipline C).
        return await resolveAgentOutput(opts.taskId, opts.outputPath, exitCode, stderr);
      } finally {
        clearTimeout(timer);
        activeAgentProcs.delete(proc);
      }
    },
  };

  const conventionsExtractor: ConventionsExtractor = {
    extract: (workDir) => extractProjectConventions(workDir),
  };

  const knowledgeSource: KnowledgeSource = {
    recentFindings: (scope, limit) => knowledgeRepo.recentFindingsScoped(scope.epicId, scope.queryText, limit),
    failedApproaches: (scope, limit) =>
      failedApproachRepo.failedApproachesScoped(scope.epicId, scope.queryText, limit),
  };

  const devEventSink: ExecutionEventSink = {
    emit: (event) => eventLogger.emit(event),
    get path() { return eventLogger.path; },
  };

  // The ProjectContract is keyed by the project ROOT id (the top of the parent
  // chain, an epic — see story-decomposer.writeOrAmendContract). Walk parentId up
  // from any work item to that root; all three contract adapters below share it so
  // the Development/Planning BCs stay free of a db dependency (ADR-027).
  const resolveProjectRootId = async (workItemId: string): Promise<string | null> => {
    let current = await workItemRepo.findById(workItemId as WorkItemId);
    if (!current) return null;
    while (current.parentId) {
      const parent = await workItemRepo.findById(current.parentId as WorkItemId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };

  // Brief slice (mig9-t3): the task-relevant read of the contract.
  const contractSource: ContractSource = {
    async loadForTask(taskId: string): Promise<ProjectContract | null> {
      const rootId = await resolveProjectRootId(taskId);
      return rootId ? contractRepo.getLatest(parseProjectId(rootId)) : null;
    },
    // Sibling-visibility gate (granularity-debate.md §3.A): a handful of ids per
    // call (one per coarse task), so per-id findById is simpler than adding a
    // bulk repository query for this alone.
    async loadCompletedTaskIds(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
      const items = await Promise.all(taskIds.map((id) => workItemRepo.findById(id as WorkItemId)));
      return new Set(
        items.filter((item): item is NonNullable<typeof item> => item?.status === "Completed").map((item) => item.id),
      );
    },
  };

  // FailureRouter substitution (mig9-t4): the contract read that lets recovery find
  // a substitute by the module/endpoint registry, not just by title.
  const contractLookup: ContractRegistryLookup = {
    async loadForItem(item): Promise<ProjectContract | null> {
      const rootId = await resolveProjectRootId(item.id);
      return rootId ? contractRepo.getLatest(parseProjectId(rootId)) : null;
    },
  };

  // Completion amend (mig9-t4): shape the observed deliverables into a ContractDelta
  // (endpoint-ref derivation is a contract concern that lives here, not in the
  // Development BC) and apply it version-race-safe. Skips silently when the project
  // has no contract; the caller invokes this fail-soft.
  const contractAmender: ContractAmender = {
    async amendOnCompletion(taskId: string, deliverables: CompletionDeliverables): Promise<void> {
      const rootId = await resolveProjectRootId(taskId);
      if (!rootId) return;
      const projectId = parseProjectId(rootId);
      const existingContract = await contractRepo.getLatest(projectId);
      if (!existingContract) return; // contract-less project — nothing to amend

      // AMEND FILLS, NEVER CONTESTS (Run-10 blocker #2): deriveCompletionEndpoint
      // echoes the DECLARED method+path for an already-declared ref (stamping only
      // declaredBy) — the declared path is the spec, delivery just confirms coverage.
      // A route the agent spelled slightly differently can never conflict the amend
      // and leave the coverage gap falsely open; a genuinely new endpoint is added
      // with its normalized path.
      const endpoints = deliverables.endpoints
        .map((e) => {
          const method = HttpMethodSchema.safeParse(e.method);
          if (!method.success) return null;
          return deriveCompletionEndpoint(existingContract.endpoints, { method: method.data, path: e.path }, taskId);
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      // Same fill-not-contest treatment for modules (Run-10 blocker #5):
      // deriveCompletionModule echoes the DECLARED purpose for an already-registered
      // path (stamping only providerWorkItem) so a completion amend can never trip
      // `module-purpose-divergence` against the decomposition-authored purpose.
      const modules = deliverables.modulePaths.map((path) =>
        deriveCompletionModule(existingContract.modules, { path }, taskId),
      );
      const delta: ContractDelta = { endpoints, modules };

      // Bounded retry on the RETRYABLE version-conflict signal (a concurrent amend
      // took latest+1); any other error (e.g. a divergent-redeclaration conflict)
      // propagates to the fail-soft caller.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await PlanningService.amendContract(contractRepo, projectId, delta);
          return;
        } catch (e) {
          if (!(e instanceof ContractVersionConflict)) throw e;
        }
      }
      throw new Error(`contract completion amend exhausted version-conflict retries for project ${projectId}`);
    },
  };

  const developmentService = new DevelopmentService({
    config: {
      workdirBase: config.coreLoop.workdirBase,
      useRealAgent: config.coreLoop.useRealAgent,
    },
    sessionStore,
    knowledgeSink,
    knowledgeSource,
    agentInvoker,
    conventionsExtractor,
    llmGateway,
    projectProfile,
    retrieveFn,
    eventSink: devEventSink,
    contractSource,
    contractAmender,
  });

  // One shared-transaction facade over both the WorkItemRepository (adapted to the
  // domain shape) and the ContractRepository (ADR-028 + ADR-029). Reused by the
  // core loop's decomposition contract write AND the bulk-plan contract write
  // (mig9-t5), so both establish the contract in the same fail-safe transaction.
  const planningTransaction = <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ): Promise<T> =>
    withPlanningTransaction(db, ({ workItemRepo: txDbWorkItemRepo, contractRepo }) =>
      fn({ workItemRepo: adaptWorkItemRepo(txDbWorkItemRepo), contractRepo }),
    );

  const coreLoopDeps: CoreLoopDeps = {
    config: config.coreLoop,
    workItemRepo,
    eventStore,
    costRepo,
    brainstormLogRepo,
    failedApproachRepo,
    contextBriefRepo,
    visionRepo,
    brainstormEngine,
    northstarChecker,
    decompositionEngine,
    specDerivationLlm,
    contractRepo,
    developmentService,
    embedder: proposalEmbedder,
    eventLogger,
    router: planningRouter,
    failureRouter,
    contractLookup,
    // Shares one DB transaction between decomposition's work-item creation and
    // its derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9); the
    // work-item half is re-adapted to the domain shape the same way the
    // top-level workItemRepo is (adaptWorkItemRepo).
    withPlanningTransaction: planningTransaction,
    acceptanceLlm: acceptanceLlm ?? undefined,
    observeProduct: (targetPath: string) => observeProduct(targetPath),
    acceptanceAttempts: 0,
    replanLlm: replanLlm ?? undefined,
    replanRounds: 0,
  };

  const coreLoop = new CoreLoop(coreLoopDeps);

  // Run-termination detection is ON by default (mig-phase-7, ADR-029). The rollback
  // clause: set ASHARA_TERMINATION_ENABLED=0 (or "false") to revert to the legacy
  // infinite idle with a loud per-cycle log of the stop that WOULD have fired.
  const terminationDisabled =
    process.env["ASHARA_TERMINATION_ENABLED"] === "0" ||
    process.env["ASHARA_TERMINATION_ENABLED"]?.toLowerCase() === "false";
  const runner = new ContinuousRunner(
    coreLoop,
    {
      databaseUrl: config.databaseUrl,
      terminationEnabled: !terminationDisabled,
    },
    eventLogger,
  );

  const appDeps: AppDeps = {
    workItemRepo: dbWorkItemRepo,
    eventStore,
    devSessionRepo,
    visionRepo,
    configRepo,
    costRepo,
    runner,
    indexer,
    // Bulk plan creation writes the derived ProjectContract in the SAME transaction
    // as the work items (mig9-t5) — a contract failure rolls the whole batch back.
    createBulkPlan: (items, edges) => createBulkPlanWithContract({ withPlanningTransaction: planningTransaction }, items, edges),
  };

  const app = new Hono();

  const corsOrigins = process.env["ASHARA_CORS_ORIGINS"];
  if (corsOrigins) {
    const origins = corsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
    app.use(
      "*",
      cors({
        origin: origins,
        allowMethods: ["GET", "POST", "PUT", "PATCH"],
        allowHeaders: ["Content-Type", "Authorization"],
      }),
    );
  }

  app.use("*", bearerAuth(config.apiToken));
  app.route("/", createRoutes(appDeps));

  // Startup reconciliation (Discipline B) — MUST run before the runner starts
  // cycling. A prior process may have crashed mid-dispatch (this project's history
  // IS the serve+spawn crash), leaving items InProgress with no owning agent, or
  // Failed with no recovery routed. Reset orphans to Pending and route parked Failed
  // items through the same FailureRouter policy so the gate (Pending-only) sees the
  // recovered work on the first cycle. Idempotent, and per-item fail-closed inside;
  // if the whole pass throws (e.g. DB unreachable), log and let the runner surface
  // the same connectivity failure through its own error handling rather than block
  // boot here.
  try {
    await reconcileOnStartup({
      workItemRepo,
      eventStore,
      failureRouter,
    });
  } catch (e) {
    console.warn("Startup reconciliation failed; starting runner anyway:", e);
  }

  const abortController = new AbortController();
  const runnerPromise = runner.run(abortController.signal);

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Ashara server listening on port ${config.port}`);
  console.log("Continuous runner started in background");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    abortController.abort();
    // Reap every in-flight agent-runner process group (findings e+f): SIGTERM
    // the whole npx/tsx/node tree, escalate to SIGKILL, and await exit so no
    // descendant survives the stop to keep dispatching/spending. Includes any
    // smoke-boot app the gate spawned inside that tree.
    const procs = [...activeAgentProcs];
    if (procs.length > 0) {
      console.log(`Terminating ${procs.length} in-flight agent process group(s)...`);
      await Promise.all(procs.map((p) => terminateProcessTree(p)));
    }
    server.close();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await runnerPromise;
  console.log("Server and continuous runner stopped");
}


process.on("uncaughtException", (err: Error) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (err: unknown) => {
  console.error("Unhandled rejection:", err);
});

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
