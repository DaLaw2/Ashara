import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "vitest";
import { EventStoreRepository, createDb } from "@ashara/db";
import { DEFAULT_CONFIG, DispatchService, FailureRouter, FirstPlanner, ProjectHaltRepository, Replanner, concurrentTaskLanes } from "@ashara/delivery";
import { inertCoreLoopDeps } from "@ashara/delivery/testing";
import {
  BlockReports,
  BurnWarnings,
  ClientAnswers,
  ClientChanges,
  ClientReceipts,
  ClientStops,
  DeliveredReports,
  PlanReports,
  StackChoiceReports,
  TenderIntake,
} from "@ashara/engagement";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { DEFAULT_WORK_BUDGETS } from "@ashara/finance";
import { FailedApproachRepository } from "@ashara/knowledge";
import { RosterDerivation } from "@ashara/organization";
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
  FoundationGate,
  OwnershipGate,
  PostMergeChecks,
  SubstrateGate,
  SuiteReviewFindingRepository,
  SuiteReviewRun,
  TerminalSweeper,
} from "@ashara/quality";
import { systemClock } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import { cellPortsOf, composeCoreLoopDeps, composeDispatchService, composeSweepers, composeVerifiers } from "./compose-core-loop.js";
import type { CoreLoopParts, DispatchComposition } from "./compose-core-loop.js";

// A pool is opened lazily: no query runs, so the composition is built without a database.
const db = createDb("postgresql://compose-core-loop-test.invalid/none");

afterAll(async () => {
  await db.$client.end();
});

function parts(): CoreLoopParts {
  const idle = inertCoreLoopDeps();
  return {
    db,
    config: { ...DEFAULT_CONFIG, workdirBase: "/nonexistent-compose-core-loop" },
    workBudgets: DEFAULT_WORK_BUDGETS,
    logger: recordingLogger(),
    cycleLog: idle.loop.cycleLog,
    llm: { forCall: notExercised("forCall") },
    onAttempt: () => {},
    spendCap: idle.loop.spendCap,
    containment: memoryStepContainment(() => false),
    failureRouter: new FailureRouter(3),
    taskLanes: concurrentTaskLanes,
    shutdownSignal: idle.loop.shutdownSignal,
    dispatchService: idle.dispatch.dispatchService,
    sweepers: idle.sweeps,
    cells: idle.dispatch,
  };
}

describe("composeCoreLoopDeps", () => {
  test("builds every step group of the loop from the real repositories and steps", () => {
    const deps = composeCoreLoopDeps(parts());

    expect(deps.loop.eventStore).toBeInstanceOf(EventStoreRepository);
    expect(deps.loop.projectRepo).toBeInstanceOf(ProjectHaltRepository);
    expect(deps.client.clientStops).toBeInstanceOf(ClientStops);
    expect(deps.client.clientReceipts).toBeInstanceOf(ClientReceipts);
    expect(deps.client.clientChanges).toBeInstanceOf(ClientChanges);
    expect(deps.client.liaisonIntake).toBeInstanceOf(TenderIntake);
    expect(deps.client.liaisonAnswers).toBeInstanceOf(ClientAnswers);
    expect(deps.planning.rosterDerivation).toBeInstanceOf(RosterDerivation);
    expect(deps.planning.firstPlanning).toBeInstanceOf(FirstPlanner);
    expect(deps.planning.replanning).toBeInstanceOf(Replanner);
    expect(deps.dispatch.failedApproachRepo).toBeInstanceOf(FailedApproachRepository);
    expect(deps.dispatch.checkDisputes).toBeInstanceOf(CheckDisputeRepository);
    expect(deps.dispatch.suiteReviewFindings).toBeInstanceOf(SuiteReviewFindingRepository);
    expect(deps.dispatch.checkSetFreeze).toBeInstanceOf(CheckSetFreezeRepository);
    expect(deps.reporting.deliveredReports).toBeInstanceOf(DeliveredReports);
    expect(deps.reporting.planReports).toBeInstanceOf(PlanReports);
    expect(deps.reporting.stackChoices).toBeInstanceOf(StackChoiceReports);
    expect(deps.reporting.blockReports).toBeInstanceOf(BlockReports);
    expect(deps.reporting.burnWarnings).toBeInstanceOf(BurnWarnings);
  });

  test("hands the loop the parts its caller composed, never one reached through another", () => {
    const given = parts();
    const deps = composeCoreLoopDeps(given);

    expect(deps.dispatch.dispatchService).toBe(given.dispatchService);
    expect(deps.dispatch.failureRouter).toBe(given.failureRouter);
    expect(deps.sweeps.acceptanceSweeper).toBe(given.sweepers.acceptanceSweeper);
    expect(deps.sweeps.terminalSweeper).toBe(given.sweepers.terminalSweeper);
    expect(deps.dispatch.heldCells).toBe(given.cells.heldCells);
    expect(deps.dispatch.infrastructureProbe).toBe(given.cells.infrastructureProbe);
    expect(deps.loop.spendCap).toBe(given.spendCap);
    expect(deps.loop.containment).toBe(given.containment);
  });

  test("an override replaces only the member it names", () => {
    const replanning = { runPending: async () => [] };
    const deps = composeCoreLoopDeps(parts(), { planning: { replanning } });

    expect(deps.planning.replanning).toBe(replanning);
    expect(deps.planning.firstPlanning).toBeInstanceOf(FirstPlanner);
  });
});

