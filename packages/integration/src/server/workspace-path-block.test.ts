import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { CoreLoop, DEFAULT_CONFIG, FailureRouter, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import { createWorkItemId, systemClock } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import { composeDispatchService } from "@ashara/server/compose-core-loop";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";
import { testCellInstance } from "../test-cells.js";

// A project whose recorded workspace path is refused blocks its
// item before the dispatch is counted, any model call or any cell; it is never run in some other
// directory. Against Postgres, with a real DispatchService on a recording substrate. A refused path
// is a configuration fault no retry clears: wherever main is read from it, the project halts at once
// and nothing is counted against the task's infrastructure fault budget.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `workspace-path-block-test-${randomUUID().slice(0, 8)}`;

let db: Database;
let root = "";

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-workspace-path-block-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name LIKE ${`${NAME}-%`})`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN ${projectIds}`);
  await db.execute(
    sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`,
  );
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${`${NAME}-%`}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}-%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A loop over the one project `projectId`, whose provider and podman record every call made to them. */
function loopOver(projectId: ProjectId): { loop: CoreLoop; mock: MockLanguageModelV4; podmanCalls: string[] } {
  const calls = new LlmCallRepository(db);
  const projects = new ProjectHaltRepository(db);
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
            capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Strong",
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
  const dispatchService = composeDispatchService({
    logger: recordingLogger(),
    config: { workdirBase },
    sessionStore: { insert: notExercised("insert"), complete: notExercised("complete"), fail: notExercised("fail") },
    knowledgeSink: { storeFinding: notExercised("storeFinding") },
    intentSource: { loadIntent: notExercised("loadIntent") },
    cells: {
      substrate,
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: testCellInstance(),
      shutdownSignal: new AbortController().signal,
    },
    llm: gateway,
    staffing: { widerModel: () => null, staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
    attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: notExercised("build"), prune: notExercised("prune") },
      statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
    },
    checks: { foundationOf: notExercised("foundationOf"), checkFilesOf: notExercised("checkFilesOf"), completedOf: notExercised("completedOf"), checkedTasksOf: notExercised("checkedTasksOf"), storedOfProject: notExercised("storedOfProject"), append: notExercised("append"), latest: notExercised("latest"), holdEvidenceOf: notExercised("holdEvidenceOf"), recordSetRejection: notExercised("recordSetRejection") },
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
  });

  const loop = new CoreLoop(
    composedLoopOverTestDb(
      {
        db,
        config: { ...DEFAULT_CONFIG, workdirBase },
        logger: recordingLogger(),
        llm: gateway,
        spendCap,
        containment: memoryStepContainment(() => true),
        failureRouter: new FailureRouter(),
        dispatchService,
      },
      {
        loop: {
          projectRepo: {
            get: (id) => projects.get(id),
            recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
            listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === projectId),
            listWithWorkspace: async () => (await projects.listWithWorkspace()).filter((p) => p.id === projectId),
            block: (id, cause) => projects.block(id, cause),
            listInfrastructureHalted: async () => [],
            listClientWaitHalted: async () => [],
            resumeFromClientWait: notExercised("resumeFromClientWait"),
            resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
            blockAllActive: async () => [],
          },
        },
      },
    ),
  );
  return { loop, mock, podmanCalls };
}

/** A project of this suite, with its own client, whose recorded workspace path the validation refuses. */
async function refusedProject(label: string): Promise<ProjectId> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(`${NAME}-${label}`, client.id)).id;
  // A path inside the Ashara repository, outside the workdir base: the validation refuses it.
  await projects.recordWorkspacePath(projectId, join(process.cwd(), "poisoned-target"));
  return projectId;
}

describe("a project whose workspace path is refused", () => {
  test("parks the item with no dispatch counted, no llm_calls row and no cell, never requeued on an unread main", async () => {
    const projects = new ProjectHaltRepository(db);
    const workItems = new WorkItemRowRepository(db);
    const projectId = await refusedProject("dispatch");
    const itemId = createWorkItemId();
    await workItems.create({
      id: itemId,
      level: "Task",
      status: "Pending",
      title: "Write greet.txt",
      taskSpec: { goal: "write greet.txt", origin: "sprint0" },
      projectId,
    });
    const { loop, mock, podmanCalls } = loopOver(projectId);

    const cycle = await loop.runCycle();

    // An uncharged fault, no dispatch counted. Main cannot be read for the task's merge from the
    // refused path either, so the task is never requeued blind: Blocked orphan_unreconciled, whose
    // exit reads main again each cycle. A refused path is a configuration fault no retry clears, so
    // the project halts at once, on the first read, never counted against the task's infrastructure
    // fault budget.
    expect(cycle.results).toEqual([
      expect.objectContaining({ taskId: itemId, status: "interrupted", detail: expect.stringContaining("not inside the workdir base") }),
    ]);
    const item = await workItems.findById(itemId);
    expect(item).toMatchObject({ status: "Blocked", dispatchCount: 0, infrastructureFaults: 0, blockedReason: { source: "orphan_unreconciled", faultClass: "ashara" } });
    expect(await projects.get(projectId)).toMatchObject({ status: "blocked" });
    const halts = await db.execute(sql`SELECT kind, error_class AS "errorClass", reason FROM project_blocks WHERE project_id = ${projectId}`);
    expect(halts.rows).toEqual([{ kind: "fault", errorClass: "OrphanUnreconciled", reason: expect.stringMatching(/settled in 1 attempt\(s\).*InvalidTargetProjectPath/s) }]);
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
    expect(rows.rows).toEqual([{ n: 0 }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(podmanCalls).toEqual([]);
  });

  // The parked exit of a task whose main went unread reads main again each cycle; from a refused
  // path that read is refused again, so the project halts on the first one, nothing counted.
  test("the parked exit of an orphan_unreconciled task halts the project at once, nothing counted, the task kept Blocked", async () => {
    const projects = new ProjectHaltRepository(db);
    const workItems = new WorkItemRowRepository(db);
    const projectId = await refusedProject("parked");
    const itemId = createWorkItemId();
    await workItems.create({
      id: itemId,
      level: "Task",
      status: "Blocked",
      title: "Write farewell.txt",
      taskSpec: { goal: "write farewell.txt", origin: "sprint0" },
      blockedReason: { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge", reason: "main unread" },
      projectId,
    });
    const { loop, mock, podmanCalls } = loopOver(projectId);

    await loop.runCycle();

    const item = await workItems.findById(itemId);
    expect(item).toMatchObject({ status: "Blocked", dispatchCount: 0, infrastructureFaults: 0, blockedReason: { source: "orphan_unreconciled" } });
    expect(await projects.get(projectId)).toMatchObject({ status: "blocked" });
    const halts = await db.execute(sql`SELECT kind, error_class AS "errorClass", reason FROM project_blocks WHERE project_id = ${projectId}`);
    expect(halts.rows).toEqual([{ kind: "fault", errorClass: "OrphanUnreconciled", reason: expect.stringContaining("InvalidTargetProjectPath") }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(podmanCalls).toEqual([]);
  });
});
