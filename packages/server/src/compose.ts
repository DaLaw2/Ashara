import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  createDb,
  EventStoreRepository,
  ClientSessionRepository,
  ClientRepository,
  ClientLoginFailureRepository,
  assertMigrationsCurrent,
  claimTargetCheckouts,
  MIGRATIONS_DIR,
  MigrationBaselineError,
  MigrationDriftError,
} from "@ashara/db";
import { EnvironmentBuildRepository } from "@ashara/execution-infra";
import { LlmCallRepository } from "@ashara/finance";
import { ConfigRepository } from "@ashara/model-access";
import { latestRosterRevision, latestRosterRoles } from "@ashara/organization/roster";
import { SecretRepository } from "@ashara/security";
import type { PoolFactory } from "@ashara/db";
import { KnowledgeRepository, FailedApproachRepository } from "@ashara/knowledge";
import type { KnowledgeSink, KnowledgeSource } from "@ashara/knowledge";
import {
  CoreLoop,
  ContinuousRunner,
  FailureRouter,
  ProjectHaltRepository,
  WorkItemRowRepository,
  adaptWorkItemRepo,
  assignmentIntentOf,
  createAgentStaffing,
  gradedCapability,
  reconcileWorkItemsOnStartup,
  stepContainment,
} from "@ashara/delivery";
import type { AgentStaffing, CycleRunner, TaskLanes, WorkItemRepository } from "@ashara/delivery";
import {
  VisionRepository,
  ClientMessageRepository,
  createProjectWithTender,
} from "@ashara/engagement";
import {
  SuiteReviewJudgementRepository,
  SuiteReviewer,
  gitPublicInterface,
  readEnvironmentDefinition,
} from "@ashara/quality";
import type { EnvironmentStatementStore, ExecutionEventSink } from "@ashara/quality";
import {
  ENVIRONMENT_BUILD_TIMEOUT_MS,
  PodmanSubstrate,
  buildEnvironmentImage,
  canonicalizeAllowingMissing,
  cellInstanceFor,
  loadBaseCell,
  pruneEnvironmentImages,
  pruneStaleEnvironmentImages,
  reconcileCellsAtStartup,
  teardownCellsAtShutdown,
  withGitRunner,
} from "@ashara/execution-infra";
import type { EnvironmentImages, GitRunner, ProcessRunner } from "@ashara/execution-infra";
import {
  buildGateway,
  buildGatewayConfig,
  loadContextOverflowFromToml,
  loadRoutingProfilesFromToml,
  loadThinkingPolicyFromToml,
  resolveModelsConfigPath,
  toModelConfig,
} from "@ashara/model-access";
import type { LadderAttemptEvent, LanguageModelFactory, LLMGateway, ModelConfig } from "@ashara/model-access";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { SecretStore } from "@ashara/security";
import { DevSessionRepository, terminalizeOrphanedSessions } from "@ashara/workplace";
import type { ProjectIntentSource, SessionStore } from "@ashara/workplace";
import type { MasterKey } from "@ashara/security";
import type { Clock, LogSink, Logger, ProjectId } from "@ashara/shared";
import { contendedWait, createLogger, parseWorkItemId } from "@ashara/shared";
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { sweepWorktreesAtStartup } from "./kept-worktrees.js";
import type { AppDeps } from "./routes.js";
import {
  ServerStartupRefused,
  loadApiToken,
  resolveProviderCredentials,
} from "./secrets.js";
import { loadWebClientAssets } from "./web-client.js";
import { createSuiteReviewSource, createTaskCheckStore } from "./task-check-store.js";
import { reconcileOrRefuse } from "./fail-closed.js";
import { createEventLog } from "./event-log.js";
import { cellPortsOf, composeCoreLoopDeps, composeDispatchService, composeSweepers } from "./compose-core-loop.js";

// Policy defaults for the web client's sessions. A session lasts a
// working day; a failed login answers one second after it arrived.
const CLIENT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CLIENT_LOGIN_FAILURE_DELAY_MS = 1000;
// Policy default: info and above reach the log; debug is subprocess and model-call detail.
const LOG_MIN_LEVEL = "info";
// The limits of one agent attempt. Its wall clock is Workplace's own default;
// 25 turns is a policy cap on the agent loop.
const ATTEMPT_POLICY = {
  maxTurns: 25,
  perCommandTimeoutSeconds: 300,
  toolTimeoutSeconds: 60,
};

