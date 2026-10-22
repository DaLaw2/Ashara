import { EventStoreRepository } from "@ashara/db";
import type { createDb } from "@ashara/db";
import {
  DispatchService,
  FirstPlanner,
  ProjectHaltRepository,
  Replanner,
  WorkItemRowRepository,
  adaptWorkItemRepo,
  createFirstPlanStore,
  createReplanStore,
  withOverrides,
} from "@ashara/delivery";
import type {
  CoreLoopConfig,
  CoreLoopDeps,
  CoreLoopOverrides,
  DispatchServiceDeps,
  DispatchSteps,
  DispatchVerification,
  LoopCore,
  SweepSteps,
  TaskLanes,
} from "@ashara/delivery";
import {
  BlockReports,
  BurnWarnings,
  ClientAnswers,
  ClientChanges,
  ClientReceipts,
  ClientStops,
  PlanReports,
  StackChoiceReports,
  TenderIntake,
  askTaskQuestion,
  listProjectBurns,
  postBurnWarning,
  readRiskRecords,
  taskQuestionAnswered,
} from "@ashara/engagement";
import { releaseHeldCells, substrateProbe } from "@ashara/execution-infra";
import type { PodmanSubstrate } from "@ashara/execution-infra";
import type { ContextualLlm, WorkBudgets } from "@ashara/finance";
import { FailedApproachRepository } from "@ashara/knowledge";
import type { LadderAttemptEvent } from "@ashara/model-access";
import { RosterDerivation, WorkKindOwnerUnresolved, ownerOf, parseStoredRoster } from "@ashara/organization";
import { latestRosterRoles } from "@ashara/organization/roster";
import {
  AcceptanceSweeper,
  BaselineRevalidation,
  CellTeardown,
  CheckDisputeRepository,
  CheckHarvest,
  CheckPorts,
  CheckRecorder,
  CheckSetFreezeRepository,
  DeliveredOnMain,
  DispatchCells,
  FoundationGate,
  OwnershipGate,
  PostMergeChecks,
  SubstrateGate,
  SuiteReviewFindingRepository,
  SuiteReviewRun,
  TerminalSweeper,
} from "@ashara/quality";
import type { MainSweepDeps, SuiteReviewing } from "@ashara/quality";
import type { Logger, StepContainment } from "@ashara/shared";
import { createAcceptanceStore, createDeliveredReportStore, createDeliveredReports, createTerminalSweepStore } from "./acceptance-store.js";
import { createAnswerStore } from "./answer-store.js";
import { createBlockReportStore } from "./block-report-store.js";
import { createClientChangeStore } from "./client-change-store.js";
import { createClientReceiptStore } from "./client-receipt-store.js";
import { createClientStopStore } from "./client-stop-store.js";
import { createIntakeStore } from "./intake-store.js";
import { createPlanReportStore } from "./plan-report-store.js";
import { createRosterStore } from "./roster-store.js";
import { createStackChoiceStore } from "./stack-choice-store.js";

type Db = ReturnType<typeof createDb>;

/**
 * What the core loop's step groups are composed over: the database every repository reads, the
 * loop's policy, the model port every step's call goes through, and the ports whose infrastructure
 * the caller holds (the dispatcher, the sweepers of main and the cells).
 */
export interface CoreLoopParts {
  readonly db: Db;
  readonly config: CoreLoopConfig;
  readonly workBudgets: WorkBudgets;
  readonly logger: Logger;
  readonly cycleLog: LoopCore["cycleLog"];
  /** Finance's guarded port: every model call a step makes. */
  readonly llm: ContextualLlm;
  /** Where each structured-output ladder attempt of a step is written. */
  readonly onAttempt: (attempt: LadderAttemptEvent) => void;
  readonly spendCap: LoopCore["spendCap"];
  readonly containment: StepContainment;
  readonly failureRouter: DispatchSteps["failureRouter"];
  readonly taskLanes: TaskLanes;
  /** Aborted on shutdown, the dispatcher's own signal. */
  readonly shutdownSignal: AbortSignal;
  /** The dispatcher, composed by composeDispatchService. */
  readonly dispatchService: DispatchSteps["dispatchService"];
  /** The sweepers of main, composed by composeSweepers. */
  readonly sweepers: Pick<SweepSteps, "acceptanceSweeper" | "terminalSweeper">;
  /** The cells of this instance, composed by cellPortsOf. */
  readonly cells: Pick<DispatchSteps, "heldCells" | "infrastructureProbe">;
}

/** What a dispatcher is composed from: its own deps, and the suite review in place of the verification jobs built from them. */
export type DispatchComposition = Omit<DispatchServiceDeps, "verifiers"> & { readonly suiteReview: SuiteReviewing };

/**
 * Quality's verification jobs, one per stage, each built from the dispatcher's own cells, policy,
 * environment, checks, event sink and logger: Delivery's dispatcher receives them only as its ports.
 * @testseam compose-core-loop.test.ts reads each job it builds; composeDispatchService is its production caller
 */
