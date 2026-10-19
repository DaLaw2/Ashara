import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, EventStoreRepository, LlmCallRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { FailedApproachRepository } from "@ashara/knowledge";
import { DispatchService, CoreLoop, DEFAULT_CONFIG, concurrentTaskLanes, FailureRouter, adaptWorkItemRepo, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import { createWorkItemId, memoryStepContainment, recordingLogger, systemClock } from "@ashara/shared";
import { testCellInstance } from "../test-cells.js";

// A project whose recorded workspace path is refused blocks its
// item before the dispatch is counted, any model call or any cell; it is never run in some other
// directory. Against Postgres, with a real DispatchService on a recording substrate.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `workspace-path-block-test-${randomUUID().slice(0, 8)}`;

type Db = ReturnType<typeof createDb>;
let db: Db;
let root = "";

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-workspace-path-block-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN ${projectIds}`);
  await db.execute(
    sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`,
  );
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${NAME}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a project whose workspace path is refused", () => {
  test("blocks the item environment_unavailable with no dispatch counted, no llm_calls row and no cell", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectHaltRepository(db);
    const client = await new ClientRepository(db).create(NAME);
    const projectId = (await projects.create(NAME, client.id)).id;
    // A path inside the Ashara repository, outside the workdir base: the validation refuses it.
    await projects.recordWorkspacePath(projectId, join(process.cwd(), "poisoned-target"));
    const itemId = createWorkItemId();
    await new WorkItemRowRepository(db).create({
      id: itemId,
      level: "Task",
      status: "Pending",
      title: "Write greet.txt",
      taskSpec: { goal: "write greet.txt", origin: "sprint0" },
      projectId,
    });

    const podmanCalls: string[] = [];
    const substrate = new PodmanSubstrate({ logger: recordingLogger(), 
      podmanPath: "podman",
      mountRoot: root,
      runner: async ({ args }) => {
        podmanCalls.push(args.join(" "));
        throw new Error(`no podman call may be made: podman ${args.join(" ")}`);
      },
    });
    const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("the provider must not be called"); } });
    stub.model = mock;
    const spendCap = new SpendCap({ ledger: calls, caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } });
    const gateway = new GuardedModelAccess(buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          {
            name: "deepseek",
            providerType: "deepseek",
            apiKey: "k",
            baseUrl: "https://stub.invalid/v1",
            models: [{
              id: "workspace-block-model",
              apiModelId: "workspace-block-model",
              provider: "deepseek",
              capabilityLevel: "Strong",
              inputCostPer1M: 1,
              outputCostPer1M: 10,
              maxContextTokens: 100_000,
              cacheReadCostPer1M: null,
              cacheWriteCostPer1M: null,
              priceWindows: [], priceTiers: [], datedPrices: [],
            }],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }), new LlmCallLedger(calls, spendCap), recordingLogger());
    const workdirBase = join(root, "work");
    const dispatchService = new DispatchService({
      logger: recordingLogger(),
      config: { workdirBase },
      sessionStore: { insert: notExercised("insert"), complete: notExercised("complete"), fail: notExercised("fail") },
      knowledgeSink: { storeFinding: notExercised("storeFinding") },
      intentSource: { loadIntent: notExercised("loadIntent") },
      cells: {
        substrate,
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
      checks: { foundationOf: notExercised("foundationOf"), checkFilesOf: notExercised("checkFilesOf"), completedOf: notExercised("completedOf"), checkedTasksOf: notExercised("checkedTasksOf"), storedOfProject: notExercised("storedOfProject"), append: notExercised("append"), latest: notExercised("latest") },
      suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
      shutdownSignal: new AbortController().signal,
      clock: systemClock,
    });

    const workItems = new WorkItemRowRepository(db);
    const loop = new CoreLoop({
      config: { ...DEFAULT_CONFIG, workdirBase },
      cycleLog: { emit: () => {} },
      logger: recordingLogger(),
      containment: memoryStepContainment(() => true),
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: new EventStoreRepository(db),
      failedApproachRepo: new FailedApproachRepository(db),
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
      acceptance: { readyForAcceptance: async () => [], recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
      deliveredReports: { runPending: async () => [] },
    });

    const cycle = await loop.runCycle();

    // An uncharged infrastructure fault: back to Pending, no dispatch counted.
    expect(cycle.results).toEqual([
      expect.objectContaining({ taskId: itemId, status: "interrupted", detail: expect.stringContaining("not inside the workdir base") }),
    ]);
    const item = await workItems.findById(itemId);
    expect(item).toMatchObject({ status: "Pending", dispatchCount: 0, infrastructureFaults: 1 });
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
    expect(rows.rows).toEqual([{ n: 0 }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(podmanCalls).toEqual([]);
  });
});
