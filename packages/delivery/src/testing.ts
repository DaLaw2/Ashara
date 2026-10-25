/**
 * Delivery's test support, reached as `@ashara/delivery/testing`: only a test file or the test
 * harness may import it (test-only-subpaths in boundary-rules.toml), so no production path is built
 * on an inert dependency.
 */

import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import { inertWorkItemRepo } from "./domain/testing.js";
import { concurrentTaskLanes } from "./core-loop.js";
import { DEFAULT_CONFIG, withOverrides } from "./types.js";
import type { CoreLoopDeps, CoreLoopOverrides, LoopCore } from "./types.js";

/** @testseam the board's inert repository and item lock, re-exported for the tests of other packages; production builds neither */
export { inertWorkItemRepo, itemLockOver } from "./domain/testing.js";

const idle = async (): Promise<never[]> => [];

/**
 * Per step group, the members that read the whole database rather than one project's rows. Every
 * group of CoreLoopDeps is named (`never` for one with none) and each member named is one of its
 * group's, so a group added to the loop fails the type check here until it is classified.
 */
type EveryGroupClassified<Members extends { readonly [Group in keyof CoreLoopDeps]: keyof CoreLoopDeps[Group] }> = Members;
type WholeDatabaseMembers = EveryGroupClassified<{
  readonly loop: never;
  readonly client: keyof CoreLoopDeps["client"];
  readonly planning: keyof CoreLoopDeps["planning"];
  readonly dispatch: "checkSetFreeze";
  readonly sweeps: "acceptance" | "terminalSweeps";
  readonly reporting: keyof CoreLoopDeps["reporting"];
}>;

/** Every whole-database member of every step group, required: an idle set can leave none out. */
export type WholeDatabaseSteps = {
  readonly [Group in keyof CoreLoopDeps]: Pick<CoreLoopDeps[Group], WholeDatabaseMembers[Group] & keyof CoreLoopDeps[Group]>;
};

/**
 * Every step that reads the whole database, idle: each finds nothing to do, and no sweep's record is
 * written. The inert loop starts from them, and a loop over the shared test database applies them so
 * no step takes in other suites' projects. Fresh on each call: a test that replaces a member of one
 * step replaces it in its own deps only.
 */
export function wholeDatabaseStepsIdle(): WholeDatabaseSteps {
  return {
    loop: {},
    client: {
      clientStops: { runPending: idle },
      clientReceipts: { runPending: idle, dueMessages: async () => new Set() },
      clientChanges: { runPending: idle },
      liaisonIntake: { runPending: idle },
      liaisonAnswers: { runPending: idle },
    },
    planning: {
      rosterDerivation: { runPending: idle },
      firstPlanning: { runPending: idle },
      replanning: { runPending: idle },
    },
    dispatch: { checkSetFreeze: { freezeFor: idle } },
    sweeps: {
      acceptance: {
        readyForAcceptance: idle,
        recordAccepted: notExercised("acceptance.recordAccepted"),
        recordSweepFault: notExercised("acceptance.recordSweepFault"),
        recordDefect: notExercised("acceptance.recordDefect"),
      },
      terminalSweeps: { dueTerminalSweeps: idle, recordTerminalSweep: notExercised("terminalSweeps.recordTerminalSweep"), recordWithoutEvidence: notExercised("terminalSweeps.recordWithoutEvidence"), recordSweepFault: notExercised("terminalSweeps.recordSweepFault") },
    },
    reporting: {
      terminalReports: { runPending: idle },
      planReports: { runPending: idle },
      stackChoices: { runPending: idle },
      blockReports: { runPending: idle },
      burnWarnings: { runPending: idle },
    },
  };
}

/**
 * The projects of an idle loop: every list an idle cycle reads finds none, and every other member
 * throws NotExercised, but those `overrides` supply.
 * @testseam the loop's tests, over a database too, stand their projects in with it; production's is ProjectHaltRepository
 */
export function idleProjectRepo(overrides: Partial<LoopCore["projectRepo"]> = {}): LoopCore["projectRepo"] {
  return {
    get: notExercised("projectRepo.get"),
    recordWorkspacePath: notExercised("projectRepo.recordWorkspacePath"),
    listActiveIds: idle,
    block: notExercised("projectRepo.block"),
    listInfrastructureHalted: idle,
    resumeFromInfrastructureHalt: notExercised("projectRepo.resumeFromInfrastructureHalt"),
    listClientWaitHalted: idle,
    resumeFromClientWait: notExercised("projectRepo.resumeFromClientWait"),
    blockAllActive: idle,
    listWithWorkspace: idle,
    ...overrides,
  };
}

/**
 * The deps of an idle loop, for a unit test of the loop or of one of its steps: every step finds
 * nothing to do, every read an idle cycle makes finds nothing, and every other member throws
 * NotExercised; `overrides` supply each member a test exercises. Fully typed: a member CoreLoopDeps
 * gains is added here once, never in each test. A loop over a database is composed by the server's
 * composeCoreLoopDeps instead.
 * @testseam the loop's and its steps' unit tests build their deps with it; production's are composeCoreLoopDeps'
 */
export function inertCoreLoopDeps(overrides: CoreLoopOverrides = {}): CoreLoopDeps {
  const idleSteps = wholeDatabaseStepsIdle();
  // eslint-disable-next-line no-restricted-syntax -- the unit tests' one inert builder of the loop's deps
  return withOverrides(
    {
      loop: {
        config: { ...DEFAULT_CONFIG, workdirBase: "/nonexistent-inert-workdir" },
        cycleLog: { emit: () => {} },
        logger: recordingLogger(),
        workItemRepo: inertWorkItemRepo(),
        eventStore: { publish: notExercised("eventStore.publish") },
        projectRepo: idleProjectRepo(),
        spendCap: { deploymentStop: async () => null, refusalOf: () => null },
        containment: memoryStepContainment(() => false),
        taskLanes: concurrentTaskLanes,
        shutdownSignal: new AbortController().signal,
      },
      client: idleSteps.client,
      planning: idleSteps.planning,
      dispatch: {
        ...idleSteps.dispatch,
        dispatchService: { execute: notExercised("dispatchService.execute") },
        failedApproachRepo: { record: notExercised("failedApproachRepo.record") },
        failureRouter: { route: notExercised("failureRouter.route") },
        checkDisputes: { record: notExercised("checkDisputes.record") },
        suiteReviewFindings: { record: notExercised("suiteReviewFindings.record") },
        environmentOwner: notExercised("environmentOwner"),
        clientQuestions: { ask: notExercised("clientQuestions.ask"), answered: notExercised("clientQuestions.answered") },
        heldCells: { release: async () => {} },
        infrastructureProbe: { probe: notExercised("infrastructureProbe.probe") },
      },
      sweeps: {
        ...idleSteps.sweeps,
        acceptanceSweeper: { sweepForAcceptance: notExercised("acceptanceSweeper.sweepForAcceptance") },
        terminalSweeper: { sweepForTerminal: notExercised("terminalSweeper.sweepForTerminal") },
      },
      reporting: idleSteps.reporting,
    },
    overrides,
  );
}