export function composeVerifiers(deps: DispatchComposition): DispatchVerification {
  const { eventSink, logger, attemptPolicy, checks } = deps;
  const teardown = new CellTeardown({ eventSink, logger });
  const dispatchCells = new DispatchCells({ config: deps.config, cells: deps.cells, attemptPolicy, images: deps.environment.images, teardown });
  return {
    suiteReview: new SuiteReviewRun({ suiteReview: deps.suiteReview, eventSink, logger }),
    teardown,
    revalidation: new BaselineRevalidation({ dispatchCells, attemptPolicy, eventSink, logger }),
    delivered: new DeliveredOnMain({ dispatchCells, checks, eventSink, logger }),
    foundationGate: new FoundationGate({ dispatchCells, attemptPolicy, eventSink, logger }),
    checkPorts: new CheckPorts({ dispatchCells, eventSink, logger }),
    harvest: new CheckHarvest({ dispatchCells, checks, eventSink, logger }),
    ownershipGate: new OwnershipGate({ checks, eventSink, logger }),
    substrateGate: new SubstrateGate({ dispatchCells, attemptPolicy, statements: deps.environment.statements, eventSink, logger }),
    postMerge: new PostMergeChecks({ dispatchCells, attemptPolicy, environment: deps.environment, checks, eventSink, logger }),
    checkRecorder: { forAttempt: (cited) => new CheckRecorder(cited) },
  };
}

/** Delivery's dispatcher over Quality's verification jobs, composed from its own deps (composeVerifiers). */
export function composeDispatchService(deps: DispatchComposition): DispatchService {
  const { suiteReview, ...dispatch } = deps;
  return new DispatchService({ ...dispatch, verifiers: composeVerifiers({ ...dispatch, suiteReview }) });
}

/** Quality's sweeps of main, each over the same cells, policy, environment and checks, and one teardown of their cells. */
export function composeSweepers(deps: Omit<MainSweepDeps, "teardown"> & { readonly logger: Logger }): Pick<SweepSteps, "acceptanceSweeper" | "terminalSweeper"> {
  const { logger, ...sweep } = deps;
  const mainSweep: MainSweepDeps = { ...sweep, teardown: new CellTeardown({ ...(sweep.eventSink === undefined ? {} : { eventSink: sweep.eventSink }), logger }) };
  return { acceptanceSweeper: new AcceptanceSweeper(mainSweep), terminalSweeper: new TerminalSweeper(mainSweep) };
}

/** The cells this instance still holds, released each cycle, and the substrate probe an infrastructure halt waits on. */
export function cellPortsOf(substrate: Pick<PodmanSubstrate, "teardownAll" | "probeSubstrate">): Pick<DispatchSteps, "heldCells" | "infrastructureProbe"> {
  return { heldCells: { release: () => releaseHeldCells(substrate) }, infrastructureProbe: substrateProbe(substrate) };
}

/**
 * Every step group of the core loop, built from the real repositories over `parts.db`: the one
 * composition of CoreLoopDeps, which production's composeAshara and every integration test of the
 * loop call. `overrides` replace the members a test supplies itself.
 */
export function composeCoreLoopDeps(parts: CoreLoopParts, overrides: CoreLoopOverrides = {}): CoreLoopDeps {
  const { db, containment, llm, onAttempt, logger } = parts;
  // eslint-disable-next-line no-restricted-syntax -- production's one composition of the loop's deps
  return withOverrides(
    {
      loop: {
        config: parts.config,
        cycleLog: parts.cycleLog,
        logger,
        workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(db)),
        eventStore: new EventStoreRepository(db),
        projectRepo: new ProjectHaltRepository(db),
        spendCap: parts.spendCap,
        containment,
        taskLanes: parts.taskLanes,
        shutdownSignal: parts.shutdownSignal,
      },
      client: {
        clientStops: new ClientStops(createClientStopStore(db), containment),
        clientReceipts: new ClientReceipts(createClientReceiptStore(db), containment),
        clientChanges: new ClientChanges({ llm, store: createClientChangeStore(db, parts.workBudgets), containment, onAttempt }),
        liaisonIntake: new TenderIntake({ llm, store: createIntakeStore(db), containment, onAttempt }),
        liaisonAnswers: new ClientAnswers({ llm, store: createAnswerStore(db), containment, onAttempt }),
      },
      planning: {
        rosterDerivation: new RosterDerivation({ llm, store: createRosterStore(db), containment, onAttempt }),
        firstPlanning: new FirstPlanner({ llm, store: createFirstPlanStore(db), containment, onAttempt, logger }),
        replanning: new Replanner({ llm, store: createReplanStore(db, logger), containment, onAttempt, logger }),
      },
      dispatch: {
        dispatchService: parts.dispatchService,
        failedApproachRepo: new FailedApproachRepository(db),
        failureRouter: parts.failureRouter,
        checkDisputes: new CheckDisputeRepository(db),
        suiteReviewFindings: new SuiteReviewFindingRepository(db),
        checkSetFreeze: new CheckSetFreezeRepository(db),
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
        // A task's question for the client goes out on the channel intake's questions use.
        clientQuestions: { ask: (question) => askTaskQuestion(db, question), answered: (questionId) => taskQuestionAnswered(db, questionId) },
        heldCells: parts.cells.heldCells,
        infrastructureProbe: parts.cells.infrastructureProbe,
      },
      sweeps: {
        acceptanceSweeper: parts.sweepers.acceptanceSweeper,
        terminalSweeper: parts.sweepers.terminalSweeper,
        acceptance: createAcceptanceStore(db),
        terminalSweeps: createTerminalSweepStore(db),
      },
      reporting: {
        deliveredReports: createDeliveredReports(createDeliveredReportStore(db)),
        planReports: new PlanReports(createPlanReportStore(db), containment),
        stackChoices: new StackChoiceReports(createStackChoiceStore(db), containment),
        // One Liaison path for every project block's report: a dispute-bound block is reported by it too.
        blockReports: new BlockReports(createBlockReportStore(db), containment),
        burnWarnings: new BurnWarnings(
          {
            projectBurns: () => listProjectBurns(db),
            postWarning: (warning) => postBurnWarning(db, warning),
            riskRecords: (projectId) => readRiskRecords(db, projectId),
          },
          parts.workBudgets,
          containment,
        ),
      },
    },
    overrides,
  );
}
