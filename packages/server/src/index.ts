import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { serve } from "@hono/node-server";
import {
  createDb,
  WorkItemRepository as DbWorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ProjectRepository,
  ConfigRepository,
  CostRepository,
  KnowledgeRepository,
  FailedApproachRepository,
  ContractRepository,
  RunStateRepository,
  SecretRepository,
  LlmCallRepository,
  ClientMessageRepository,
  ClientSessionRepository,
  ClientRepository,
  ClientLoginFailureRepository,
  createProjectWithTender,
} from "@ashara/db";
import {
  CoreLoop,
  ContinuousRunner,
  EventLogger,
  reconcileOnStartup,
} from "@ashara/orchestrator";
import type { CoreLoopDeps } from "@ashara/orchestrator";
import {
  FailureRouter,
  FirstPlanner,
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "@ashara/planning";
import { DevelopmentService } from "@ashara/development";
import { PlanReports, TenderIntake } from "@ashara/engagement";
import type {
  StackDerivationScope,
  SessionStore,
  KnowledgeSink,
  KnowledgeSource,
  AgentInvoker,
  AgentSpawnOptions,
  ExecutionEventSink,
  ContractSource,
  ProjectIntentSource,
  StackDeriver,
} from "@ashara/development";
import { buildSanitizedEnv } from "@ashara/agent-runner";
import {
  BudgetLedger,
  buildGateway,
  buildGatewayConfig,
  loadRoutingProfilesFromToml,
  resolveModelsConfigPath,
  toModelConfig,
  LLMGateway,
  NoLLMProvidersConfigured,
  withStructuredLadder,
} from "@ashara/llm-gateway";
import type { GatewayCatalog, LadderAttemptEvent, ModelConfig } from "@ashara/llm-gateway";
import { LlmCallLedger } from "@ashara/finance";
import { SecretStore } from "@ashara/security";
import type { ProjectId, WorkItemId, ProjectContract, StoredBlockedReason } from "@ashara/shared";
import { ASHARA_CONTROL_DIR } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import { adaptWorkItemRepo } from "./work-item-adapter.js";
import { buildApp } from "./app.js";
import { loadServerConfig, loadDatabaseUrl } from "./config.js";
import type { AppDeps } from "./routes.js";
import { resolveAgentOutput } from "./agent-output.js";
import { ContainerSpawnError } from "./container-spawn.js";
import { PodmanProvisioner } from "./podman-provisioner.js";
import {
  ServerStartupRefused,
  buildProviderKeyEnv,
  loadApiToken,
  loadServerMasterKey,
  resolveProviderCredentials,
} from "./secrets.js";
import { loadWebClientAssets } from "./web-client.js";
import { createIntakeStore } from "./intake-store.js";
import { createFirstPlanStore, createPlanReportStore } from "./first-plan-store.js";

// Policy defaults for the web client's sessions (ADR-076). A session lasts a
// working day; a failed login answers one second after it arrived.
const CLIENT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CLIENT_LOGIN_FAILURE_DELAY_MS = 1000;
// Login throttle, per fifteen-minute window and per source (an IPv4 address or an
// IPv6 /64, source-network.ts), task t-login-hardening:
// - 5 per (name, source): a client is closed out only by its own source's failures.
// - 20 per source across names: one source cannot walk many names.
// No cap counts across sources, so no number of sources locks out a client, or
// every client, that they are not. The price is that distributed guessing is
// bounded per source, not in total; against that the code itself carries the
// entropy (MIN_CLIENT_ACCESS_CODE_LENGTH).
const CLIENT_LOGIN_THROTTLE = {
  windowSeconds: 15 * 60,
  perNameAndSource: 5,
  perSource: 20,
};

async function main(): Promise<void> {
  // Phase 1: the master key, before anything else — without it no credential
  // can be read (ADR-075 C2). Then the database URL from env or policy default.
  const masterKey = loadServerMasterKey(process.env);
  const databaseUrl = loadDatabaseUrl();
  const db = createDb(databaseUrl);
  const secretStore = new SecretStore(new SecretRepository(db), masterKey);
  console.log(`Secret store: master key ${masterKey.id}`);

  const dbWorkItemRepo = new DbWorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const projectRepo = new ProjectRepository(db);
  const configRepo = new ConfigRepository(db);
  const costRepo = new CostRepository(db);
  const runStateRepo = new RunStateRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const failedApproachRepo = new FailedApproachRepository(db);
  const contractRepo = new ContractRepository(db);

  const workItemRepo: WorkItemRepository = adaptWorkItemRepo(dbWorkItemRepo);

  // Phase 2: API token from the secret store (ADR-075 C4). Fail-closed: a
  // missing token means the server cannot authenticate any request.
  const apiToken = await loadApiToken(secretStore);

  const config = loadServerConfig(databaseUrl, apiToken);

  // Single composition-root call for the LLM gateway (ADR-030). There is no
  // silent fallback here: zero providers -> NoLLMProvidersConfigured
  // propagates out of this block and the server refuses to start (see catch
  // below).
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

  const ladderAttemptSink = (attempt: LadderAttemptEvent): void => {
    eventLogger.emit({ event: "ladder_attempt", ...attempt });
  };

  const budgetLedger = new BudgetLedger();
  // Finance's cost ledger (K10): the gateway refuses an unpriced model before
  // the request and writes one llm_calls row per provider request after it.
  const llmCallLedger = new LlmCallLedger(new LlmCallRepository(db));
  let llmGateway: LLMGateway;
  try {
    // Model catalog is DB-authoritative (seeded by migration 002_seed_models.sql).
    // Load from DB, convert to the llm-gateway ModelConfig shape, and build the
    // gateway config. Routing profiles remain deployment-specific TOML config.
    const dbModelRows = await configRepo.listModelConfigs();
    const models: Record<string, ModelConfig> = {};
    for (const row of dbModelRows) {
      models[row.modelId] = toModelConfig("model_configs", row);
    }
    // Provider keys from the secret store, one per provider_configs row
    // (ADR-075 C2). The agent-runner subprocess still reads keys from its own
    // environment; buildProviderKeyEnv fills it from the store at spawn time.
    const dbProviderRows = await configRepo.listProviderConfigs();
    const credentials = await resolveProviderCredentials(secretStore, dbProviderRows);
    const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
    const gwConfig = buildGatewayConfig(models, routingProfiles, credentials);
    gwConfig.budget = {
      maxCostTotal: config.coreLoop.budgetLimitUsd,
      maxCostPerProvider: gwConfig.budget?.maxCostPerProvider,
    };
    llmGateway = buildGateway({
      config: gwConfig,
      checkedSources: ["secret store provider/<name>/api_key for each provider_configs row"],
      ledger: budgetLedger,
      recording: { kind: "recorded", recorder: llmCallLedger },
      clock: () => new Date(),
    });
    console.log("LLM gateway initialized");
    console.log(`Model catalog: ${dbModelRows.length} models loaded from DB`);
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

  const failureRouter = new FailureRouter(3);

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

  // Build the gateway catalog and provider key env vars at spawn time. Fresh
  // per spawn so config changes between dispatches are picked up. The catalog
  // carries no secrets; keys travel as agent-runner env vars.
  interface SpawnData {
    readonly catalog: GatewayCatalog;
    readonly providerKeyEnv: Record<string, string>;
  }

  async function buildSpawnData(): Promise<SpawnData> {
    const [modelRows, providerRows] = await Promise.all([
      configRepo.listModelConfigs(),
      configRepo.listProviderConfigs(),
    ]);

    const catalog: GatewayCatalog = {
      models: modelRows.map((row) => ({
        modelId: row.modelId,
        providerName: row.providerName,
        apiModelId: row.apiModelId,
        capability: row.capability,
        inputCostPer1m: row.inputCostPer1m,
        outputCostPer1m: row.outputCostPer1m,
        cacheReadCostPer1m: row.cacheReadCostPer1m,
        cacheWriteCostPer1m: row.cacheWriteCostPer1m,
        maxContextTokens: row.maxContextTokens,
        priceWindows: row.priceWindows,
      })),
      providers: providerRows.map((row) => ({
        name: row.name,
        providerType: row.providerType,
        baseUrl: row.baseUrl,
      })),
    };

    // Story s-isolated-worker-m1 removes this host env injection (loop moves to Z0).
    const providerKeyEnv = await buildProviderKeyEnv(secretStore, providerRows);

    return { catalog, providerKeyEnv };
  }

  const provisioner = new PodmanProvisioner(config.coreLoop.workdirBase);

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

      // Agent-runner always runs on the host. When a provisioned container
      // exists, run_command routes commands into it via ASHARA_EXEC_CONTAINER;
      // otherwise commands execute locally.
      const agentEnv: Record<string, string> = {
        ...buildSanitizedEnv([]),
        ...spawnData.providerKeyEnv,
        ASHARA_BRIEF_PATH: opts.briefPath,
        ASHARA_OUTPUT_PATH: opts.outputPath,
        ASHARA_WORKING_DIR: opts.workDir,
        ASHARA_CATALOG_PATH: catalogPath,
        AGENT_CAPABILITY: capability,
      };

      const execContainerName = provisioner.activeContainerName();
      if (execContainerName) {
        agentEnv["ASHARA_EXEC_CONTAINER"] = execContainerName;
        agentEnv["ASHARA_HOST_WORKDIR"] = config.coreLoop.workdirBase;
        agentEnv["ASHARA_CONTAINER_MOUNT"] = provisioner.activeContainerMount() ?? "/workspace";
      }

      console.log(
        `[${opts.taskId}] launching agent-runner on host`
        + (execContainerName ? ` (exec container: ${execContainerName})` : " (local execution)"),
      );

      const proc = spawn("node", [
        resolve(config.coreLoop.asharaSourceDir, "node_modules/tsx/dist/cli.mjs"),
        resolve(config.coreLoop.asharaSourceDir, "packages/agent-runner/src/runner.ts"),
      ], {
        cwd: opts.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: agentEnv,
      });

      const timer = setTimeout(() => {
        console.warn(
          `[${opts.taskId}] agent-runner exceeded ${config.coreLoop.agentTimeoutMs}ms — killing host process`,
        );
        proc.kill("SIGTERM");
      }, config.coreLoop.agentTimeoutMs);
      try {
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        const exitCode = await new Promise<number | null>((resolveCode, reject) => {
          proc.on("close", resolveCode);
          proc.on("error", (err) => {
            reject(new ContainerSpawnError({
              operation: "host-spawn",
              containerName: execContainerName ?? "local",
              taskId: opts.taskId,
              exitCode: null,
              cause: err.message,
              stderr: "",
            }));
          });
        });

        if (stderr) console.log(`[${opts.taskId}] agent stderr:`, stderr.slice(0, 500));
        return await resolveAgentOutput(opts.taskId, opts.outputPath, exitCode, stderr);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const knowledgeSource: KnowledgeSource = {
    recentFindings: (scope, limit) => knowledgeRepo.recentFindingsScoped(scope.epicId, scope.queryText, limit),
    failedApproaches: (scope, limit) =>
      failedApproachRepo.failedApproachesScoped(scope.epicId, scope.queryText, limit),
  };

  const devEventSink: ExecutionEventSink = {
    emit: (event) => eventLogger.emit(event),
  };

  // A task's project is the project_id on its own row (migration 014): the
  // contract and the vision are both keyed by it, so no reader walks the parent
  // chain or falls back on a global latest. A task that cannot be found yields
  // null and blocks the dispatch — handing an agent some other project's
  // contract or intent would be worse than stopping.
  const findTaskProjectId = async (taskId: string): Promise<ProjectId | null> => {
    const task = await workItemRepo.findById(taskId as WorkItemId);
    return task ? task.projectId : null;
  };

  // The task's project contract: its knowledge graph feeds the project frame.
  const contractSource: ContractSource = {
    async loadForTask(taskId: string): Promise<ProjectContract | null> {
      const projectId = await findTaskProjectId(taskId);
      return projectId ? contractRepo.getLatest(projectId) : null;
    },
  };

  // Project frame — intent (ADR-046): the task's project's current vision,
  // VERBATIM visionText, never the summary: the paraphrase is the step that
  // dropped "Go" in Run 36.
  const intentSource: ProjectIntentSource = {
    async loadIntent(taskId: string): Promise<string | null> {
      const projectId = await findTaskProjectId(taskId);
      if (!projectId) return null;
      const vision = await visionRepo.getCurrent(projectId);
      return vision?.visionText ?? null;
    },
  };

  // Project frame — last-resort stack derivation (ADR-046). Runs only until the
  // project has a scaffold or a knowledge graph to read instead, so it is once per
  // project, not once per task. Laddered like every other structured planning
  // call, with a validate that
  // rejects an empty answer so the ladder re-asks instead of returning nothing.
  const stackSchema = z.object({ stack: z.array(z.string().min(1)) });
  const stackDeriver: StackDeriver = {
    async deriveStack(intent: string, scope: StackDerivationScope): Promise<readonly string[]> {
      const stackLadder = withStructuredLadder(
        llmGateway.forCall({ projectId: scope.projectId, taskId: scope.taskId, callSite: "stack-derivation" }),
        { site: "stack-derivation", onAttempt: ladderAttemptSink },
      );
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
        validate: (value) =>
          value.stack.length > 0
            ? { ok: true }
            : { ok: false, errors: ["The stack array is empty; name at least the implementation language."] },
      });
      return response.data.stack;
    },
  };

  const developmentService = new DevelopmentService({
    config: {
      workdirBase: config.coreLoop.workdirBase,
    },
    sessionStore,
    knowledgeSink,
    knowledgeSource,
    agentInvoker,
    llmGateway,
    eventSink: devEventSink,
    intentSource,
    stackDeriver,
    contractSource,
    provisioner,
  });

  const coreLoopDeps: CoreLoopDeps = {
    config: config.coreLoop,
    workItemRepo,
    eventStore,
    costRepo,
    failedApproachRepo,
    projectRepo,
    developmentService,
    eventLogger,
    failureRouter,
    runStateStore: runStateRepo,
    liaisonIntake: new TenderIntake({
      llm: llmGateway,
      store: createIntakeStore(db),
      onAttempt: ladderAttemptSink,
    }),
    firstPlanning: new FirstPlanner({
      llm: llmGateway,
      store: createFirstPlanStore(db),
      onAttempt: ladderAttemptSink,
    }),
    planReports: new PlanReports(createPlanReportStore(db)),
  };

  const coreLoop = new CoreLoop(coreLoopDeps);

  const runner = new ContinuousRunner(coreLoop, { databaseUrl: config.databaseUrl });

  const appDeps: AppDeps = {
    workItemRepo: dbWorkItemRepo,
    eventStore,
    devSessionRepo,
    visionRepo,
    projectRepo,
    clientMessageRepo: new ClientMessageRepository(db),
    clientRepo: new ClientRepository(db),
    createTender: (clientId, projectName, body) => createProjectWithTender(db, clientId, projectName, body),
  };

  // The web client (ADR-076) authenticates with a session cookie, never the API token.
  const app = buildApp(config.apiToken, appDeps, {
    projectRepo: appDeps.projectRepo,
    clientMessageRepo: appDeps.clientMessageRepo,
    clientRepo: appDeps.clientRepo,
    createTender: appDeps.createTender,
    secrets: secretStore,
    sessionRepo: new ClientSessionRepository(db),
    loginFailureRepo: new ClientLoginFailureRepository(db),
    loginThrottle: CLIENT_LOGIN_THROTTLE,
    sessionTtlSeconds: CLIENT_SESSION_TTL_SECONDS,
    loginFailureDelayMs: CLIENT_LOGIN_FAILURE_DELAY_MS,
    assets: loadWebClientAssets(),
  });

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
    // Agent-runner processes are host-spawned children — they inherit the
    // server's process group, so SIGTERM propagates naturally on shutdown.
    // Provisioned containers are cleaned up by DevelopmentService's teardown.
    server.close();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await runnerPromise;
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

main().catch((e: unknown) => {
  if (e instanceof ServerStartupRefused) {
    console.error(`FATAL: server refused to start. ${e.message}`);
  } else {
    console.error("Fatal error:", e);
  }
  process.exit(1);
});
