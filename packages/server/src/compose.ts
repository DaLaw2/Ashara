import { join } from "node:path";
import type { Hono } from "hono";
import {
  createDb,
  WorkItemRepository as DbWorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ProjectRepository,
  ConfigRepository,
  KnowledgeRepository,
  FailedApproachRepository,
  ContractRepository,
  SecretRepository,
  LlmCallRepository,
  ClientMessageRepository,
  ClientSessionRepository,
  ClientRepository,
  ClientLoginFailureRepository,
  EnvironmentBuildRepository,
  CheckDisputeRepository,
  SuiteReviewFindingRepository,
  createProjectWithTender,
  latestRosterRevision,
  latestRosterRoles,
  assertMigrationsCurrent,
  claimTargetCheckouts,
  MIGRATIONS_DIR,
  MigrationDriftError,
} from "@ashara/db";
import type { PoolFactory } from "@ashara/db";
import {
  CoreLoop,
  ContinuousRunner,
  EventLogger,
  reconcileOnStartup,
} from "@ashara/orchestrator";
import type { CoreLoopDeps, CycleRunner, TaskLanes } from "@ashara/orchestrator";
import {
  FailureRouter,
  FirstPlanner,
  Replanner,
} from "@ashara/planning";
import {
  DevelopmentService,
  SuiteReviewer,
  canonicalizeAllowingMissing,
  gitPublicInterface,
  pruneStaleEnvironmentImages,
} from "@ashara/development";
import { BlockReports, ClientAnswers, ClientStops, DeliveredReports, PlanReports, StackChoiceReports, TenderIntake } from "@ashara/engagement";
import { RosterDerivation, WorkKindOwnerUnresolved, ownerOf, parseStoredRoster } from "@ashara/organization";
import type {
  AgentStaffing,
  SessionStore,
  KnowledgeSink,
  KnowledgeSource,
  ExecutionEventSink,
  ContractSource,
  ProjectIntentSource,
  EnvironmentImages,
} from "@ashara/development";
import {
  ENVIRONMENT_BUILD_TIMEOUT_MS,
  PodmanSubstrate,
  buildEnvironmentImage,
  loadBaseCell,
  pruneEnvironmentImages,
  withGitRunner,
} from "@ashara/execution-infra";
import type { GitRunner, ProcessRunner } from "@ashara/execution-infra";
import {
  buildGateway,
  buildGatewayConfig,
  loadRoutingProfilesFromToml,
  loadThinkingPolicyFromToml,
  resolveModelsConfigPath,
  toModelConfig,
} from "@ashara/llm-gateway";
import type { LadderAttemptEvent, LanguageModelFactory, LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { SecretStore } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import type { Clock, ProjectId, ProjectContract } from "@ashara/shared";
import { contendedWait, parseWorkItemId } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning";
import { adaptWorkItemRepo } from "./work-item-adapter.js";
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import type { AppDeps } from "./routes.js";
import { cellInstanceFor, reconcileCellsAtStartup, substrateProbe, teardownCellsAtShutdown } from "./cells.js";
import {
  ServerStartupRefused,
  loadApiToken,
  resolveProviderCredentials,
} from "./secrets.js";
import { loadWebClientAssets } from "./web-client.js";
import { createAnswerStore } from "./answer-store.js";
import { createClientStopStore } from "./client-stop-store.js";
import { createIntakeStore } from "./intake-store.js";
import { createFirstPlanStore, createPlanReportStore } from "./first-plan-store.js";
import { createReplanStore } from "./replan-store.js";
import { createStackChoiceStore } from "./stack-choice-store.js";
import { createAcceptanceStore, createDeliveredReportStore } from "./acceptance-store.js";
import { createBlockReportStore } from "./block-report-store.js";
import { createSuiteReviewSource, createTaskCheckStore } from "./task-check-store.js";
import { reconcileOrRefuse } from "./fail-closed.js";
import { createRosterStore } from "./roster-store.js";
import { createAgentStaffing } from "./staffing.js";
import { determineCapability } from "./task-capability.js";

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

const CLIENT_LOGIN_THROTTLE = {
  windowSeconds: 15 * 60,
  perNameAndSource: 5,
  perSource: 20,
};

/**
 * What one Ashara process is composed over: its master key and database, and every outer boundary
 * as a port. The server's main supplies the production implementations.
 */
export interface AsharaPorts {
  readonly masterKey: MasterKey;
  readonly databaseUrl: string;
  /** The pool every repository's queries run on. */
  readonly createPool: PoolFactory;
  /** What each model request is sent to. */
  readonly models: LanguageModelFactory;
  /** Runs the container substrate's client binary (podman). */
  readonly processRunner: ProcessRunner;
  /** Runs every host git call. */
  readonly git: GitRunner;
  /** What attempts' wall clocks and the gateway's pricing instant read. */
  readonly clock: Clock;
  /** How the tasks of one cycle's batch run together (production: concurrentTaskLanes). */
  readonly taskLanes: TaskLanes;
}

/** One composed Ashara process: what its main starts, serves and shuts down. */
export interface AsharaInstance {
  /** One cycle of the core loop, every host git call in it through this instance's runner. */
  readonly cycles: CycleRunner;
  readonly runner: ContinuousRunner;
  readonly app: Hono;
  readonly port: number;
  /** Aborted by `abort()`: the runner stops and every attempt in flight is cancelled. */
  readonly shutdownSignal: AbortSignal;
  /**
   * Startup reconciliation (Discipline B), then the cells and environment images a previous
   * process left. MUST run before the runner starts cycling.
   */
  startup(): Promise<void>;
  abort(): void;
  /** Removes every cell of this instance. */
  teardownCells(): Promise<void>;
  /** Closes the database pool. */
  closeDatabase(): Promise<void>;
}

export async function composeAshara(ports: AsharaPorts): Promise<AsharaInstance> {
  const { masterKey, databaseUrl } = ports;
  // Fail closed on schema drift: a database that ran a different draft of a
  // migration otherwise surfaces only as a runtime query error.
  try {
    await assertMigrationsCurrent(databaseUrl, MIGRATIONS_DIR);
  } catch (err: unknown) {
    if (err instanceof MigrationDriftError) {
      throw new ServerStartupRefused(
        `The database schema does not match migrations/: ${err.message}`,
        `schema_migrations in ${redactedDatabaseUrl(databaseUrl)}`,
        driftFixes(err),
        { cause: err },
      );
    }
    throw err;
  }
  const db = createDb(databaseUrl, ports.createPool);
  const secretStore = new SecretStore(new SecretRepository(db), masterKey);
  console.log(`Secret store: master key ${masterKey.id}`);

  const dbWorkItemRepo = new DbWorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const projectRepo = new ProjectRepository(db);
  const configRepo = new ConfigRepository(db);
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
  // propagates to the caller and the server refuses to start.
  const pipelineLogPath = join(config.coreLoop.workdirBase, "pipeline.jsonl");
  const eventLogger = new EventLogger(pipelineLogPath);
  console.log(`Pipeline event log: ${pipelineLogPath}`);

  const ladderAttemptSink = (attempt: LadderAttemptEvent): void => {
    eventLogger.emit({ event: "ladder_attempt", ...attempt });
  };

  // Finance's cost ledger (K10) and its one spend cap, both on llm_calls: before
  // every provider request the gateway refuses an unpriced model and a call whose
  // worst case would cross the project's or the deployment's cap; after it, one
  // llm_calls row. The loop reads the same cap to stop at the deployment's.
  const llmCallRepo = new LlmCallRepository(db);
  const spendCap = new SpendCap({
    ledger: llmCallRepo,
    projects: projectRepo,
    caps: config.spendCaps,
    admissionTurn: (ahead) => contendedWait("spend-admission", ahead),
  });
  console.log(
    `Spend caps: deployment $${config.spendCaps.deploymentUsd}, per project $${config.spendCaps.perProjectUsd} (llm_calls)`,
  );
  const llmCallLedger = new LlmCallLedger(llmCallRepo, spendCap);
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
  const llmGateway: LLMGateway = buildGateway({
    config: gwConfig,
    checkedSources: ["secret store provider/<name>/api_key for each provider_configs row"],
    recording: { kind: "recorded", recorder: llmCallLedger },
    clock: () => new Date(ports.clock.now()),
    models: ports.models,
  });
  console.log("LLM gateway initialized");
  console.log(`Model catalog: ${dbModelRows.length} models loaded from DB`);

  const failureRouter = new FailureRouter(3);
  // Aborted on SIGTERM/SIGINT: stops the runner and cancels any attempt in flight.
  const abortController = new AbortController();
  // Taken by startup(), held until closeDatabase().
  let targetClaims: Awaited<ReturnType<typeof claimTargetCheckouts>> | null = null;

  const sessionStore: SessionStore = {
    insert: (sid, tid, brief, environmentVersion) => devSessionRepo.insert(sid, tid, brief, environmentVersion),
    complete: (sid, attempt, end) => devSessionRepo.complete(sid, attempt, end),
    fail: (sid, vr, attempt) => devSessionRepo.fail(sid, vr, attempt),
  };

  const knowledgeSink: KnowledgeSink = {
    storeFinding: (pid, tid, eid, title, content, tags) =>
      knowledgeRepo.storeKnowledgeFinding(pid, tid, eid, title, content, tags),
  };

  // Execution infrastructure: every tool call and every check runs in a cell on
  // this podman (s-isolated-worker-m1). The cells are labelled with this
  // deployment's instance, so startup reconciliation removes only its own.
  const cellSubstrate = new PodmanSubstrate({
    podmanPath: config.podmanBinary,
    mountRoot: config.coreLoop.workdirBase,
    runner: ports.processRunner,
    limits: config.cellLimits,
  });
  const cellInstance = cellInstanceFor(config.coreLoop.workdirBase);
  const environmentBuildRepo = new EnvironmentBuildRepository(db);
  const baseCell = await loadBaseCell();
  console.log(`Cells: substrate ${config.podmanBinary}, instance ${cellInstance}, base image ${baseCell.image}`);
  console.log(
    `Cell limits (every cell and image build): memory ${config.cellLimits.memoryBytes} bytes, ` +
      `${config.cellLimits.cpus} CPUs, ${config.cellLimits.pids} pids`,
  );

  // The agent half of each task's Assignment, resolved once per attempt: the work item's owner
  // role from the project's latest stored roster (s-team-roster-m1), and the model.
  const staffing: AgentStaffing = createAgentStaffing({
    async ownerOf(taskId) {
      const row = await dbWorkItemRepo.findById(taskId);
      return row === null ? { kind: "absent" } : { kind: "found", ownerRoleId: row.ownerRoleId };
    },
    latestRosterRows: (projectId) => latestRosterRoles(db, projectId),
    latestRosterRevision: (projectId) => latestRosterRevision(db, projectId),
    resolveModel(task) {
      const capability = determineCapability(task);
      const graded = task.taskSpec?.capability;
      if (capability !== graded) {
        console.log(`[${task.id}] model escalated from graded ${graded ?? "(none)"} to ${capability} (attempt ${task.attempt})`);
      }
      return llmGateway.resolveModel(capability, "agent-runner");
    },
  });

  const knowledgeSource: KnowledgeSource = {
    recentFindings: (scope, limit) =>
      knowledgeRepo.recentFindingsScoped(scope.projectId, scope.epicId, scope.queryText, limit),
    failedApproaches: (scope, limit) =>
      failedApproachRepo.failedApproachesScoped(scope.projectId, scope.epicId, scope.queryText, limit),
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
    const task = await workItemRepo.findById(parseWorkItemId(taskId, "taskId"));
    return task ? task.projectId : null;
  };

  // The task's project contract: its knowledge graph names the entry point.
  const contractSource: ContractSource = {
    async loadForTask(taskId: string): Promise<ProjectContract | null> {
      const projectId = await findTaskProjectId(taskId);
      return projectId ? contractRepo.getLatest(projectId) : null;
    },
  };

  // The brief's intent: the task's project's current vision, its VERBATIM
  // visionText (never the summary: the paraphrase is the step that dropped "Go"
  // in Run 36) and its assumptions, which Development parses.
  const intentSource: ProjectIntentSource = {
    async loadIntent(taskId: string) {
      const projectId = await findTaskProjectId(taskId);
      if (!projectId) return null;
      const vision = await visionRepo.getCurrent(projectId);
      return vision === null ? null : { version: vision.version, visionText: vision.visionText, inferences: vision.inferences };
    },
  };

  const environmentImages: EnvironmentImages = {
    build: (request) =>
      buildEnvironmentImage(request, {
        substrate: cellSubstrate,
        recorder: environmentBuildRepo,
        timeoutMs: ENVIRONMENT_BUILD_TIMEOUT_MS,
      }),
    prune: (projectId, keepVersion) => pruneEnvironmentImages(cellSubstrate, projectId, keepVersion),
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
    contractSource,
    cells: { substrate: cellSubstrate, baseCell, instance: cellInstance },
    llm: llmGateway,
    staffing,
    attemptPolicy: ATTEMPT_POLICY,
    environment: {
      images: environmentImages,
      statements: {
        record: (taskId, statement, version) => dbWorkItemRepo.recordEnvironmentStatement(taskId, statement, version),
        forVersion: (projectId, version) => dbWorkItemRepo.environmentStatementFor(projectId, version),
      },
    },
    checks: createTaskCheckStore(db),
    suiteReview: new SuiteReviewer({
      llm: llmGateway,
      source: createSuiteReviewSource(db),
      publicInterface: gitPublicInterface,
      onAttempt: ladderAttemptSink,
    }),
    shutdownSignal: abortController.signal,
    clock: ports.clock,
  });

  // One Liaison path for every project block's report: a dispute-bound block is reported by it too.
  const blockReports = new BlockReports(createBlockReportStore(db));
  const coreLoopDeps: CoreLoopDeps = {
    config: config.coreLoop,
    workItemRepo,
    eventStore,
    failedApproachRepo,
    projectRepo,
    developmentService,
    acceptanceSweeper: developmentService,
    acceptance: createAcceptanceStore(db),
    deliveredReports: new DeliveredReports(createDeliveredReportStore(db)),
    eventLogger,
    failureRouter,
    spendCap,
    clientStops: new ClientStops(createClientStopStore(db)),
    liaisonIntake: new TenderIntake({
      llm: llmGateway,
      store: createIntakeStore(db),
      onAttempt: ladderAttemptSink,
    }),
    liaisonAnswers: new ClientAnswers({
      llm: llmGateway,
      store: createAnswerStore(db),
      onAttempt: ladderAttemptSink,
    }),
    rosterDerivation: new RosterDerivation({
      llm: llmGateway,
      store: createRosterStore(db),
      onAttempt: ladderAttemptSink,
    }),
    firstPlanning: new FirstPlanner({
      llm: llmGateway,
      store: createFirstPlanStore(db),
      onAttempt: ladderAttemptSink,
    }),
    replanning: new Replanner({
      llm: llmGateway,
      store: createReplanStore(db),
      onAttempt: ladderAttemptSink,
    }),
    planReports: new PlanReports(createPlanReportStore(db)),
    stackChoices: new StackChoiceReports(createStackChoiceStore(db)),
    checkDisputes: new CheckDisputeRepository(db),
    blockReports,
    suiteReviewFindings: new SuiteReviewFindingRepository(db),
    infrastructureProbe: substrateProbe(cellSubstrate),
    taskLanes: ports.taskLanes,
    // The environment task an implementation needs is owned by the role doing environment work.
    async environmentOwner(projectId) {
      const roster = parseStoredRoster(projectId, await latestRosterRoles(db, projectId));
      try {
        return { kind: "role", roleId: ownerOf(roster, "environment").id };
      } catch (e) {
        if (!(e instanceof WorkKindOwnerUnresolved)) throw e;
        return { kind: "none", why: e.message };
      }
    },
  };

  const coreLoop = new CoreLoop(coreLoopDeps);

  const cycles: CycleRunner = {
    runCycle: () => withGitRunner(ports.git, () => coreLoop.runCycle()),
    runHaltedCycle: () => withGitRunner(ports.git, () => coreLoop.runHaltedCycle()),
  };

  const runner = new ContinuousRunner(cycles, { databaseUrl: config.databaseUrl });

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

  return {
    cycles,
    runner,
    app,
    port: config.port,
    shutdownSignal: abortController.signal,
    startup: () => withGitRunner(ports.git, async () => {
      // One process drives a target: the checkout lock that serialises its finalizes is
      // in-process only, so the claim is taken in the database before anything touches a target,
      // and a second process on the same targets refuses to start. Recorded targets are claimed
      // by path; targets this process mints later live under workdirBase/projects, claimed whole.
      const targets = [join(config.coreLoop.workdirBase, "projects"), ...(await projectRepo.listWithWorkspace()).map((p) => p.workspacePath)];
      targetClaims = await claimTargetCheckouts(databaseUrl, await Promise.all(targets.map(canonicalizeAllowingMissing)), (lost) => {
        console.error(`FATAL: ${lost.message}; stopping the runner, no target is driven unclaimed`);
        abortController.abort(lost);
      });

      // A prior process may have crashed mid-dispatch, leaving items InProgress with no owning
      // agent, or Failed with no recovery routed. Reset orphans to Pending and route parked Failed
      // items through the same FailureRouter policy so the gate (Pending-only) sees the recovered
      // work on the first cycle. Idempotent, and per-item fail-closed inside; a pass that throws as
      // a whole refuses the start.
      await reconcileOrRefuse(
        () =>
          reconcileOnStartup({
            workItemRepo,
            projects: projectRepo,
            eventStore,
            failureRouter,
            devSessionStore: devSessionRepo,
            workdirBase: config.coreLoop.workdirBase,
          }),
        `work items in ${redactedDatabaseUrl(databaseUrl)}, workdir ${config.coreLoop.workdirBase}`,
      );

      // Cells a previous process of this instance leaked, removed before any dispatch.
      await reconcileCellsAtStartup(cellSubstrate, cellInstance);

      // Environment images an earlier process left of versions main no longer uses (third run N12).
      // Pruning never fails the start: each project's failure is logged and retried next time.
      for (const project of await projectRepo.listWithWorkspace()) {
        await pruneStaleEnvironmentImages(project.id, project.workspacePath, environmentImages);
      }
    }),
    abort: () => abortController.abort(),
    teardownCells: () => teardownCellsAtShutdown(cellSubstrate),
    async closeDatabase() {
      await targetClaims?.release();
      await db.$client.end();
    },
  };
}

function redactedDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace(/\/\/[^@/]*@/, "//***@");
}

/** One repair per drifted file: the operator sees every file to fix, not the first. */
function driftFixes(err: MigrationDriftError): string {
  return err.drifts
    .map((d) => {
      switch (d.kind) {
        case "hash_mismatch":
          return (
            `repair the schema by hand to match the committed ${d.filename}, then set its ` +
            `schema_migrations.content_sha256 to ${d.fileSha256}; never edit an applied migration`
          );
        case "applied_without_file":
          return `restore ${d.filename} under the name it ran as; never rename or delete an applied migration`;
        case "not_applied":
        case "hash_unrecorded":
        case "tracking_table_missing":
          return "run `just migrate` against this database";
        case "no_migration_files":
          return "check out the repository's migrations/ directory";
      }
    })
    .filter((fix, i, all) => all.indexOf(fix) === i)
    .join("; ");
}
