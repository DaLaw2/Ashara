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
import { ClientRepository, createDb, EventStoreRepository, LlmCallRepository, WorkGrantRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { FailedApproachRepository } from "@ashara/knowledge";
import { DispatchService, CoreLoop, DEFAULT_CONFIG, concurrentTaskLanes, FailureRouter, adaptWorkItemRepo, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import type { CoreLoopDeps } from "@ashara/delivery";
import { BlockReports } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap, WORK_BUDGET_ERROR_CLASS } from "@ashara/finance";
import type { WorkBudgets } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, memoryStepContainment, recordingLogger, systemClock } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { CHECK_MISSING_EXIT } from "@ashara/workplace";
import { testCellInstance } from "../test-cells.js";
import { projectState } from "../simulator/project-state.js";

// The work ledger end to end: Finance draws one model request from the
// project's and the task's budgets before every gateway request, counted from llm_calls rows, and
// the loop routes its refusal: a task's spent budget gives the task up, a project's halts the
// project with a report naming what was drawn and by which call site. Against Postgres; no real
// LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `work-budget-loop-test-${randomUUID().slice(0, 8)}`;
const AMPLE_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };

const MODEL: ModelConfig = {
  id: "work-budget-loop-model",
  apiModelId: "work-budget-loop-model",
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
const run = promisify(execFile);

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/** A model that asks for another command on every turn: only a bound ends its attempt. */
function endlessAgent(): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName: "run_command", input: JSON.stringify({ command: "true" }) }],
      usage: {
        inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      warnings: [],
    }),
  });
  stub.model = mock;
  return mock;
}

/** A substrate whose podman answers from a script: every cell starts, every exec reports the work missing. */
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

interface Fixture {
  readonly projectId: ProjectId;
  readonly itemId: WorkItemId;
  readonly workdirBase: string;
  readonly baselineCommit: string;
}

/** A project with a git target and one Sprint 0 task, which runs on the BaseCell. */
async function fixture(label: string): Promise<Fixture> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(NAME, client.id)).id;
  const workdirBase = join(root, label);
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
    taskSpec: { goal: "write greet.txt", endState: "greet.txt exists", scope: "greet.txt", deliverables: ["greet.txt"], origin: "sprint0" },
    projectId,
  });
  return { projectId, itemId, workdirBase, baselineCommit };
}

/**
 * One server process over the fixture: its own SpendCap with `budgets`, so nothing in memory
 * carries over from another, and the loop with its real dispatch, attempt and routing.
 */
function serverProcess(at: Fixture, budgets: WorkBudgets): CoreLoop {
  const calls = new LlmCallRepository(db);
  const projects = new ProjectHaltRepository(db);
  const spendCap = new SpendCap({ ledger: calls, caps: AMPLE_CAPS, workBudgets: budgets });
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [{ name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true }],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(calls, spendCap), recordingLogger());
  const dispatchService = new DispatchService({
    logger: recordingLogger(),
    config: { workdirBase: at.workdirBase },
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
      latest: async () => ({ checkTaskId: createWorkItemId(), revision: 1, environmentVersion: "e".repeat(64), baselineCommit: at.baselineCommit, checks: [{ name: "noop", command: "true", decides: ["S1"] }], files: [] }),
    },
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
  });
  const deps: CoreLoopDeps = {
    config: { ...DEFAULT_CONFIG, workdirBase: at.workdirBase },
    cycleLog: { emit: () => {} },
    logger: recordingLogger(),
    containment: memoryStepContainment((error) => spendCap.refusalOf(error) !== null),
    workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(db)),
    eventStore: new EventStoreRepository(db),
    failedApproachRepo: new FailedApproachRepository(db),
    // The gate sees this fixture's project only, and only while the project is at work.
    projectRepo: {
      get: (id) => projects.get(id),
      recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
      listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === at.projectId),
      listWithWorkspace: async () => (await projects.listWithWorkspace()).filter((p) => p.id === at.projectId),
      block: (id, cause) => projects.block(id, cause),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
    },
    dispatchService,
    failureRouter: new FailureRouter(),
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
    spendCap,
  };
  return new CoreLoop(deps);
}

async function requestsOf(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
  return z.object({ n: z.number() }).parse(result.rows[0]).n;
}

const ItemRow = z.object({ status: z.string(), dispatchCount: z.number(), source: z.string().nullable(), repairs: z.number() });

async function itemOf(itemId: WorkItemId): Promise<z.infer<typeof ItemRow>> {
  const result = await db.execute(sql`
    SELECT status, dispatch_count AS "dispatchCount", blocked_reason->>'source' AS source,
           (SELECT count(*)::int FROM plan_repairs r WHERE r.work_item_id = w.id) AS repairs
    FROM work_items w WHERE id = ${itemId}`);
  return ItemRow.parse(result.rows[0]);
}

const ProjectRow = z.object({ status: z.string(), category: z.string().nullable(), errorClass: z.string().nullable() });

