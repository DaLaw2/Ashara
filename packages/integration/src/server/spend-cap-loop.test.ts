import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, LlmCallRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { FailedApproachRepository } from "@ashara/knowledge";
import { DispatchService, ContinuousRunner, CoreLoop, DEFAULT_CONFIG, concurrentTaskLanes, FailureRouter, FirstPlanner, adaptWorkItemRepo, createFirstPlanStore, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import type { FirstPlanStore } from "@ashara/delivery";
import { BlockReports, ClientStops, ClientMessageRepository, DeliveredReports, PlanReports, VisionRepository } from "@ashara/engagement";
import type { BlockReportStore, ClientStopStore, DeliveredReportStore, PlanReportStore } from "@ashara/engagement";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import type { CoreLoopDeps } from "@ashara/delivery";
import { createWorkItemId, memoryStepContainment, parseProjectId, recordingLogger, systemClock, UnreadSubject } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import { createTerminalSweepStore } from "@ashara/server/acceptance-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { createPlanReportStore } from "@ashara/server/plan-report-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { CHECK_MISSING_EXIT } from "@ashara/workplace";
import { testCellInstance } from "../test-cells.js";
import { projectState } from "../simulator/project-state.js";
import { citingItemsToCheck } from "../simulator/scripted-models.js";
import { sweepTerminalsOf } from "./terminal-sweeps.js";

// The spend caps end to end: Finance refuses an LLM call made inside the loop, and the loop
// routes the refusal. Against Postgres; no real LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `spend-cap-loop-test-${randomUUID().slice(0, 8)}`;

const MODEL: ModelConfig = {
  id: "spend-cap-loop-model",
  apiModelId: "spend-cap-loop-model",
  provider: "deepseek",
  capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [], priceTiers: [], datedPrices: [],
};

type Db = ReturnType<typeof createDb>;
let db: Db;
let root = "";

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

function gatewayOn(spendCap: SpendCap, calls: LlmCallRepository): GuardedModelAccess {
  return new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true },
      ],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(calls, spendCap), recordingLogger());
}

/**
 * Every dep the loop takes, fully typed: a dep CoreLoopDeps gains and this omits is a compile
 * error here, never a TypeError the runner retries forever (a missing stackChoices did that).
 */