// Login throttle, per fifteen-minute window and per source (an IPv4 address or an
// IPv6 /64, as Security's sourceNetwork counts it):
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
  /** Where every log record of this process goes (production: stdoutSink, one JSON line each). */
  readonly log: LogSink;
}

/** One composed Ashara process: what its main starts, serves and shuts down. */
export interface AsharaInstance {
  /**
   * One cycle of the core loop, every host git call in it through this instance's runner, numbered
   * and traced by `runner` as its own loop's cycles are.
   */
  readonly cycles: CycleRunner;
  readonly runner: ContinuousRunner;
  /**
   * The composition's one logger. Records outside every cycle, request, attempt and startup are
   * given a trace of their own on it by their caller: the boot's through `booted`, a shutdown's
   * by a scope it mints.
   */
  readonly logger: Logger;
  /**
   * Runs `work` in the process's boot trace, the scope root the composition itself ran in, so
   * what the process does to come up (startup, starting the runner, listening) joins that trace.
   */
  booted<T>(work: () => T): T;
  readonly app: Hono;
  readonly port: number;
  /** Aborted by `abort()`: the runner stops and every attempt in flight is cancelled. */
  readonly shutdownSignal: AbortSignal;
  /**
   * Startup reconciliation (Discipline B), then the cells and environment images a previous
   * process left, in its own trace. MUST run before the runner starts cycling.
   */
  startup(): Promise<void>;
  abort(): void;
  /** Removes every cell of this instance. */
  teardownCells(): Promise<void>;
  /** Closes the database pool. */
  closeDatabase(): Promise<void>;
}

export function composeAshara(ports: AsharaPorts): Promise<AsharaInstance> {
  // One logger per composition: its boot id tells this process's records from a dead one's.
  const logger = createLogger({ sink: ports.log, clock: ports.clock, minLevel: LOG_MIN_LEVEL });
  // The boot trace, a scope root: the composition's records, and those of whatever it starts,
  // join it rather than the logger's root trace, which no scope minted.
  return logger.scope({ trace: "new" }, () => composeInBoot(ports, logger, AsyncLocalStorage.snapshot()));
}

