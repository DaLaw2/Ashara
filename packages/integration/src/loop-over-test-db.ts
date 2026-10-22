import { concurrentTaskLanes, withOverrides } from "@ashara/delivery";
import type { CoreLoopDeps, CoreLoopOverrides } from "@ashara/delivery";
import { wholeDatabaseStepsIdle } from "@ashara/delivery/testing";
import { DEFAULT_WORK_BUDGETS } from "@ashara/finance";
import { composeCoreLoopDeps } from "@ashara/server/compose-core-loop";
import type { CoreLoopParts } from "@ashara/server/compose-core-loop";
import { notExercised } from "@ashara/shared/testing";

/**
 * What a suite composes its loop over. A suite whose loop dispatches nothing, routes no failure and
 * makes no model call leaves those parts out, and the loop throws NotExercised where one is called.
 */
type SuiteLoopParts = Pick<CoreLoopParts, "db" | "config" | "logger" | "spendCap" | "containment"> &
  Partial<Pick<CoreLoopParts, "llm" | "failureRouter" | "dispatchService">>;

/**
 * The loop as production composes it (composeCoreLoopDeps) over the test database, every step that
 * reads the whole database idle (wholeDatabaseStepsIdle, a required record of every step group):
 * over a shared database such a step would take in other suites' projects. The sweepers of main and
 * the cells are never reached; no step's model call is made, so the work budgets are the policy
 * default. `overrides` supply each member a suite exercises, and are applied over the idle steps.
 * @testseam only the integration tests of the loop compose it over the test database; production calls composeCoreLoopDeps
 */
export function composedLoopOverTestDb(parts: SuiteLoopParts, overrides: CoreLoopOverrides = {}): CoreLoopDeps {
  const composed = composeCoreLoopDeps(
    {
      llm: { forCall: notExercised("llm.forCall") },
      failureRouter: { route: notExercised("failureRouter.route") },
      dispatchService: { execute: notExercised("dispatchService.execute") },
      ...parts,
      workBudgets: DEFAULT_WORK_BUDGETS,
      cycleLog: { emit: () => {} },
      onAttempt: () => {},
      taskLanes: concurrentTaskLanes,
      shutdownSignal: new AbortController().signal,
      sweepers: {
        acceptanceSweeper: { sweepForAcceptance: notExercised("acceptanceSweeper.sweepForAcceptance") },
        terminalSweeper: { sweepForTerminal: notExercised("terminalSweeper.sweepForTerminal") },
      },
      cells: { heldCells: { release: async () => {} }, infrastructureProbe: { probe: notExercised("infrastructureProbe.probe") } },
    },
    wholeDatabaseStepsIdle(),
  );
  return withOverrides(composed, overrides);
}
