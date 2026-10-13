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
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { ContinuousRunner, CoreLoop, DEFAULT_CONFIG } from "@ashara/orchestrator";
import type { CoreLoopDeps } from "@ashara/orchestrator";
import { FailureRouter } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, createWorkItemId } from "@ashara/shared";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

// The spend caps end to end: Finance refuses an LLM call made inside the loop, and the loop
// routes the refusal. Against Postgres; no real LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME = `spend-cap-loop-test-${randomUUID().slice(0, 8)}`;

const MODEL: ModelConfig = {
  id: "spend-cap-loop-model",
  apiModelId: "spend-cap-loop-model",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [],
};

type Db = ReturnType<typeof createDb>;
let db: Db;
let root = "";

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

function gatewayOn(spendCap: SpendCap, calls: LlmCallRepository): LLMGateway {
  return buildGateway({
    config: {
      providers: [
        { name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true },
      ],
      defaultProvider: "deepseek",
    },
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(calls, spendCap) },
    clock: () => new Date(),
  });
}

/**
 * Every dep the loop takes, fully typed: a dep CoreLoopDeps gains and this omits is a compile
 * error here, never a TypeError the runner retries forever (a missing stackChoices did that).
 */
function loopDeps(parts: Partial<Omit<CoreLoopDeps, "eventLogger">> & Pick<CoreLoopDeps, "spendCap">): CoreLoopDeps {
  return {
    config: { ...DEFAULT_CONFIG, workdirBase: join(root, "unused") },
    workItemRepo: {
      create: notExercised("create"),
      findById: notExercised("findById"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      save: notExercised("save"),
      incrementDispatchCount: notExercised("incrementDispatchCount"),
      refundDispatchCount: notExercised("refundDispatchCount"),
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
    },
    developmentService: { execute: notExercised("execute") },
    failureRouter: { route: notExercised("route") },
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
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

describe("the deployment spend cap stops the loop", () => {
  test("a step's call refused at the deployment cap ends the run with the cap's reason, and the provider is never called", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectRepository(db);
    const client = await new ClientRepository(db).create(NAME);
    const projectId = (await projects.create(NAME, client.id)).id;
    const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("the provider must not be called"); } });
    stub.model = mock;

    // No call fits under this cap, whatever other suites add to or delete from llm_calls meanwhile.
    const capUsd = 1e-9;
    const spendCap = new SpendCap({ ledger: calls, projects, caps: { deploymentUsd: capUsd, perProjectUsd: capUsd } });
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

    const stop = await new ContinuousRunner(new CoreLoop(deps)).run(new AbortController().signal);

    expect(intake).toHaveBeenCalledTimes(1);
    expect(roster).not.toHaveBeenCalled();
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(stop?.reason).toMatch(/^budget_cap: the spend cap of the deployment/);
  });
});

const run = promisify(execFile);

/** A substrate whose podman answers from a script: every cell starts, every exec succeeds. */
function scriptedSubstrate(mountRoot: string): PodmanSubstrate {
  const ok = (stdout = "") => ({
    exitCode: 0, signal: null, stdout, stdoutTruncated: false, stderr: "", stderrTruncated: false, killedByHost: false, stdinError: null,
    statusReport: null,
  });
  return new PodmanSubstrate({
    podmanPath: "podman",
    mountRoot,
    runner: async ({ args }) => {
      switch (args[0]) {
        case "info":
          return ok(JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } }));
        case "run":
          return ok(`${"a".repeat(64)}\n`);
        // Every command exits 1: the stored check, red-run again on the BaseCell (its version differs
        // from the check's), still fails on main, so the dispatch reaches the model.
        case "exec":
          return { ...ok(), exitCode: 1, statusReport: "1\n" };
        case "rm":
          return ok();
        default:
          throw new Error(`unexpected podman ${args.join(" ")}`);
      }
    },
  });
}

describe("a turn refused at the project's spend cap", () => {
  // The 509bbbc5 review: the refusal ended the attempt as transport_exhausted, the item went to
  // Failed and through the FailureRouter, and a failed_approaches lesson was written.
  test("returns the item to Pending with its dispatch unconsumed and no lesson, and blocks the project budget_cap", async () => {
    const calls = new LlmCallRepository(db);
    const projects = new ProjectRepository(db);
    const client = await new ClientRepository(db).create(`${NAME}-refused-turn`);
    const projectId = (await projects.create(NAME, client.id)).id;
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", projectId);
    await mkdir(target, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: target });
    await writeFile(join(target, "README"), "a greeting project\n");
    await run("git", ["add", "README"], { cwd: target });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: target });

    const itemId = createWorkItemId();
    await new WorkItemRepository(db).create({
      id: itemId,
      level: "Task",
      status: "Pending",
      title: "Write greet.txt",
      // Sprint 0 runs on the BaseCell, so no environment has to be resolved for the task.
      taskSpec: { goal: "write greet.txt", origin: "sprint0" },
      runScope: RUN_SCOPE_AD_HOC,
      projectId,
    });

    // Turn 1 is admitted and records $10 of spend; turn 2 then cannot fit under the $5 project cap.
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName: "run_command", input: JSON.stringify({ command: "true" }) }],
        usage: {
          inputTokens: { total: 10_000_000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: 50, reasoning: undefined },
        },
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        warnings: [],
      }),
    });
    stub.model = mock;
    const spendCap = new SpendCap({ ledger: calls, projects, caps: { deploymentUsd: 1_000_000, perProjectUsd: 5 } });
    const gateway = gatewayOn(spendCap, calls);
    const developmentService = new DevelopmentService({
      config: { workdirBase },
      sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
      knowledgeSink: { storeFinding: notExercised("storeFinding"), storeInsight: notExercised("storeInsight") },
      intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting file", inferences: [] }) },
      cells: {
        substrate: scriptedSubstrate(root),
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
      checks: {
        checkFilesOf: notExercised("checkFilesOf"),
        completedOf: notExercised("completedOf"),
        checkedTasksOf: notExercised("checkedTasksOf"),
        append: notExercised("append"),
        latest: async () => ({ checkTaskId: createWorkItemId(), revision: 1, environmentVersion: "e".repeat(64), checks: [{ name: "noop", command: "true" }], files: [] }),
      },
      shutdownSignal: new AbortController().signal,
    });

    const workItems = new WorkItemRepository(db);
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
        block: (id, cause) => projects.block(id, cause),
      },
      developmentService,
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
      sql`SELECT status, blocked_error_class AS "errorClass", blocked_reason AS reason FROM projects WHERE id = ${projectId}`,
    );
    expect(project.rows).toEqual([{ status: "blocked", errorClass: "BudgetExceeded", reason: expect.stringMatching(/^budget_cap: the spend cap of project/) }]);

    // The blocked project's item waits: the next cycle dispatches nothing.
    expect((await loop.runCycle()).tasksProcessed).toBe(0);
  }, 60_000);
});