async function composeInBoot(ports: AsharaPorts, logger: Logger, inBootTrace: <T>(work: () => T) => T): Promise<AsharaInstance> {
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
    if (err instanceof MigrationBaselineError) {
      throw new ServerStartupRefused(
        `The database schema is not one migrations/ describes: ${err.message}`,
        `schema_migrations in ${redactedDatabaseUrl(databaseUrl)}`,
        err.refusal.kind === "init_file_missing"
          ? "check out the repository's migrations/ directory"
          : "bring the database to the last numbered migration from a checkout that still has those files, then run `just migrate`",
        { cause: err },
      );
    }
    throw err;
  }
  const db = createDb(databaseUrl, ports.createPool);
  const secretStore = new SecretStore(new SecretRepository(db), masterKey);
  logger.info("server.secret-store", `Secret store: master key ${masterKey.id}`, { masterKeyId: masterKey.id });

  const dbWorkItemRepo = new WorkItemRowRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const projectRepo = new ProjectHaltRepository(db);
  const configRepo = new ConfigRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const failedApproachRepo = new FailedApproachRepository(db);

  const workItemRepo: WorkItemRepository = adaptWorkItemRepo(dbWorkItemRepo);

  // Phase 2: API token from the secret store. Fail-closed: a
  // missing token means the server cannot authenticate any request.
  const apiToken = await loadApiToken(secretStore);

  const config = loadServerConfig(databaseUrl, apiToken);

  // Ladder attempts, execution events and completed cycles go to the server log as records,
  // timestamped by the injected clock. A ladder attempt's capability, attempt number, validation
  // errors and raw excerpt are in no llm_calls column, and an attempt the ladder judged invalid can
  // be an ok provider call there.
  // An event its schema refuses is logged at error with its issues, never thrown into the caller.
  const eventLog = createEventLog(logger);
  const ladderAttemptSink = (attempt: LadderAttemptEvent): void => eventLog.emit({ event: "ladder_attempt", ...attempt });

  // Finance's cost ledger, its one spend cap and its one work ledger, all on llm_calls: before
  // every provider request Finance's guarded port refuses an unpriced model, a call whose
  // worst case would cross the project's or the deployment's cap, and a call whose project or task
  // has drawn its budget of model requests, and writes the admitted call's
  // llm_calls row as pending; after it, the call's record completes that row. The loop reads the
  // same cap to stop at the deployment's.
  const llmCallRepo = new LlmCallRepository(db);
  const spendCap = new SpendCap({
    ledger: llmCallRepo,
    caps: config.spendCaps,
    workBudgets: config.workBudgets,
    admissionTurn: (ahead) => contendedWait("spend-admission", ahead),
  });
  logger.info(
    "server.spend-caps",
    `Spend caps: deployment $${config.spendCaps.deploymentUsd}, per project $${config.spendCaps.perProjectUsd} (llm_calls); ` +
      `work budgets: ${config.workBudgets.perTaskRequests} model requests per task, ${config.workBudgets.perProjectRequests} per project`,
  );
  const llmCallLedger = new LlmCallLedger(llmCallRepo, spendCap);
  // Model catalog is DB-authoritative (seeded by the init migration).
  // Load from DB, convert to the model-access ModelConfig shape, and build the
  // gateway config. Routing profiles remain deployment-specific TOML config.
  const dbModelRows = await configRepo.listModelConfigs();
  const models: Record<string, ModelConfig> = {};
  for (const row of dbModelRows) {
    models[row.modelId] = toModelConfig("model_configs", row);
  }
  // Provider keys from the secret store, one per provider_configs row:
  // their only source. The agent's turns run in this process
  // through this gateway, so no key leaves it.
  const dbProviderRows = await configRepo.listProviderConfigs();
  const credentials = await resolveProviderCredentials(secretStore, dbProviderRows);
  const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
  const gwConfig = buildGatewayConfig(
    models,
    routingProfiles,
    credentials,
    loadContextOverflowFromToml(resolveModelsConfigPath()),
    loadThinkingPolicyFromToml(resolveModelsConfigPath()),
  );
  // Single composition-root call for the LLM gateway. There is no
  // silent fallback here: zero providers -> NoLLMProvidersConfigured
  // propagates to the caller and the server refuses to start.
  const llmGateway: LLMGateway = buildGateway({
    config: gwConfig,
    checkedSources: ["secret store provider/<name>/api_key for each provider_configs row"],
    clock: () => new Date(ports.clock.now()),
    models: ports.models,
  });
  // Finance in front of Model Access: every model call below goes through this guarded port.
  const modelCalls = new GuardedModelAccess(llmGateway, llmCallLedger, logger);
  logger.info("server.gateway-ready", `LLM gateway initialized; model catalog: ${dbModelRows.length} models loaded from DB`, { models: dbModelRows.length });

  const failureRouter = new FailureRouter(3);
  // Aborted on SIGTERM/SIGINT: stops the runner and cancels any attempt in flight.
  const abortController = new AbortController();
  // Taken by startup(), held until closeDatabase().
  let targetClaims: Awaited<ReturnType<typeof claimTargetCheckouts>> | null = null;

  const sessionStore: SessionStore = {
    // Opened inside the dispatched attempt's scope: the session carries that attempt's trace.
    insert: (sid, tid, brief, environmentVersion) => devSessionRepo.insert(sid, tid, brief, environmentVersion, logger.trace()),
    complete: (sid, attempt, end) => devSessionRepo.complete(sid, attempt, end),
    fail: (sid, vr, attempt) => devSessionRepo.fail(sid, vr, attempt),
  };

  const knowledgeSink: KnowledgeSink = {
    storeFinding: (pid, tid, eid, title, content, tags) =>
      knowledgeRepo.storeKnowledgeFinding(pid, tid, eid, title, content, tags),
  };

  // Execution infrastructure: every tool call and every check runs in a cell on
  // this podman. The cells are labelled with this
  // deployment's instance, so startup reconciliation removes only its own.
  const cellSubstrate = new PodmanSubstrate({
    podmanPath: config.podmanBinary,
    mountRoot: config.coreLoop.workdirBase,
    runner: ports.processRunner,
    limits: config.cellLimits,
    logger,
  });
  const cellInstance = cellInstanceFor(config.coreLoop.workdirBase);
  const environmentBuildRepo = new EnvironmentBuildRepository(db);
  const baseCell = await loadBaseCell();
  logger.info(
    "server.cells",
    `Cells: substrate ${config.podmanBinary}, instance ${cellInstance}, base image ${baseCell.image}; limits (every cell and image ` +
      `build): memory ${config.cellLimits.memoryBytes} bytes, ${config.cellLimits.cpus} CPUs, ${config.cellLimits.pids} pids`,
    { instance: cellInstance, image: baseCell.image },
  );

  // The agent half of each task's Assignment, resolved once per attempt: the work item's owner
  // role from the project's latest stored roster, and the model.
  const staffing: AgentStaffing = createAgentStaffing({
    async ownerOf(taskId) {
      const row = await dbWorkItemRepo.findById(taskId);
      return row === null ? { kind: "absent" } : { kind: "found", ownerRoleId: row.ownerRoleId };
    },
    latestRosterRows: (projectId) => latestRosterRoles(db, projectId),
    latestRosterRevision: (projectId) => latestRosterRevision(db, projectId),
    resolveModel: (task) => modelCalls.resolveModel(gradedCapability(task), "agent-runner"),
    resolveWiderModel: (task, windowTokens) => modelCalls.resolveModelWithWindowAbove(gradedCapability(task), "agent-runner", windowTokens),
  });

  const knowledgeSource: KnowledgeSource = {
    recentFindings: (scope, limit) =>
      knowledgeRepo.recentFindingsScoped(scope.projectId, scope.epicId, scope.queryText, limit),
    failedApproaches: (scope, limit) =>
      failedApproachRepo.failedApproachesScoped(scope.projectId, scope.epicId, scope.queryText, limit),
  };

  const devEventSink: ExecutionEventSink = {
    emit: (event) => eventLog.emit(event),
  };

  // A task's project is the project_id on its own row: the
  // vision is keyed by it, so no reader walks the parent chain or falls back on
  // a global latest. A task that cannot be found yields null and blocks the
  // dispatch — handing an agent some other project's intent would be worse than
  // stopping.
  const findTaskProjectId = async (taskId: string): Promise<ProjectId | null> => {
    const task = await workItemRepo.findById(parseWorkItemId(taskId, "taskId"));
    return task ? task.projectId : null;
  };

  // The brief's intent: the task's project's current vision, its VERBATIM
  // visionText (never the summary: a paraphrase can drop what the client asked
  // for) and its assumptions, which Delivery renders for the Assignment.
  const intentSource: ProjectIntentSource = {
    async loadIntent(taskId: string) {
      const projectId = await findTaskProjectId(taskId);
      if (!projectId) return null;
      const vision = await visionRepo.getCurrent(projectId);
      return vision === null ? null : assignmentIntentOf(vision);
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

  const verificationCells = { substrate: cellSubstrate, instance: cellInstance };
  const environmentStatements: EnvironmentStatementStore = {
    record: (taskId, statement, version) => dbWorkItemRepo.recordEnvironmentStatement(taskId, statement, version),
    forVersion: (projectId, version) => dbWorkItemRepo.environmentStatementFor(projectId, version),
  };
  const taskChecks = createTaskCheckStore(db);
  // The sweeps of main are the core loop's, which no dispatch holds; the dispatcher calls each of
  // Quality's verification jobs, composed from its own deps, as a port.
  const sweepers = composeSweepers({
    config: { workdirBase: config.coreLoop.workdirBase },
    cells: verificationCells,
    attemptPolicy: ATTEMPT_POLICY,
    environment: { images: environmentImages, statements: environmentStatements },
    checks: taskChecks,
    eventSink: devEventSink,
    logger,
  });

  const dispatchService = composeDispatchService({
    config: {
      workdirBase: config.coreLoop.workdirBase,
    },
    sessionStore,
    knowledgeSink,
    knowledgeSource,
    eventSink: devEventSink,
    intentSource,
    cells: { substrate: cellSubstrate, baseCell, instance: cellInstance },
    llm: modelCalls,
    staffing,
    attemptPolicy: ATTEMPT_POLICY,
    environment: { images: environmentImages, statements: environmentStatements },
    checks: taskChecks,
    suiteReview: new SuiteReviewer({
      llm: modelCalls,
      source: createSuiteReviewSource(db),
      publicInterface: gitPublicInterface,
      judgements: new SuiteReviewJudgementRepository(db),
      onAttempt: ladderAttemptSink,
      logger,
    }),
    shutdownSignal: abortController.signal,
    clock: ports.clock,
    logger,
  });

  // One subject's fault in a cycle step is contained to it and kept in step_faults; only a
  // spend-cap refusal escapes to the cycle, which halts at the cap (CoreLoop.step).
  const containment = stepContainment(db, ports.clock, (error) => spendCap.refusalOf(error) !== null, logger);
  const coreLoopDeps = composeCoreLoopDeps({
    db,
    config: config.coreLoop,
    workBudgets: config.workBudgets,
    logger,
    cycleLog: eventLog,
    llm: modelCalls,
    onAttempt: ladderAttemptSink,
    spendCap,
    containment,
    failureRouter,
    taskLanes: ports.taskLanes,
    dispatchService,
    sweepers,
    cells: cellPortsOf(cellSubstrate),
  });

  const coreLoop = new CoreLoop(coreLoopDeps);

  const gitScopedCycles: CycleRunner = {
    runCycle: () => withGitRunner(ports.git, () => coreLoop.runCycle()),
    runHaltedCycle: () => withGitRunner(ports.git, () => coreLoop.runHaltedCycle()),
  };

  // The runner numbers every cycle and opens its trace, so a cycle a harness steps through
  // `cycles` is numbered and traced as one the runner's own loop runs.
  const runner = new ContinuousRunner(gitScopedCycles, logger, { databaseUrl: config.databaseUrl });
  const cycles: CycleRunner = runner;

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

  // The web client authenticates with a session cookie, never the API token.
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
  }, logger);

  return {
    cycles,
    runner,
    logger,
    booted: inBootTrace,
    app,
    port: config.port,
    shutdownSignal: abortController.signal,
    startup: () => logger.scope({ trace: "new" }, () => withGitRunner(ports.git, async () => {
      // One process drives a target: the checkout lock that serialises its finalizes is
      // in-process only, so the claim is taken in the database before anything touches a target,
      // and a second process on the same targets refuses to start. Recorded targets are claimed
      // by path; targets this process mints later live under workdirBase/projects, claimed whole.
      const targets = [join(config.coreLoop.workdirBase, "projects"), ...(await projectRepo.listWithWorkspace()).map((p) => p.workspacePath)];
      targetClaims = await claimTargetCheckouts(databaseUrl, await Promise.all(targets.map(canonicalizeAllowingMissing)), (lost) => {
        console.error(`FATAL: ${lost.message}; stopping the runner, no target is driven unclaimed`);
        abortController.abort(lost);
      });

      // A model call a prior process admitted and never recorded keeps counting against the spend
      // cap at its estimate, marked unmeasured_after_crash, before this process admits any call.
      await reconcileOrRefuse(
        () => llmCallLedger.reconcileAtStartup(),
        `llm_calls admissions in ${redactedDatabaseUrl(databaseUrl)}`,
      );

      // A prior process may have crashed mid-dispatch, leaving items InProgress with no owning
      // agent, or Failed with no recovery routed. Each orphan is settled from its target's main
      // (Completed with a merge found there, else back to Pending, else Blocked under a typed
      // cause) and parked Failed items are routed through the same FailureRouter policy, so the
      // gate (Pending-only) sees the recovered work on the first cycle. Idempotent; a pass that
      // throws, an orphan it could not even block included, refuses the start.
      // The tasks found InProgress are read first: only their open sessions are crash orphans.
      const inProgressAtStart = await workItemRepo.listIdsByStatus(["InProgress"]);
      await reconcileOrRefuse(
        () =>
          reconcileWorkItemsOnStartup({
            workItemRepo,
            projects: projectRepo,
            eventStore,
            failureRouter,
            devSessionStore: devSessionRepo,
            workdirBase: config.coreLoop.workdirBase,
            logger,
          }),
        `work items in ${redactedDatabaseUrl(databaseUrl)}, workdir ${config.coreLoop.workdirBase}`,
      );

      // Each context reconciles its own resources, in this order. Workplace's sessions after
      // Delivery's work items: a session a crash left open is Delivery's evidence that a dispatch
      // never finished. Execution Infrastructure's task worktrees after both, kept for every task
      // still open once its orphans are settled. Neither refuses the start; each logs its result.
      await terminalizeOrphanedSessions(devSessionRepo, inProgressAtStart);
      await sweepWorktreesAtStartup(config.coreLoop.workdirBase, workItemRepo);

      // Cells a previous process of this instance leaked, removed before any dispatch.
      await reconcileCellsAtStartup(cellSubstrate, cellInstance);

      // Environment images an earlier process left of versions main no longer uses.
      // Pruning never fails the start: each project's failure is logged and retried next time.
      for (const project of await projectRepo.listWithWorkspace()) {
        await pruneStaleEnvironmentImages(project.id, project.workspacePath, environmentImages, readEnvironmentDefinition);
      }
    })),
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
