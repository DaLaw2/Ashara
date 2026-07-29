import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
  RunStateRepository,
  withPlanningTransaction,
} from "@ashara/db";
import {
  CoreLoop,
  ContinuousRunner,
  EventLogger,
  reconcileOnStartup,
  terminalizeOnRunEnd,
  closeRun,
} from "@ashara/orchestrator";
import type { CoreLoopDeps } from "@ashara/orchestrator";
import type { ContractRegistryLookup } from "@ashara/planning";
import {
  BrainstormEngine,
  StubBrainstormLLM,
  NorthStarChecker,
  StubNorthStarLLM,
  DecompositionEngine,
  FailureRouter,
  createGatewayBrainstormLLM,
  createGatewayNorthStarLLM,
  createGatewayDecompositionLLM,
  createGatewayAcceptanceLLM,
  createGatewayReplanLLM,
  createBulkPlanWithContract,
  deriveCompletionEndpoint,
  deriveCompletionModule,
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "@ashara/planning";
import type { BrainstormLLM, NorthStarLLM, DecompositionLLM, AcceptanceLLM, ReplanLLM, FailureCategory } from "@ashara/planning";
import {
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
  ProjectIntentSource,
  StackDeriver,
} from "@ashara/development";
import { buildSanitizedEnv, extractProjectConventions } from "@ashara/agent-runner";
import {
  BudgetLedger,
  buildGatewayConfig,
  loadRoutingProfilesFromToml,
  resolveModelsConfigPath,
  parseFormatGroup,
  LLMGateway,
  NoLLMProvidersConfigured,
  withStructuredLadder,
} from "@ashara/llm-gateway";
import type { GatewayCatalog, LadderAttemptEvent, LLMCallRecord, ModelConfig, ProviderCredential } from "@ashara/llm-gateway";
import { createEmbedderFromEnv, createInProcessGraphClient } from "@ashara/memory";
import type { GraphClient } from "@ashara/memory";
import { CodebaseIndexer, initParser } from "@ashara/memory";
import type { WorkItemId, WorkItemLevel, WorkItemStatus, DomainEvent, ProjectContract, ContractDelta, StoredBlockedReason } from "@ashara/shared";
import { ASHARA_CONTROL_DIR, parseCapabilityLevel, parseWorkItemLevel, parseWorkItemStatus, parseProjectId, HttpMethodSchema, nodeByKind, RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning";
import { PlanningService, ContractVersionConflict } from "@ashara/planning";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import { adaptWorkItemRepo } from "./work-item-adapter.js";
import { loadServerConfig, loadDatabaseUrl } from "./config.js";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";
import { resolveAgentOutput } from "./agent-output.js";
import {
  buildContainerName,
  SANDBOX_IMAGE,
  SANDBOX_TAG,
  buildContainerEnv,
  spawnContainer,
  terminateContainer,
  ContainerSpawnError,
} from "./container-spawn.js";
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
  } catch (e: unknown) {
    console.warn(`[server] Failed to load .env from ${dotenvPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Phase 1: bootstrap — database URL from env or policy default.
  const databaseUrl = loadDatabaseUrl();
  const db = createDb(databaseUrl);

  const dbWorkItemRepo = new DbWorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const configRepo = new ConfigRepository(db);
  const costRepo = new CostRepository(db);
  const runStateRepo = new RunStateRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const brainstormLogRepo = new BrainstormLogRepository(db);
  const failedApproachRepo = new FailedApproachRepository(db);
  const contextBriefRepo = new ContextBriefRepository(db);
  const contractRepo = new ContractRepository(db);

  const workItemRepo: WorkItemRepository = adaptWorkItemRepo(dbWorkItemRepo);

  await configRepo.seedProviders([
    { name: "anthropic", providerType: "anthropic", baseUrl: null },
    { name: "openai", providerType: "openai", baseUrl: null },
    { name: "deepseek", providerType: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" },
    { name: "mistral", providerType: "openai-compatible", baseUrl: "https://api.mistral.ai/v1" },
    { name: "xai", providerType: "openai-compatible", baseUrl: "https://api.x.ai/v1" },
    { name: "google", providerType: "openai-compatible", baseUrl: null },
    { name: "local", providerType: "openai-compatible", baseUrl: null },
  ]);

  // Phase 2: API token from the database (systemSettings). Fail-closed:
  // a missing token means the server cannot authenticate any request. The
  // error names the table and key so the operator knows where to INSERT.
  const apiToken = await configRepo.getSetting("api_token");
  if (!apiToken) {
    console.error(
      "FATAL: api_token not found in system_settings table. " +
        "The server cannot start without an API token.\n" +
        "  looked in: system_settings WHERE key = 'api_token'\n" +
        "  how to fix: INSERT INTO system_settings (key, value) " +
        "VALUES ('api_token', '<your-token>');",
    );
    process.exit(1);
  }

  const config = loadServerConfig(databaseUrl, apiToken);

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
  const pipelineLogPath = join(config.coreLoop.workdirBase, "pipeline.jsonl");
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
    // Model catalog is DB-authoritative (seeded by migration 002_seed_models.sql).
    // Load from DB, convert to the llm-gateway ModelConfig shape, and build the
    // gateway config. Routing profiles remain deployment-specific TOML config.
    const dbModelRows = await configRepo.listModelConfigs();
    const models: Record<string, ModelConfig> = {};
    for (const row of dbModelRows) {
      models[row.modelId] = {
        id: row.modelId,
        apiModelId: row.apiModelId ?? row.modelId,
        provider: row.providerName,
        capabilityLevel: parseCapabilityLevel(row.capability),
        formatGroup: parseFormatGroup(row.formatGroup),
        strictMode: row.strictMode,
        inputCostPer1M: row.inputCostPer1m,
        outputCostPer1M: row.outputCostPer1m,
        maxContextTokens: row.maxContextTokens,
        supportsCaching: row.supportsCaching,
      };
    }
    // Provider credentials from the database — the env path is gone from the
    // server (Discipline D). The agent-runner subprocess still reads keys from
    // its own environment (packages/agent-runner/src/runner.ts:522 →
    // loadGatewayCatalogFromFile → buildConfigFromCatalog → loadProviderKeys);
    // those env vars are injected from DB data at container spawn time below.
    const dbProviderRows = await configRepo.listProviderConfigs();
    const credentials: ProviderCredential[] = dbProviderRows.map((row) => ({
      name: row.name,
      apiKey: row.apiKey,
      baseUrl: row.baseUrl,
    }));
    const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
    const gwConfig = buildGatewayConfig(models, routingProfiles, credentials);
    gwConfig.budget = {
      maxCostTotal: config.coreLoop.budgetLimitUsd,
      maxCostPerProvider: gwConfig.budget?.maxCostPerProvider,
    };
    const wired = await wireLlmGateway(
      gwConfig,
      budgetLedger,
      llmLogSink,
    );
    llmGateway = wired.llmGateway;

    if (wired.mode === "real") {
      console.log("LLM gateway initialized");
      console.log(`Model catalog: ${dbModelRows.length} models loaded from DB`);
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
  let parserReady = false;
  try {
    await initParser();
    parserReady = true;
  } catch (e) {
    console.warn("Failed to initialize tree-sitter parser:", e);
  }
  const indexer = new CodebaseIndexer();

  // In-process GraphClient: avoids HTTP round-trips for server-side retrieval.
  const inProcessGraphClient: GraphClient = createInProcessGraphClient(indexer);

  let brainstormLlm: BrainstormLLM;
  let northstarLlm: NorthStarLLM;
  let decompositionLlm: DecompositionLLM | null = null;
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
    const acceptanceLadder = withStructuredLadder(llmGateway, { site: "acceptance", onAttempt: ladderAttemptSink });
    acceptanceLlm = createGatewayAcceptanceLLM(acceptanceLadder);
    const replanLadder = withStructuredLadder(llmGateway, { site: "replan", onAttempt: ladderAttemptSink });
    replanLlm = createGatewayReplanLLM(replanLadder);
    console.log("Planning LLMs: gateway-backed (brainstorm, northstar, decomposition, acceptance, replan)");
  } else {
    brainstormLlm = new StubBrainstormLLM();
    northstarLlm = new StubNorthStarLLM();
    console.warn("Planning LLMs: STUB MODE (ASHARA_TEST_STUB_LLM=1) -- no real LLM calls");
  }
  const brainstormEngine = new BrainstormEngine(brainstormLlm);
  const northstarChecker = new NorthStarChecker(northstarLlm);
  const decompositionEngine = new DecompositionEngine(decompositionLlm);
  const failureRouter = new FailureRouter(3);

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

  // Provider name → env var name mapping for container key injection.
  // The agent-runner subprocess reads keys from its own process.env via
  // loadProviderKeys() (packages/agent-runner/src/runner.ts:522 →
  // loadGatewayCatalogFromFile → buildConfigFromCatalog → loadProviderKeys).
  // The server reads keys from the database and injects them into the
  // container environment using these names.
  const PROVIDER_KEY_ENV_MAP: Readonly<Record<string, string>> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    mistral: "MISTRAL_API_KEY",
    xai: "XAI_API_KEY",
    google: "GOOGLE_API_KEY",
  };

  // Build the gateway catalog and provider key env vars at spawn time from
  // the DB. Fresh per spawn so config changes between dispatches are picked
  // up. The catalog carries no secrets; keys travel as container env vars.
  interface SpawnData {
    readonly catalog: GatewayCatalog;
    readonly providerKeyEnv: Record<string, string>;
  }

  async function buildSpawnData(): Promise<SpawnData> {
    const [modelRows, providerRows, settingsRows] = await Promise.all([
      configRepo.listModelConfigs(),
      configRepo.listProviderConfigs(),
      configRepo.getSettings(),
    ]);

    const settings: Record<string, string> = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const catalog: GatewayCatalog = {
      models: modelRows.map((row) => ({
        modelId: row.modelId,
        providerName: row.providerName,
        apiModelId: row.apiModelId,
        capability: row.capability,
        formatGroup: row.formatGroup,
        strictMode: row.strictMode,
        inputCostPer1m: row.inputCostPer1m,
        outputCostPer1m: row.outputCostPer1m,
        maxContextTokens: row.maxContextTokens,
        supportsCaching: row.supportsCaching,
      })),
      providers: providerRows.map((row) => ({
        name: row.name,
        providerType: row.providerType,
        baseUrl: row.baseUrl,
      })),
      settings,
    };

    // Inject provider API keys from the database into env vars for the
    // container. The agent-runner reads these via loadProviderKeys().
    const providerKeyEnv: Record<string, string> = {};
    for (const row of providerRows) {
      const envName = PROVIDER_KEY_ENV_MAP[row.name];
      if (envName && row.apiKey) {
        providerKeyEnv[envName] = row.apiKey;
      }
      if (row.name === "local" && row.baseUrl) {
        providerKeyEnv["LOCAL_LLM_URL"] = row.baseUrl;
      }
    }

    return { catalog, providerKeyEnv };
  }

  // Every in-flight agent container name, so shutdown can stop them all.
  // Populated on spawn, drained on exit or cleanup; iterated on shutdown.
  const activeContainers = new Set<string>();

  const agentInvoker: AgentInvoker = {
    async spawn(opts: AgentSpawnOptions): Promise<AgentOutputJson> {
      const capability = determineCapability(opts.dispatchCount, opts.blockedReason);
      if (capability === "Frontier") {
        console.log(`[${opts.taskId}] model escalated to Frontier (attempt ${opts.dispatchCount + 1})`);
      }

      // Write the gateway catalog file into the task's control directory.
      // The .ashara/ dir is created by execution-service before spawn is called.
      const catalogPath = join(opts.workDir, ASHARA_CONTROL_DIR, "gateway-catalog.json");
      const spawnData = await buildSpawnData();
      writeFileSync(catalogPath, JSON.stringify(spawnData.catalog, null, 2));

      const containerName = buildContainerName(opts.taskId);
      // Provider API keys come from the database, injected into the container
      // env so the agent-runner can read them via loadProviderKeys(). The base
      // sanitized env carries non-secret vars; DB-sourced keys are merged on top.
      const containerEnv = buildContainerEnv(
        { ...buildSanitizedEnv([]), ...spawnData.providerKeyEnv },
        opts.workDir,
        {
          briefPath: opts.briefPath,
          outputPath: opts.outputPath,
          workDir: opts.workDir,
          catalogPath,
          capability,
        },
      );

      console.log(`[${opts.taskId}] launching agent-runner in container ${containerName}`);

      // The podman client process forwards the container's stdout/stderr and
      // exits when the container does. Termination goes through
      // `podman stop <name>` — killing only the client would orphan the
      // container (the incident that motivated this isolation).
      const proc = spawnContainer(
        containerName,
        opts.workDir,
        config.coreLoop.asharaSourceDir,
        containerEnv,
      );
      activeContainers.add(containerName);

      const timer = setTimeout(() => {
        console.warn(
          `[${opts.taskId}] agent-runner exceeded ${config.coreLoop.agentTimeoutMs}ms — stopping container ${containerName}`,
        );
        void terminateContainer(containerName);
      }, config.coreLoop.agentTimeoutMs);
      try {
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          proc.on("close", resolve);
          proc.on("error", (err) => {
            // Fail closed: if podman itself cannot be spawned (missing binary,
            // permission denied), surface a typed error with full context.
            reject(new ContainerSpawnError({
              operation: "spawn",
              containerName,
              taskId: opts.taskId,
              exitCode: null,
              cause: err.message,
              stderr: "",
            }));
          });
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
        activeContainers.delete(containerName);
        // Ensure the container is cleaned up even on normal exit — belt +
        // suspenders with --rm. Idempotent: swallows "no such container".
        void terminateContainer(containerName);
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

  // Project frame — intent (ADR-046). vision_documents carries no work-item key:
  // a run plans exactly ONE vision, which every other reader also takes via
  // getLatest() (orchestrator/task-helpers.ts resolveTargetProjectPath). So the
  // root-id resolution is the check that this task belongs to a planned project,
  // and the latest vision is that project's stated intent. VERBATIM visionText,
  // never the summary: the paraphrase is the step that dropped "Go" in Run 36.
  // A task whose root cannot be resolved yields null and blocks the dispatch —
  // handing an agent some other project's intent would be worse than stopping.
  const intentSource: ProjectIntentSource = {
    async loadIntent(taskId: string): Promise<string | null> {
      const rootId = await resolveProjectRootId(taskId);
      if (!rootId) return null;
      const vision = await visionRepo.getLatest();
      return vision?.visionText ?? null;
    },
  };

  // Project frame — last-resort stack derivation (ADR-046). Runs only until the
  // project has a scaffold or a knowledge graph to read instead, so it is once per
  // project, not once per task. Temperature 0 (Discipline A: deterministic) and
  // laddered like every other structured planning call, with a validate that
  // rejects an empty answer so the ladder re-asks instead of returning nothing.
  let stackDeriver: StackDeriver | undefined;
  if (llmGateway) {
    const stackLadder = withStructuredLadder(llmGateway, {
      site: "stack-derivation",
      onAttempt: ladderAttemptSink,
    });
    const stackSchema = z.object({ stack: z.array(z.string().min(1)) });
    stackDeriver = {
      async deriveStack(intent: string): Promise<readonly string[]> {
        const response = await stackLadder.generateStructured({
          capability: "Strong",
          prompt: [
            `Read this project vision and state the implementation stack it targets.`,
            ``,
            `Vision:`,
            intent,
            ``,
            `Return LABELS ONLY — the names of the language, runtime, framework, database and`,
            `build tool the vision calls for (e.g. "Go", "SQLite", "Cobra"). Never return a`,
            `command, a file name, a version number, or an explanation.`,
            `State only what the vision supports. If it names a language, that language is first.`,
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no code fences.`,
            `Use exactly this format: {"stack": ["...", "..."]}`,
          ].join("\n"),
          schema: stackSchema,
          maxTokens: 512,
          temperature: 0,
          validate: (value) =>
            value.stack.length > 0
              ? { ok: true }
              : { ok: false, errors: ["The stack array is empty; name at least the implementation language."] },
        });
        return response.data.stack;
      },
    };
  }

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
      sandboxImage: `${SANDBOX_IMAGE}:${SANDBOX_TAG}`,
    },
    sessionStore,
    knowledgeSink,
    knowledgeSource,
    agentInvoker,
    conventionsExtractor,
    llmGateway,
    retrieveFn,
    eventSink: devEventSink,
    intentSource,
    stackDeriver,
    contractSource,
    contractAmender,
    // No extension list here: the indexer derives its file set from the grammars
    // the parser actually loaded, and reports what it could not cover.
    populateIndex: parserReady ? (targetPath) => indexer.indexDirectory(targetPath) : undefined,
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
    contractRepo,
    developmentService,
    embedder: proposalEmbedder,
    eventLogger,
    failureRouter,
    contractLookup,
    // Shares one DB transaction between decomposition's work-item creation and
    // its derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9); the
    // work-item half is re-adapted to the domain shape the same way the
    // top-level workItemRepo is (adaptWorkItemRepo).
    withPlanningTransaction: planningTransaction,
    acceptanceLlm: acceptanceLlm ?? undefined,
    // The entry point lives in the knowledge graph since ADR-038, not as a
    // top-level contract field.
    observeProduct: ({ targetPath, contract }) =>
      observeProduct({
        targetProjectPath: targetPath,
        contractEntryPoint: contract ? nodeByKind(contract.knowledge, "entry_point")?.label ?? null : null,
        contractEndpoints: contract?.endpoints ?? null,
      }),
    // Seeded to 0 and immediately overwritten by CoreLoop from the durable run
    // record on the first cycle (a resumed run keeps its spent attempts).
    acceptanceAttempts: 0,
    replanLlm: replanLlm ?? undefined,
    replanRounds: 0,
    runStateStore: runStateRepo,
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
    runner,
    // Bulk plan creation writes the derived ProjectContract in the SAME transaction
    // as the work items (mig9-t5) — a contract failure rolls the whole batch back.
    createBulkPlan: (items, edges, knowledge) =>
      createBulkPlanWithContract({ withPlanningTransaction: planningTransaction, runScope: RUN_SCOPE_AD_HOC }, items, edges, knowledge),
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
      devSessionStore: devSessionRepo,
      workdirBase: config.coreLoop.workdirBase,
      runStateStore: runStateRepo,
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
    // Stop every in-flight agent container (p0-isolation): `podman stop` sends
    // SIGTERM to PID 1 inside the container, then SIGKILL after a grace period.
    // Unlike killing the podman client, this actually stops the workload.
    const containers = [...activeContainers];
    if (containers.length > 0) {
      console.log(`Stopping ${containers.length} in-flight agent container(s)...`);
      await Promise.all(containers.map((name) => terminateContainer(name)));
    }
    server.close();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await runnerPromise;
  // The runner returning WITHOUT a shutdown signal means it stopped on its own
  // termination verdict: the run is over, so close the durable record and let the
  // next process start a fresh per-run budget. A SIGTERM/SIGINT exit deliberately
  // leaves it OPEN — that process was killed mid-run, and a restart must resume
  // the same cap rather than being handed the whole budget again.
  if (!shuttingDown) {
    // Terminalize this run's Pending and InProgress work items so the next run
    // starts from a clean board. The sweep is scoped to the ending run — ad-hoc,
    // pre-scoping, and other-run items are excluded (fail-closed: a run should
    // not destroy work it did not create). Blocked (owner-parked) and Failed
    // (startup-reconciler routes them) are also excluded by status.
    //
    // SIGTERM leaves items as-is: this block is behind `!shuttingDown`, so a
    // killed process never sweeps. The startup reconciler handles InProgress
    // (requeue) and Failed (FailureRouter) but NOT Pending — no reconciler
    // reclaims Pending crash-orphans from a killed run. The dispatch gate
    // will eventually pick them up (it selects all Pending Tasks regardless
    // of scope), but undispatched ones persist. Run-scoping widened this gap:
    // before, the next run's whole-board sweep cleaned them accidentally; now
    // the scoped sweep skips them (different scope).
    // Tracked as t-startup-reconciler-pending.
    try {
      const runState = await runStateRepo.load();
      if (runState && !runState.closed) {
        await terminalizeOnRunEnd({ workItemRepo, eventStore }, runState.runId);
      } else {
        console.warn(
          "[shutdown] skipping run-end sweep: no open run state found " +
            "(the runner may have errored before opening a run)",
        );
      }
    } catch (e) {
      console.warn("Shutdown work-item terminalization failed:", e);
    }
    await closeRun(runStateRepo);
  }
  console.log("Server and continuous runner stopped");
}


// open-by-design: generic type guard — narrows unknown to Record as a stepping stone
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPriorEnvelope(blockedReason: StoredBlockedReason | undefined): ReturnType<typeof tryParseEnvelope> {
  if (!blockedReason) return null;
  // Only the "replan" variant carries replanContext.
  if (blockedReason.source !== "replan") return null;
  const raw = blockedReason.replanContext.raw;
  if (!isRecord(raw)) return null;
  return tryParseEnvelope(raw);
}

function determineCapability(dispatchCount: number, blockedReason: StoredBlockedReason | undefined): string {
  if (dispatchCount === 0) return "Strong";

  const envelope = extractPriorEnvelope(blockedReason);
  if (!envelope) return "Strong";

  const category = classifyFailure(envelope);
  if (shouldEscalate(category, dispatchCount >= 2 ? [category] : [])) return "Frontier";

  return "Strong";
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
