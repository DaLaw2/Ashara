import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  ClientRepository,
  createDb,
  DEFAULT_DATABASE_URL,
  EventStoreRepository,
  FailedApproachRepository,
  LlmCallRepository,
  ProjectRepository,
  WorkItemRepository,
} from "@ashara/db";
import { DevelopmentService } from "@ashara/development";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import { CoreLoop, DEFAULT_CONFIG } from "@ashara/orchestrator";
import { FailureRouter } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, createWorkItemId } from "@ashara/shared";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

// t-workspace-path-fail-closed: a project whose recorded workspace path is refused blocks its
// item before the dispatch is counted, any model call or any cell; it is never run in some other
// directory. Against Postgres, with a real DevelopmentService on a recording substrate.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
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
    const projects = new ProjectRepository(db);
    const client = await new ClientRepository(db).create(NAME);
    const projectId = (await projects.create(NAME, client.id)).id;
    // A path inside the Ashara repository: the validation refuses it.
    await projects.recordWorkspacePath(projectId, join(process.cwd(), "poisoned-target"));
    const itemId = createWorkItemId();
    await new WorkItemRepository(db).create({
      id: itemId,
      level: "Task",
      status: "Pending",
      title: "Write greet.txt",
      taskSpec: { goal: "write greet.txt", origin: "sprint0" },
      runScope: RUN_SCOPE_AD_HOC,
      projectId,
    });

    const podmanCalls: string[] = [];
    const substrate = new PodmanSubstrate({
      podmanPath: "podman",
      mountRoot: root,
      runner: async ({ args }) => {
        podmanCalls.push(args.join(" "));
        throw new Error(`no podman call may be made: podman ${args.join(" ")}`);
      },
    });
    const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("the provider must not be called"); } });
    stub.model = mock;
    const spendCap = new SpendCap({ ledger: calls, projects, caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } });
    const gateway = buildGateway({
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
              priceWindows: [],
            }],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
      },
      checkedSources: ["test"],
      recording: { kind: "recorded", recorder: new LlmCallLedger(calls, spendCap) },
      clock: () => new Date(),
    });
    const workdirBase = join(root, "work");
    const developmentService = new DevelopmentService({
      config: { workdirBase },
      sessionStore: { insert: notExercised("insert"), complete: notExercised("complete"), fail: notExercised("fail") },
      knowledgeSink: { storeFinding: notExercised("storeFinding"), storeInsight: notExercised("storeInsight") },
      intentSource: { loadIntent: notExercised("loadIntent") },
      cells: {
        substrate,
        baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
        instance: `test-${randomUUID()}`,
      },
      llm: gateway,
      staffing: { staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
      attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
      environment: {
        images: { build: notExercised("build") },
        statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
      },
      checks: { checkFilesOf: notExercised("checkFilesOf"), completedOf: notExercised("completedOf"), checkedTasksOf: notExercised("checkedTasksOf"), append: notExercised("append"), latest: notExercised("latest") },
      shutdownSignal: new AbortController().signal,
    });

    const workItems = new WorkItemRepository(db);
    const loop = new CoreLoop({
      config: { ...DEFAULT_CONFIG, workdirBase },
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: new EventStoreRepository(db),
      failedApproachRepo: new FailedApproachRepository(db),
      projectRepo: {
        get: (id) => projects.get(id),
        recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
        listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === projectId),
        block: (id, cause) => projects.block(id, cause),
      },
      developmentService,
      failureRouter: new FailureRouter(),
      spendCap,
      clientStops: { runPending: async () => [] },
      stackChoices: { runPending: async () => [] },
      liaisonIntake: { runPending: async () => [] },
      liaisonAnswers: { runPending: async () => [] },
      rosterDerivation: { runPending: async () => [] },
      firstPlanning: { runPending: async () => [] },
      replanning: { runPending: async () => [] },
      planReports: { runPending: async () => [] },
      checkDisputes: { record: notExercised("checkDisputes") },
      disputeReports: { blockOnDisputes: notExercised("disputeReports") },
      blockReports: { runPending: async () => [] },
      parkedExits: { latestRosterRevision: notExercised("latestRosterRevision"), environmentBuilt: notExercised("environmentBuilt") },
    });

    const cycle = await loop.runCycle();

    expect(cycle.results).toEqual([expect.objectContaining({ taskId: itemId, status: "blocked" })]);
    const item = await workItems.findById(itemId);
    expect(item).toMatchObject({ status: "Blocked", dispatchCount: 0 });
    expect(item?.blockedReason).toMatchObject({
      source: "environment_unavailable",
      unavailable: "target workspace",
      reason: expect.stringContaining("Ashara repository root"),
    });
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
    expect(rows.rows).toEqual([{ n: 0 }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(podmanCalls).toEqual([]);
  }, 60_000);
});
