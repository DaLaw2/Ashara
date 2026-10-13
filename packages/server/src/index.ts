import { join } from "node:path";
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
  assertMigrationsCurrent,
  MIGRATIONS_DIR,
  MigrationDriftError,
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
import { ClientStops, PlanReports, TenderIntake } from "@ashara/engagement";
import type {
  AgentStaffing,
  StackDerivationScope,
  SessionStore,
  KnowledgeSink,
  KnowledgeSource,
  ExecutionEventSink,
  ContractSource,
  ProjectIntentSource,
  StackDeriver,
} from "@ashara/development";
import { PodmanSubstrate, loadBaseCell } from "@ashara/execution-infra";
import {
  BudgetLedger,
  buildGateway,
  buildGatewayConfig,
  loadRoutingProfilesFromToml,
  loadThinkingPolicyFromToml,
  resolveModelsConfigPath,
  toModelConfig,
  LLMGateway,
  NoLLMProvidersConfigured,
  withStructuredLadder,
} from "@ashara/llm-gateway";
import type { LadderAttemptEvent, ModelConfig } from "@ashara/llm-gateway";
import { LlmCallLedger } from "@ashara/finance";
import { SecretStore } from "@ashara/security";
import type { CapabilityLevel, ProjectId, WorkItemId, ProjectContract, StoredBlockedReason } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning";
import { adaptWorkItemRepo } from "./work-item-adapter.js";
import { buildApp } from "./app.js";
import { loadServerConfig, loadDatabaseUrl } from "./config.js";
import type { AppDeps } from "./routes.js";
import { cellInstanceFor, reconcileCellsAtStartup, teardownCellsAtShutdown } from "./cells.js";
import {
  ServerStartupRefused,
  loadApiToken,
  loadServerMasterKey,
  resolveProviderCredentials,
} from "./secrets.js";
import { loadWebClientAssets } from "./web-client.js";
import { createClientStopStore } from "./client-stop-store.js";
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
// The limits of one agent attempt. Its wall clock is Workplace's own 20 minutes
// (ADR-074 d56); 25 turns is the cap the agent loop has always had.
const ATTEMPT_POLICY = {
  maxTurns: 25,
  perCommandTimeoutSeconds: 300,
  toolTimeoutSeconds: 60,
};
// Interim: s-team-roster-m1 replaces this with the roster's role for the task.
const AGENT_ROLE = "developer";

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
  // Fail closed on schema drift: a database that ran a different draft of a
  // migration otherwise surfaces only as a runtime query error.
  try {
    await assertMigrationsCurrent(databaseUrl, MIGRATIONS_DIR);
  } catch (err: unknown) {
    if (err instanceof MigrationDriftError) {
      throw new ServerStartupRefused(
        `The database schema does not match migrations/: ${err.message}`,
        `schema_migrations in ${databaseUrl.replace(/\/\/[^@/]*@/, "//***@")}`,
        err.kind === "hash_mismatch"
          ? `Repair the schema by hand to match the committed ${err.filename ?? "file"}, then set its ` +
            `schema_migrations.content_sha256 to ${err.fileSha256 ?? "the file's sha256"}; never edit an applied migration.`
          : "Run `just migrate` against this database.",
        { cause: err },
      );
    }
    throw err;
  }
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
    // (ADR-075 C2): their only source. The agent's turns run in this process
    // through this gateway, so no key leaves it.
    const dbProviderRows = await configRepo.listProviderConfigs();
    const credentials = await resolveProviderCredentials(secretStore, dbProviderRows);
    const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
    const gwConfig = buildGatewayConfig(models, routingProfiles, credentials);
    gwConfig.thinking = loadThinkingPolicyFromToml(resolveModelsConfigPath());
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
  // Aborted on SIGTERM/SIGINT: stops the runner and cancels any attempt in flight.
  const abortController = new AbortController();

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

  // Execution infrastructure: every tool call and every check runs in a cell on
  // this podman (s-isolated-worker-m1). The cells are labelled with this
  // deployment's instance, so startup reconciliation removes only its own.
  const cellSubstrate = new PodmanSubstrate({
    podmanPath: config.podmanBinary,
    mountRoot: config.coreLoop.workdirBase,
  });
  const cellInstance = cellInstanceFor(config.coreLoop.workdirBase);
  const baseCell = await loadBaseCell();
  console.log(`Cells: substrate ${config.podmanBinary}, instance ${cellInstance}, base image ${baseCell.image}`);

  // The agent half of each task's Assignment, resolved once per attempt.
  const staffing: AgentStaffing = {
    staff(task) {
      const capability = determineCapability(task.dispatchCount, task.blockedReason);
      if (capability === "Frontier") {
        console.log(`[${task.id}] model escalated to Frontier (attempt ${task.dispatchCount + 1})`);
      }
      return {
        role: AGENT_ROLE,
        model: llmGateway.resolveModel(capability, "agent-runner"),
      };
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
    eventSink: devEventSink,
    intentSource,
    stackDeriver,
    contractSource,
    cells: { substrate: cellSubstrate, baseCell, instance: cellInstance },
    llm: llmGateway,
    staffing,
    attemptPolicy: ATTEMPT_POLICY,
    shutdownSignal: abortController.signal,
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
    clientStops: new ClientStops(createClientStopStore(db)),
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
      projects: projectRepo,
      eventStore,
      failureRouter,
      devSessionStore: devSessionRepo,
      workdirBase: config.coreLoop.workdirBase,
    });
  } catch (e) {
    console.warn("Startup reconciliation failed; starting runner anyway:", e);
  }

  // Cells a previous process of this instance leaked, removed before any dispatch.
  await reconcileCellsAtStartup(cellSubstrate, cellInstance);

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
    // The abort cancels every attempt in flight; each dispatch then tears its
    // own cells down, and the drain below removes whatever is left.
    abortController.abort();
    server.close();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await runnerPromise;
  await teardownCellsAtShutdown(cellSubstrate);
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

function determineCapability(dispatchCount: number, blockedReason: StoredBlockedReason | undefined): CapabilityLevel {
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