describe("composeSweepers", () => {
  test("builds Quality's acceptance and terminal sweepers of main", () => {
    const sweepers = composeSweepers({
      config: { workdirBase: "/nonexistent-compose-core-loop" },
      cells: { substrate: new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot: "/nonexistent-compose-core-loop", runner: notExercised("runner") }), instance: "compose-core-loop-test" },
      attemptPolicy: { perCommandTimeoutSeconds: 30 },
      environment: {
        images: { build: notExercised("build"), prune: notExercised("prune") },
        statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
      },
      checks: { completedOf: notExercised("completedOf") },
      logger: recordingLogger(),
    });

    expect(sweepers.acceptanceSweeper).toBeInstanceOf(AcceptanceSweeper);
    expect(sweepers.terminalSweeper).toBeInstanceOf(TerminalSweeper);
  });
});

describe("cellPortsOf", () => {
  test("releases the substrate's held cells and probes it", async () => {
    const calls: string[] = [];
    const ports = cellPortsOf({
      teardownAll: async () => {
        calls.push("teardownAll");
        return [];
      },
      probeSubstrate: async () => {
        calls.push("probeSubstrate");
        return { version: "5.0.0", rootless: true };
      },
    });

    await ports.heldCells.release();
    const probed = await ports.infrastructureProbe.probe();

    expect(calls).toEqual(["teardownAll", "probeSubstrate"]);
    expect(probed).toMatchObject({ passed: true });
  });
});

/** A dispatcher's deps, none of which a composition calls. */
function dispatchComposition(): DispatchComposition {
  return {
    config: { workdirBase: tmpdir() },
    sessionStore: { insert: notExercised("insert"), complete: notExercised("complete"), fail: notExercised("fail") },
    knowledgeSink: { storeFinding: notExercised("storeFinding") },
    intentSource: { loadIntent: notExercised("loadIntent") },
    cells: {
      substrate: new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot: tmpdir(), runner: notExercised("runner") }),
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: "compose-dispatch-test",
    },
    llm: { forCall: notExercised("forCall") },
    staffing: { widerModel: notExercised("widerModel"), staff: notExercised("staff") },
    attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: notExercised("build"), prune: notExercised("prune") },
      statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
    },
    checks: {
      foundationOf: notExercised("foundationOf"),
      checkFilesOf: notExercised("checkFilesOf"),
      completedOf: notExercised("completedOf"),
      checkedTasksOf: notExercised("checkedTasksOf"),
      storedOfProject: notExercised("storedOfProject"),
      append: notExercised("append"),
      latest: notExercised("latest"),
    },
    suiteReview: { review: notExercised("review") },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
    logger: recordingLogger(),
  };
}

describe("composeVerifiers", () => {
  test("builds each of Quality's verification jobs, the real merge gates and checks, one instance of each job's class", () => {
    const verifiers = composeVerifiers(dispatchComposition());

    expect(verifiers.suiteReview).toBeInstanceOf(SuiteReviewRun);
    expect(verifiers.teardown).toBeInstanceOf(CellTeardown);
    expect(verifiers.revalidation).toBeInstanceOf(BaselineRevalidation);
    expect(verifiers.delivered).toBeInstanceOf(DeliveredOnMain);
    expect(verifiers.foundationGate).toBeInstanceOf(FoundationGate);
    expect(verifiers.checkPorts).toBeInstanceOf(CheckPorts);
    expect(verifiers.harvest).toBeInstanceOf(CheckHarvest);
    expect(verifiers.ownershipGate).toBeInstanceOf(OwnershipGate);
    expect(verifiers.substrateGate).toBeInstanceOf(SubstrateGate);
    expect(verifiers.postMerge).toBeInstanceOf(PostMergeChecks);
    const first = verifiers.checkRecorder.forAttempt(["v-1"]);
    expect(first).toBeInstanceOf(CheckRecorder);
    expect(verifiers.checkRecorder.forAttempt(["v-1"])).not.toBe(first);
  });

  test("composeDispatchService builds Delivery's dispatcher over them", () => {
    expect(composeDispatchService(dispatchComposition())).toBeInstanceOf(DispatchService);
  });
});