function loopDeps(parts: Partial<CoreLoopDeps> & Pick<CoreLoopDeps, "spendCap">): CoreLoopDeps {
  return {
    config: { ...DEFAULT_CONFIG, workdirBase: join(root, "unused") },
    cycleLog: { emit: () => {} },
    logger: recordingLogger(),
    containment: memoryStepContainment((error) => parts.spendCap.refusalOf(error) !== null),
    workItemRepo: {
      create: notExercised("create"),
      findById: notExercised("findById"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      save: notExercised("save"),
      incrementDispatchCount: notExercised("incrementDispatchCount"),
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      saveRefundedOverflow: async () => 0,
      recordCrashOrphan: async () => 1,
      saveOrphanExit: async () => {
        throw new Error("saveOrphanExit is not exercised by this test");
      },
      saveRefunded: notExercised("saveRefunded"),
      recordMergeCommit: notExercised("recordMergeCommit"),
      addDependency: notExercised("addDependency"),
      getDependencies: notExercised("getDependencies"),
      findChildren: notExercised("findChildren"),
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    },
    eventStore: { publish: notExercised("publish") },
    failedApproachRepo: { record: notExercised("record") },
    projectRepo: {
      get: notExercised("get"),
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: notExercised("listActiveIds"),
      block: notExercised("block"),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
      listWithWorkspace: async () => [],
    },
    dispatchService: { execute: notExercised("execute") },
    failureRouter: { route: notExercised("route") },
    clientStops: { runPending: async () => [] },
    clientChanges: { runPending: async () => [] },
    stackChoices: { runPending: async () => [] },
    liaisonIntake: { runPending: async () => [] },
    liaisonAnswers: { runPending: async () => [] },
    rosterDerivation: { runPending: async () => [] },
    firstPlanning: { runPending: async () => [] },
    replanning: { runPending: async () => [] },
    planReports: { runPending: async () => [] },
    checkDisputes: { record: notExercised("checkDisputes") },
    suiteReviewFindings: { record: notExercised("suiteReviewFindings") },
    checkSetFreeze: { freezeFor: async () => [] },
    blockReports: { runPending: async () => [] },
    burnWarnings: { runPending: async () => [] },
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    heldCells: { release: async () => {} },
    environmentOwner: notExercised("environmentOwner"),
    taskLanes: concurrentTaskLanes,
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    terminalSweeper: { sweepForTerminal: notExercised("sweepForTerminal") },
    terminalSweeps: { dueTerminalSweeps: async () => [], recordTerminalSweep: notExercised("recordTerminalSweep") },
    acceptance: { readyForAcceptance: async () => [], recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
    deliveredReports: { runPending: async () => [] },
    ...parts,
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-spend-cap-loop-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN ${projectIds}`);
  await db.execute(
    sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`,
  );
  await db.execute(sql`DELETE FROM failed_approaches WHERE task_id IN (SELECT id FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM client_messages WHERE direction = 'outbound' AND project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

describe("the deployment spend cap stops the loop", () => {
  test("a step's call refused at the deployment cap ends the run with the cap's reason, and the provider is never called", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectHaltRepository(db);
    const client = await new ClientRepository(db).create(NAME);
    const projectId = (await projects.create(NAME, client.id)).id;
    const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("the provider must not be called"); } });
    stub.model = mock;

    // No call fits under this cap, whatever other suites add to or delete from llm_calls meanwhile.
    const capUsd = 1e-9;
    const spendCap = new SpendCap({ ledger: calls, caps: { deploymentUsd: capUsd, perProjectUsd: capUsd } });
    const gateway = gatewayOn(spendCap, calls);

    const intake = vi.fn(async () => {
      await gateway
        .forCall({ projectId, taskId: null, callSite: "liaison-intake" })
        .generateStructured({ capability: "Strong", prompt: "read", schema: z.object({ ok: z.boolean() }), maxTokens: 64 });
      return [];
    });
    const roster = vi.fn(async () => []);
    // Only the steps this cycle reaches are real; anything else fails loudly.
    const deps = loopDeps({
      liaisonIntake: { runPending: intake },
      rosterDerivation: { runPending: roster },
      firstPlanning: { runPending: notExercised("firstPlanning") },
      replanning: { runPending: notExercised("replanning") },
      planReports: { runPending: notExercised("planReports") },
      spendCap: {
        deploymentStop: async () => {
          const stop = await spendCap.deploymentStop();
          // The first check, before intake, must let the step run so its refusal is what stops the loop.
          return intake.mock.calls.length === 0 ? null : stop;
        },
        refusalOf: (error: unknown) => spendCap.refusalOf(error),
      },
    });

    // The halt ends the work; the test then ends the halted runner, as SIGTERM does.
    const abort = new AbortController();
    const stop = await new ContinuousRunner(new CoreLoop(deps), recordingLogger(), { databaseUrl: null }).run(abort.signal, async () => abort.abort());

    expect(intake).toHaveBeenCalledTimes(1);
    expect(roster).not.toHaveBeenCalled();
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(stop?.reason).toMatch(/^budget_cap: the spend cap of the deployment/);
  });
});

// A stop accepted after the deployment cap stopped the runner is consumed and answered.
describe("a stop the client sends after the deployment cap halted the loop", () => {
  test("is recorded and answered by the halted runner, and holds when the halt is lifted", async () => {
    const projects = new ProjectHaltRepository(db);
    const messages = new ClientMessageRepository(db);
    const client = await new ClientRepository(db).create(`${NAME}-halted-stop`);
    const projectId = (await projects.create(NAME, client.id)).id;
    const stopStore = createClientStopStore(db);
    const narrowed: ClientStopStore = {
      ...stopStore,
      openStops: async () => (await stopStore.openStops()).filter((s) => s.projectId === projectId),
      dueStopReports: async () => (await stopStore.dueStopReports()).filter((due) => due.projectId === projectId),
    };
    const clientStops = new ClientStops(narrowed, memoryStepContainment(() => true));
    const abort = new AbortController();
    const base = loopDeps({ spendCap: { deploymentStop: notExercised("deploymentStop"), refusalOf: () => null } });
    const capReason = "budget_cap: the deployment has spent $1.000000 (llm_calls) of its $1.000000 cap";
    const deps = loopDeps({
      // Only this suite's project is halted: blockAllActive over the shared database would halt other suites' projects.
      projectRepo: {
        ...base.projectRepo,
        blockAllActive: async (cause) => ((await projects.block(projectId, cause)) === "blocked" ? [projectId] : []),
      },
      clientStops: {
        runPending: async () => {
          const taken = await clientStops.runPending();
          // The halted cycle's terminal sweep and the next halted cycle's stop step, here in one, so
          // the runner need not wait out its idle interval between them.
          await sweepTerminalsOf(db, (id) => id === projectId);
          const answered = await clientStops.runPending();
          // Once the stop is answered, the test ends the halted runner, as SIGTERM does.
          if (answered.some((outcome) => outcome.kind === "posted")) abort.abort();
          return [...taken, ...answered];
        },
      },
      spendCap: { deploymentStop: async () => ({ reason: capReason, spend: { capUsd: 5, spentUsd: 5, inFlightUsd: 0, nextCallUsd: null } }), refusalOf: () => null },
    });
    let stopId = "";

    const ended = await new ContinuousRunner(new CoreLoop(deps), recordingLogger(), { databaseUrl: null, idleIntervalMs: 60_000 }).run(abort.signal, async () => {
      // The halt is recorded as the deployment's cap before the client sends its stop.
      const halted = await db.execute(sql`SELECT ${projectState} AS status, blocked_error_class AS "errorClass" FROM projects WHERE id = ${projectId}`);
      expect(halted.rows).toEqual([{ status: "blocked", errorClass: SPEND_CAP_ERROR_CLASS.deployment }]);
      stopId = (await messages.insertInbound({ projectId, kind: "stop", body: "Please stop.", inReplyTo: null })).id;
    });

    expect(ended).toEqual({ reason: capReason, spend: { capUsd: 5, spentUsd: 5, inFlightUsd: 0, nextCallUsd: null } });
    const stopRow = await messages.findById(stopId);
    expect(stopRow?.consumedAt).not.toBeNull();
    const reports = (await messages.listByProject(projectId)).filter((m) => m.inReplyTo === stopId);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.body).toContain("Work on this project has stopped at your request.");
    expect(reports[0]?.body).toContain("Work on it was already paused when your request arrived.");
    expect(reports[0]?.body).toContain("clearing what paused it does not restart it");
    // The owner's raise of the cap and unblock does not resume a stopped project.
    await expect(projects.unblock(projectId, "operator-a", "cap raised")).rejects.toMatchObject({ name: "ProjectNotBlocked" });
    expect((await projects.get(projectId))?.status).toBe("stopped");
    expect(await projects.listActiveIds()).not.toContain(projectId);
  });
});

// The deployment's cap halts every active project, each with its report, including a project that
// never ran and one whose report's post faulted in the stopping cycle: the halted cycles retry it.
describe("the deployment cap halts two projects", () => {
  test("every project gets its budget_cap report, the faulted one on a halted cycle once its backoff passed", async () => {
    const projects = new ProjectHaltRepository(db);
    const messages = new ClientMessageRepository(db);
    const client = await new ClientRepository(db).create(`${NAME}-two-projects`);
    const first = (await projects.create(NAME, client.id)).id;
    const second = (await projects.create(NAME, client.id)).id;
    const ours = new Set([first, second]);
    const store = createBlockReportStore(db);
    const sweeps = createTerminalSweepStore(db);
    let secondFaults = 1;
    const projectOfEpisode = new Map<string, ProjectId>();
    // Only this suite's projects: the listing and the halt over the shared database would reach other suites'.
    const narrowed: BlockReportStore = {
      dueReports: async () => {
        const due = (await store.dueReports()).filter((each) => ours.has(each.projectId));
        for (const each of due) if (!(each instanceof UnreadSubject)) projectOfEpisode.set(each.episodeId, each.projectId);
        return due;
      },
      postProjectReport: async (episodeId, on, body, verdicts) => {
        if (projectOfEpisode.get(episodeId) === second && secondFaults > 0) {
          secondFaults -= 1;
          throw new Error("client_messages insert failed");
        }
        return store.postProjectReport(episodeId, on, body, verdicts);
      },
      riskRecords: (projectId) => store.riskRecords(projectId),
    };
    const capReason = "budget_cap: the spend cap of the deployment (every project) is $1.000000";
    const spend = { capUsd: 1, spentUsd: 1, inFlightUsd: 0, nextCallUsd: null };
    const base = loopDeps({ spendCap: { deploymentStop: notExercised("deploymentStop"), refusalOf: () => null } });
    const loop = new CoreLoop(
      loopDeps({
        projectRepo: {
          ...base.projectRepo,
          blockAllActive: async (cause) => {
            const halted: ProjectId[] = [];
            for (const id of ours) if ((await projects.block(id, cause)) === "blocked") halted.push(id);
            return halted;
          },
        },
        blockReports: new BlockReports(narrowed, memoryStepContainment(() => false)),
        // The halt's terminal sweep comes before its report; neither project has a workspace, so the
        // sweep records that it ran on no commit and the sweeper is never called.
        terminalSweeps: {
          dueTerminalSweeps: async () => (await sweeps.dueTerminalSweeps()).filter((due) => ours.has(due.projectId)),
          recordTerminalSweep: (sweep) => sweeps.recordTerminalSweep(sweep),
        },
        spendCap: { deploymentStop: async () => ({ reason: capReason, spend }), refusalOf: () => null },
      }),
    );
    const blockedReports = async (projectId: ProjectId) =>
      (await messages.listByProject(projectId)).filter((m) => m.direction === "outbound" && m.body.includes("The spending limit for all of Ashara's work has to be raised"));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const cycle = await loop.runCycle();
      expect(cycle.stop?.reason).toBe(capReason);
      expect(await blockedReports(first)).toHaveLength(1);
      expect(await blockedReports(second)).toHaveLength(0);

      // A halted cycle inside the backoff leaves the faulted report for later; one past it posts it.
      await loop.runHaltedCycle();
      expect(await blockedReports(second)).toHaveLength(0);
      vi.setSystemTime(Date.now() + 61_000);
      await loop.runHaltedCycle();
      await loop.runHaltedCycle();
    } finally {
      vi.useRealTimers();
    }

    expect(await blockedReports(first)).toHaveLength(1);
    expect(await blockedReports(second)).toHaveLength(1);
    for (const id of ours) {
      const halted = await db.execute(sql`SELECT ${projectState} AS status, blocked_error_class AS "errorClass" FROM projects WHERE id = ${id}`);
      expect(halted.rows).toEqual([{ status: "blocked", errorClass: SPEND_CAP_ERROR_CLASS.deployment }]);
    }
  });
});

type DueDeliveredReport = Extract<Awaited<ReturnType<DeliveredReportStore["dueReports"]>>[number], { readonly kind: "due" }>;

// An accepted project's delivered report whose post faulted in the cycle that stops at the cap: no
// full cycle runs again in this process, so the halted cycles retry it once its backoff passed.
describe("the deployment cap stops the cycle an accepted project's delivered report faulted in", () => {
  test("the project still gets exactly one delivered report, on a halted cycle once its backoff passed", async () => {
    const projectId = parseProjectId(randomUUID(), "test project");
    const due: DueDeliveredReport = {
      kind: "due",
      failures: 0,
      interfaceReadFailures: 0,
      recordFailures: 0,
      sweepId: randomUUID(),
      projectId,
      mainCommit: "c3".repeat(20),
      targetProjectPath: join(root, "unused"),
      goals: [{ title: "Store keys", close: { kind: "merged", commit: "a1".repeat(20) } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      executed: { kind: "unrecorded" },
      guarantees: { kind: "no-contract", sweep: { id: randomUUID(), mainCommit: "c3".repeat(20) } },
      reading: { kind: "unrecorded" },
    };
    const posted: string[] = [];
    let postFaults = 1;
    let failures = 0;
    let retryAt = 0;
    // The sweep's report columns, held here: the listing honours the retry time the failure set, as acceptance_sweeps.report_retry_at does.
    const store: DeliveredReportStore = {
      dueReports: async () => (posted.length > 0 || Date.now() < retryAt ? [] : [{ ...due, failures }]),
      guaranteeTable: async () => due.guarantees,
      postReport: async (_sweepId, body) => {
        if (postFaults > 0) {
          postFaults -= 1;
          throw new Error("client_messages insert failed");
        }
        posted.push(body);
        return "posted";
      },
      recordReportFailure: async (_sweepId, failure) => {
        if (failure.retryAfterSeconds === null) return;
        failures += 1;
        retryAt = Date.now() + failure.retryAfterSeconds * 1000;
      },
    };
    const capReason = "budget_cap: the spend cap of the deployment (every project) is $1.000000";
    const loop = new CoreLoop(
      loopDeps({
        deliveredReports: new DeliveredReports(store, { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) }),
        spendCap: { deploymentStop: async () => ({ reason: capReason, spend: { capUsd: 1, spentUsd: 1, inFlightUsd: 0, nextCallUsd: null } }), refusalOf: () => null },
      }),
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const cycle = await loop.runCycle();
      expect(cycle.stop?.reason).toBe(capReason);
      expect(failures).toBe(1);
      expect(posted).toHaveLength(0);

      // A halted cycle inside the backoff leaves the faulted report for later; one past it posts it, once.
      await loop.runHaltedCycle();
      expect(posted).toHaveLength(0);
      vi.setSystemTime(Date.now() + 61_000);
      await loop.runHaltedCycle();
      await loop.runHaltedCycle();
    } finally {
      vi.useRealTimers();
    }

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Store keys");
  });
});

const PLAN_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Create the class list", description: "List classes.", dependsOn: [], goal: "",
      endState: "Classes are listed", scope: "class listing", deliverables: [{ text: "class list", sources: ["S1"] }], acceptance: [{ text: "a client uses the class list", sources: ["S1"] }],
      capability: "Strong", capabilityReason: "graded for the test",
    },
  ],
};

// A first plan written in the cycle whose cap check stops the loop: the cycle halts before its plan
// report step, and no full cycle runs again in this process, so the halted cycles report the plan.
describe("the deployment cap stops the cycle a first plan was written in", () => {
  test("the project still gets exactly one first-plan report, on a halted cycle", async () => {
    const projects = new ProjectHaltRepository(db);
    const messages = new ClientMessageRepository(db);
    const client = await new ClientRepository(db).create(`${NAME}-plan-at-cap`);
    const projectId = (await projects.create(NAME, client.id)).id;
    await new VisionRepository(db).create(projectId, {
      visionText: "A class list for my pottery studio.",
      summary: "A class list for a pottery studio.",
      scopeBoundaries: ["In: class listing"],
      inferences: [],
    });
    const roles = [
      { id: randomUUID(), name: "Liaison", responsibility: "Talks to the client.", capabilities: ["client-comms"] as const },
      { id: randomUUID(), name: "Platform", responsibility: "Defines how the product is built and tested.", capabilities: ["write-environment"] as const },
      { id: randomUUID(), name: "Implementer", responsibility: "Builds the product.", capabilities: ["write-source"] as const },
      { id: randomUUID(), name: "Check author", responsibility: "Writes the checks.", capabilities: ["author-checks"] as const },
    ] as const;
    expect(await createRosterStore(db).recordRoster({ projectId, visionVersion: 1, revision: 1, roles: [...roles] })).toBe("recorded");
    stub.model = new MockLanguageModelV4({
      doGenerate: async (call) => ({
        content: [{ type: "text" as const, text: JSON.stringify(citingItemsToCheck(PLAN_TASKS, JSON.stringify(call.prompt))) }],
        usage: {
          inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 200, text: 200, reasoning: undefined },
        },
        finishReason: { unified: "stop" as const, raw: "stop" },
        warnings: [],
      }),
    });
    const calls = new LlmCallRepository(db);
    const gateway = gatewayOn(new SpendCap({ ledger: calls, caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } }), calls);
    const planStore = createFirstPlanStore(db);
    const narrowedPlans: FirstPlanStore = { ...planStore, projectsAwaitingPlan: async () => (await planStore.projectsAwaitingPlan()).filter((p) => p.projectId === projectId) };
    const planner = new FirstPlanner({ logger: recordingLogger(), containment: memoryStepContainment(() => false), llm: gateway, store: narrowedPlans });
    const reportStore = createPlanReportStore(db);
    // Only this suite's project: the listings over the shared database would reach other suites'.
    const narrowedReports: PlanReportStore = {
      ...reportStore,
      dueReports: async () => (await reportStore.dueReports()).filter((r) => r.projectId === projectId),
      dueRevisionReports: async () => (await reportStore.dueRevisionReports()).filter((r) => r.projectId === projectId),
    };
    let planned = false;
    const capReason = "budget_cap: the spend cap of the deployment (every project) is $1.000000";
    const base = loopDeps({ spendCap: { deploymentStop: notExercised("deploymentStop"), refusalOf: () => null } });
    const loop = new CoreLoop(
      loopDeps({
        projectRepo: {
          ...base.projectRepo,
          blockAllActive: async (cause) => ((await projects.block(projectId, cause)) === "blocked" ? [projectId] : []),
        },
        firstPlanning: {
          runPending: async () => {
            const outcomes = await planner.runPending();
            planned = true;
            return outcomes;
          },
        },
        planReports: new PlanReports(narrowedReports, memoryStepContainment(() => false)),
        // The plan's model call is what reaches the cap: the check after the first-plan step stops the loop.
        spendCap: {
          deploymentStop: async () => (planned ? { reason: capReason, spend: { capUsd: 1, spentUsd: 1, inFlightUsd: 0, nextCallUsd: null } } : null),
          refusalOf: () => null,
        },
      }),
    );
    const planReports = async () => (await messages.listByProject(projectId)).filter((m) => m.direction === "outbound" && m.body.includes("Ashara has made the first plan"));

    const cycle = await loop.runCycle();
    expect(cycle.stop?.reason).toBe(capReason);
    expect((await projects.get(projectId))?.status).toBe("blocked");
    expect(await planReports()).toHaveLength(0);

    await loop.runHaltedCycle();
    await loop.runHaltedCycle();

    const posted = await planReports();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("split into 1 task for what you asked for");
  });
});

const run = promisify(execFile);

/** A substrate whose podman answers from a script: every cell starts, every exec succeeds. */
function scriptedSubstrate(mountRoot: string): PodmanSubstrate {
  const ok = (stdout = "") => ({
    exitCode: 0, signal: null, stdout, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null,
    statusReport: null,
  });
  return new PodmanSubstrate({ logger: recordingLogger(), 
    podmanPath: "podman",
    mountRoot,
    runner: async ({ args }) => {
      switch (args[0]) {
        case "info":
          return ok(JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } }));
        case "run":
          return ok(`${"a".repeat(64)}\n`);
        // Every command exits the check's verdict that the work is missing: the stored check, red-run again on its baseline on the BaseCell (its
        // version differs from the check's), still fails there and on main, so the dispatch reaches the model.
        case "exec":
          return { ...ok(), exitCode: CHECK_MISSING_EXIT, statusReport: `${CHECK_MISSING_EXIT}\n` };
        case "rm":
          return ok();
        default:
          throw new Error(`unexpected podman ${args.join(" ")}`);
      }
    },
  });
}

describe("a turn refused at the project's spend cap", () => {
  // A refusal at the cap is not an attempt's failure: it never ends the attempt as
  // transport_exhausted, never sends the item to Failed or the FailureRouter, and writes no lesson.
  test("returns the item to Pending with its dispatch unconsumed and no lesson, and blocks the project budget_cap", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectHaltRepository(db);
    const client = await new ClientRepository(db).create(`${NAME}-refused-turn`);
    const projectId = (await projects.create(NAME, client.id)).id;
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", projectId);
    await mkdir(target, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: target });
    await writeFile(join(target, "README"), "a greeting project\n");
    await run("git", ["add", "README"], { cwd: target });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: target });
    const baselineCommit = (await run("git", ["rev-parse", "main"], { cwd: target })).stdout.trim();

    const itemId = createWorkItemId();
    await new WorkItemRowRepository(db).create({
      id: itemId,
      level: "Task",
      status: "Pending",
      title: "Write greet.txt",
      // Sprint 0 runs on the BaseCell, so no environment has to be resolved for the task.
      taskSpec: { goal: "write greet.txt", endState: "greet.txt exists", scope: "greet.txt", deliverables: ["greet.txt"], origin: "sprint0" },
      projectId,
    });

    // The cap is $0.20. Turn 1's worst case (16,384 output tokens at $10/1M, about $0.164, plus its
    // input) fits and it records about $0.05 of spend; turn 2's worst case on top of that cannot fit.
    // Turn 1's input stays inside the model's window, so the window guard never decides this turn.
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName: "run_command", input: JSON.stringify({ command: "true" }) }],
        usage: {
          inputTokens: { total: 50_000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: 50, reasoning: undefined },
        },
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        warnings: [],
      }),
    });
    stub.model = mock;
    const spendCap = new SpendCap({ ledger: calls, caps: { deploymentUsd: 1_000_000, perProjectUsd: 0.2 } });
    const gateway = gatewayOn(spendCap, calls);
    const dispatchService = new DispatchService({
      logger: recordingLogger(),
      config: { workdirBase },
      sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
      knowledgeSink: { storeFinding: notExercised("storeFinding") },
      intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting file", assumptions: [] }) },
      cells: {
        substrate: scriptedSubstrate(root),
        baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
        instance: testCellInstance(),
      },
      llm: gateway,
      staffing: { widerModel: () => null, staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
      attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
      environment: {
        images: { build: notExercised("build"), prune: notExercised("prune") },
        statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
      },
      checks: {
        foundationOf: notExercised("foundationOf"),
        checkFilesOf: notExercised("checkFilesOf"),
        completedOf: async () => ({ checked: [], unchecked: [] }),
        checkedTasksOf: notExercised("checkedTasksOf"),
        storedOfProject: notExercised("storedOfProject"),
        append: notExercised("append"),
        latest: async () => ({ checkTaskId: createWorkItemId(), revision: 1, environmentVersion: "e".repeat(64), baselineCommit, checks: [{ name: "noop", command: "true", decides: ["S1"] }], files: [] }),
      },
      suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
      shutdownSignal: new AbortController().signal,
      clock: systemClock,
    });

    const workItems = new WorkItemRowRepository(db);
    const deps = loopDeps({
      config: { ...DEFAULT_CONFIG, workdirBase },
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: new EventStoreRepository(db),
      failedApproachRepo: new FailedApproachRepository(db),
      // The gate sees this suite's project only, and only while the project is active.
      projectRepo: {
        get: (id) => projects.get(id),
        recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
        listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === projectId),
        listWithWorkspace: async () => (await projects.listWithWorkspace()).filter((p) => p.id === projectId),
        block: (id, cause) => projects.block(id, cause),
        listInfrastructureHalted: async () => [],
        resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
        blockAllActive: async () => [],
      },
      dispatchService,
      failureRouter: new FailureRouter(),
      spendCap,
    });
    const loop = new CoreLoop(deps);

    const cycle = await loop.runCycle();

    expect(cycle.stop).toBeNull();
    expect(cycle.results).toEqual([
      expect.objectContaining({ taskId: itemId, status: "refused", refusal: expect.objectContaining({ kind: "project", projectId }) }),
    ]);
    expect(mock.doGenerateCalls).toHaveLength(1);
    const item = await workItems.findById(itemId);
    expect(item).toMatchObject({ status: "Pending", dispatchCount: 0 });
    const lessons = await db.execute(sql`SELECT count(*)::int AS n FROM failed_approaches WHERE task_id = ${itemId}`);
    expect(lessons.rows).toEqual([{ n: 0 }]);
    const project = await db.execute(
      sql`SELECT ${projectState} AS status, blocked_error_class AS "errorClass", blocked_reason AS reason FROM projects WHERE id = ${projectId}`,
    );
    // The class the Liaison names the project's own cap by (SPEND_CAP_ERROR_CLASS), as finance records it.
    expect(project.rows).toEqual([{ status: "blocked", errorClass: SPEND_CAP_ERROR_CLASS.project, reason: expect.stringMatching(/^budget_cap: the spend cap of project/) }]);

    // The blocked project's item waits: the next cycle dispatches nothing.
    expect((await loop.runCycle()).tasksProcessed).toBe(0);
  });
});