async function projectOf(projectId: ProjectId): Promise<z.infer<typeof ProjectRow>> {
  const result = await db.execute(sql`
    SELECT ${projectState} AS status, blocked_category AS category, blocked_error_class AS "errorClass" FROM projects WHERE id = ${projectId}`);
  return ProjectRow.parse(result.rows[0]);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-work-budget-loop-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM failed_approaches WHERE task_id IN (SELECT id FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

describe("a task that draws its whole work budget", () => {
  test("is given up with source work_budget_spent and its plan repaired, never requeued, and its project stays at work", async () => {
    const at = await fixture("task-budget");
    const mock = endlessAgent();
    const loop = serverProcess(at, { perTaskRequests: 2, perProjectRequests: 100, verificationReservePercent: 0 });

    const cycle = await loop.runCycle();

    // Turns 1 and 2 drew the task's two requests; turn 3 was refused before it was sent.
    expect(mock.doGenerateCalls).toHaveLength(2);
    expect(await requestsOf(at.projectId)).toBe(2);
    expect(cycle.results).toEqual([expect.objectContaining({ taskId: at.itemId, status: "blocked" })]);
    expect(await itemOf(at.itemId)).toEqual({ status: "Abandoned", dispatchCount: 0, source: "work_budget_spent", repairs: 1 });
    expect(await projectOf(at.projectId)).toEqual({ status: "active", category: null, errorClass: null });
    const lessons = await db.execute(sql`SELECT count(*)::int AS n FROM failed_approaches WHERE task_id = ${at.itemId}`);
    expect(lessons.rows).toEqual([{ n: 0 }]);

    // Nothing dispatches it again.
    expect((await loop.runCycle()).tasksProcessed).toBe(0);
    expect(mock.doGenerateCalls).toHaveLength(2);
  });
});

describe("a project that draws its whole work budget", () => {
  test(
    "halts as work_budget with a report naming the budget, the requests drawn and their call site; a refund, a restart and an " +
      "unblock return none, and a grant returns exactly the requests granted",
    async () => {
      const at = await fixture("project-budget");
      const mock = endlessAgent();
      // The task's own budget is ample: only the project's binds.
      const budgets = { perTaskRequests: 50, perProjectRequests: 2, verificationReservePercent: 0 };
      const loop = serverProcess(at, budgets);
      const projects = new ProjectHaltRepository(db);

      const cycle = await loop.runCycle();

      expect(mock.doGenerateCalls).toHaveLength(2);
      expect(cycle.results).toEqual([
        expect.objectContaining({ taskId: at.itemId, status: "refused", refusal: expect.objectContaining({ kind: "project_work", projectId: at.projectId }) }),
      ]);
      expect(await projectOf(at.projectId)).toEqual({ status: "blocked", category: "work_budget", errorClass: WORK_BUDGET_ERROR_CLASS });
      // The dispatch is refunded: a refund gives back the attempt, never a request.
      expect(await itemOf(at.itemId)).toMatchObject({ status: "Pending", dispatchCount: 0 });
      const episode = await db.execute(sql`SELECT work FROM project_blocks WHERE project_id = ${at.projectId} AND ended_at IS NULL`);
      expect(episode.rows).toEqual([
        { work: { scope: "project", budgetRequests: 2, grantedRequests: 0, reserveRequests: 0, reserveProtected: false, spentRequests: 2, inFlightRequests: 0, bySite: [{ callSite: "agent-runner", requests: 2 }] } },
      ]);

      // The client and the operator are told the budget, what was drawn and by which call site.
      const store = createBlockReportStore(db);
      const ours: BlockReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((due) => due.projectId === at.projectId) };
      await new BlockReports(ours, memoryStepContainment(() => false)).runPending();
      const reports = await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${at.projectId} AND direction = 'outbound'`);
      const [report] = z.array(z.object({ body: z.string() })).parse(reports.rows);
      expect(report?.body).toContain("the budget of model requests set for this project was used up");
      expect(report?.body).toContain(
        'When it stopped the work, 2 model requests had been sent and 0 more were under way, against a budget of 2 model requests. ' +
          'The requests drawn, by the step of the work that drew them: "agent-runner" 2.',
      );
      const reason = await db.execute(sql`SELECT reason FROM project_blocks WHERE project_id = ${at.projectId} AND ended_at IS NULL`);
      expect(z.array(z.object({ reason: z.string() })).parse(reason.rows)[0]?.reason).toMatch(
        /^work_budget: the work budget of project .* is 2 model requests, and none is left: 2 sent \(llm_calls\) \+ 0 in flight\. Requests drawn by call site: agent-runner 2\./,
      );

      // A restart (a new process, nothing in memory carried over) and an unblock with no grant: the
      // first request of the next dispatch is refused and the project halts again.
      const restarted = serverProcess(at, budgets);
      await projects.unblock(at.projectId, "operator-a", "trying again without a grant");
      await restarted.runCycle();
      expect(mock.doGenerateCalls).toHaveLength(2);
      expect(await requestsOf(at.projectId)).toBe(2);
      expect(await projectOf(at.projectId)).toMatchObject({ status: "blocked", category: "work_budget" });

      // A grant of one request, then the unblock: exactly one more request is sent before the next halt.
      await new WorkGrantRepository(db).grant({ projectId: at.projectId, requests: 1, grantedBy: "owner-a", reason: "one more step" });
      await projects.unblock(at.projectId, "operator-a", "one request granted");
      await restarted.runCycle();
      expect(mock.doGenerateCalls).toHaveLength(3);
      expect(await requestsOf(at.projectId)).toBe(3);
      expect(await projectOf(at.projectId)).toMatchObject({ status: "blocked", category: "work_budget" });
      const last = await db.execute(sql`SELECT work FROM project_blocks WHERE project_id = ${at.projectId} AND ended_at IS NULL`);
      expect(last.rows).toEqual([{ work: expect.objectContaining({ budgetRequests: 3, grantedRequests: 1, spentRequests: 3 }) }]);
    },
  );
});
