import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, EnvironmentBuildRepository, EventStoreRepository, LlmCallRepository } from "@ashara/db";
import { DevSessionRepository } from "@ashara/workplace";
import { TaskCheckRepository } from "@ashara/quality";
import { FailedApproachRepository } from "@ashara/knowledge";
import { DispatchService, CoreLoop, DEFAULT_CONFIG, FailureRouter, adaptWorkItemRepo, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell, pruneEnvironmentImages } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, systemClock } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { createTaskCheckStore } from "@ashara/server/task-check-store";
import { testCellInstance } from "../test-cells.js";

// c-platform-role C2 (ADR-074 d96 c), end to end through the real contractor loop, the real
// DispatchService, real podman and git, and the recorded gateway with scripted models: an
// implementer's change to the environment recipe becomes a platform task whose new version the
// implementation's next dispatch runs on; a platform task whose definition does not build merges
// nothing, so the prior version stays current, and its implementation never runs on a broken one.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME = `env-change-loop-${randomUUID().slice(0, 8)}`;

const modelConfig: ModelConfig = {
  id: "mock-model",
  apiModelId: "mock-model-api",
  provider: "anthropic",
  capabilityLevel: "Strong",
  inputCostPer1M: 3,
  outputCostPer1M: 15,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: 0.3,
  cacheWriteCostPer1M: 3.75,
  priceWindows: [], priceTiers: [],
};

function toolCallTurn(toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName, input: JSON.stringify(input) }],
    usage: {
      inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: 50, reasoning: undefined },
      raw: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    warnings: [],
  };
}

type Turn = ReturnType<typeof toolCallTurn>;

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

const STATEMENT = "A shell-only environment on the pinned Debian base.";
const SPRINT0_GOAL = "Define and commit the project environment";
/** The goal requestEnvironmentChange writes on every environment task it opens. */
const ENVIRONMENT_CHANGE_GOAL = "Change the project environment as the implementation task";

const DEFINITION = [
  'containerfile = "environment/Containerfile"',
  "recipe = []",
  "inputs = []",
  'probe = "echo toolchain ok"',
  'build = "true"',
  'test = "echo product tests ok"',
  "",
].join("\n");

type Db = ReturnType<typeof createDb>;
let db: Db;
let root = "";
let base: BaseCellReference;
const clientIds: string[] = [];
const projectIds: ProjectId[] = [];

interface Harness {
  readonly projectId: ProjectId;
  readonly target: string;
  readonly platformRoleId: string;
  readonly events: ReadonlyArray<Record<string, unknown> & { readonly event: string }>;
  /** Each task's scripted turns, chosen by a marker its brief carries; markers are tried in insertion order. */
  readonly scripts: Map<string, Turn[]>;
  readonly loop: CoreLoop;
}

/**
 * One project, its loop and its scripted models. The model answering a call is the one whose
 * marker the prompt holds first, so concurrent or reordered dispatches never take another task's turns.
 */
async function harness(name: string): Promise<Harness> {
  const projects = new ProjectHaltRepository(db);
  const clientId = (await new ClientRepository(db).create(`${NAME}-${name}`)).id;
  clientIds.push(clientId);
  const projectId = (await projects.create(`${NAME}-${name}`, clientId)).id;
  projectIds.push(projectId);
  const workdirBase = join(root, name);
  const target = join(workdirBase, "projects", projectId);
  const platformRoleId = randomUUID();

  const scripts = new Map<string, Turn[]>();
  stub.model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      for (const [marker, turns] of scripts) {
        if (!prompt.includes(marker)) continue;
        const next = turns.shift();
        if (next === undefined) throw new Error(`the script of "${marker}" is exhausted`);
        return next;
      }
      throw new Error("no script's marker is in the prompt");
    },
  });

  const calls = new LlmCallRepository(db);
  const spendCap = new SpendCap({ ledger: calls, caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } });
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [{ name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true }],
      defaultProvider: "anthropic",
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(calls, spendCap));
  const substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
  const builds = new EnvironmentBuildRepository(db);
  const workItems = new WorkItemRowRepository(db);
  const sessions = new DevSessionRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const dispatchService = new DispatchService({
    config: { workdirBase },
    sessionStore: {
      insert: (sid, tid, brief, version) => sessions.insert(sid, tid, brief, version),
      complete: (sid, attempt, end) => sessions.complete(sid, attempt, end),
      fail: (sid, verification, attempt) => sessions.fail(sid, verification, attempt),
    },
    knowledgeSink: { storeFinding: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A studio booking site", assumptions: [] }) },
    cells: { substrate, baseCell: base, instance: testCellInstance() },
    llm: gateway,
    staffing: {
      staff: async (staffed) => ({
        kind: "staffed",
        staff: {
          role: staffed.workKind === "environment" ? { id: "platform", name: "Platform" } : { id: "developer", name: "Developer" },
          model: gateway.resolveModel("Strong", "agent-runner"),
        },
      }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: {
        build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }),
        prune: (id, keepVersion) => pruneEnvironmentImages(substrate, id, keepVersion),
      },
      statements: {
        record: (taskId, statement, version) => workItems.recordEnvironmentStatement(taskId, statement, version),
        forVersion: (id, version) => workItems.environmentStatementFor(id, version),
      },
    },
    checks: createTaskCheckStore(db),
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
  });

  const loop = new CoreLoop({
    config: { ...DEFAULT_CONFIG, workdirBase },
    cycleLog: { emit: () => {} },
    workItemRepo: adaptWorkItemRepo(workItems),
    eventStore: new EventStoreRepository(db),
    failedApproachRepo: new FailedApproachRepository(db),
    projectRepo: {
      get: (id) => projects.get(id),
      recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
      listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === projectId),
      block: (id, cause) => projects.block(id, cause),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
    },
    dispatchService,
    // The production bound (packages/server/src/compose.ts).
    failureRouter: new FailureRouter(3),
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
    blockReports: { runPending: async () => [] },
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    environmentOwner: async () => ({ kind: "role", roleId: platformRoleId }),
    // One task after another, in the batch's order: the cells and merges of a cycle never interleave.
    taskLanes: async (items, runOne) => {
      const settled: Array<PromiseSettledResult<Awaited<ReturnType<typeof runOne>>>> = [];
      for (const item of items) {
        try {
          settled.push({ status: "fulfilled", value: await runOne(item) });
        } catch (reason) {
          settled.push({ status: "rejected", reason });
        }
      }
      return settled;
    },
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    acceptance: { readyForAcceptance: async () => [], recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
    deliveredReports: { runPending: async () => [] },
  });
  return { projectId, target, platformRoleId, events, scripts, loop };
}

/** Sprint 0 as a first plan writes it: Pending environment work. */
async function sprint0(h: Harness): Promise<void> {
  const taskSpec = {
    goal: SPRINT0_GOAL,
    endState: "environment/environment.toml parses",
    scope: "environment/environment.toml and the recipe files it names",
    deliverables: ["environment/environment.toml"],
    origin: "sprint0",
    checkedBy: "substrate",
  } as const;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, project_id, work_kind, owner_role_id)
    VALUES (${createWorkItemId()}, 'Task', 'Pending', ${SPRINT0_GOAL}, ${JSON.stringify(taskSpec)}::jsonb,
            ${h.projectId}, 'environment', ${h.platformRoleId})`);
  h.scripts.set(SPRINT0_GOAL, [
    toolCallTurn("write_file", { path: "environment/environment.toml", content: DEFINITION }),
    toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
    toolCallTurn("finish", { status: "done", summary: "Wrote the environment.", statement: STATEMENT }),
  ]);
}

/**
 * A Pending implementation task with the checks its completed check task stored on `version`, red-run
 * on `baseline` (s-independent-verify-m1).
 */
async function implementationTask(h: Harness, title: string, check: string, version: string, baseline: string): Promise<WorkItemId> {
  const id = createWorkItemId();
  const checkTaskId = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'Pending', ${title}, ${JSON.stringify({ goal: title, endState: `${title} is done`, scope: title, deliverables: [] })}::jsonb,
            ${h.projectId}, 'implementation', ${randomUUID()}),
           (${checkTaskId}, 'Task', 'Completed', ${`Write the checks for "${title}"`}, NULL, ${h.projectId}, 'check', ${randomUUID()})`);
  await new TaskCheckRepository(db).append({
    projectId: h.projectId,
    taskId: id,
    checkTaskId,
    environmentVersion: version,
    baselineCommit: baseline,
    checks: [{ name: "file", command: check }],
    files: [],
  });
  return id;
}

const itemRow = z.object({
  id: z.string(),
  status: z.string(),
  workKind: z.string().nullable(),
  ownerRoleId: z.string().nullable(),
  origin: z.string().nullable(),
  source: z.string().nullable(),
});

async function itemsOf(projectId: ProjectId): Promise<Array<z.infer<typeof itemRow>>> {
  const result = await db.execute(sql`
    SELECT id, status, work_kind AS "workKind", owner_role_id AS "ownerRoleId", task_spec->>'origin' AS origin,
           blocked_reason->>'source' AS source
    FROM work_items WHERE project_id = ${projectId} ORDER BY created_at`);
  return z.array(itemRow).parse(result.rows);
}

async function sessionVersions(taskId: string): Promise<Array<string | null>> {
  const result = await db.execute(sql`SELECT environment_version AS "version" FROM dev_sessions WHERE task_id = ${taskId} ORDER BY created_at`);
  return z.array(z.object({ version: z.string().nullable() })).parse(result.rows).map((row) => row.version);
}

async function succeededVersions(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT version FROM environment_builds WHERE project_id = ${projectId} AND status = 'succeeded' ORDER BY created_at`);
  return z.array(z.object({ version: z.string() })).parse(result.rows).map((row) => row.version);
}

async function mainHead(target: string): Promise<string> {
  return (await run("git", ["-C", target, "rev-parse", "main"])).stdout.trim();
}

/** The environment version Sprint 0's merge made current, and main's commit after it. */
async function runSprint0(h: Harness): Promise<{ readonly version: string; readonly commit: string }> {
  await sprint0(h);
  const cycle = await h.loop.runCycle();
  expect(cycle.results.map((r) => r.status), JSON.stringify(cycle.results)).toEqual(["completed"]);
  const [version] = await succeededVersions(h.projectId);
  if (version === undefined) throw new Error("Sprint 0 built no environment");
  return { version, commit: await mainHead(h.target) };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-env-change-loop-")));
  base = await loadBaseCell();
}, 60_000);

afterAll(async () => {
  for (const projectId of projectIds) {
    const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
    const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
    if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
    const items = sql`(SELECT id FROM work_items WHERE project_id = ${projectId})`;
    await db.execute(sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id = ${projectId})`);
    await db.execute(sql`DELETE FROM failed_approaches WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN ${items}`);
    await db.execute(sql`DELETE FROM plan_repairs WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM dependencies WHERE from_id IN ${items}`);
    await db.execute(sql`UPDATE work_items SET parent_id = NULL WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  }
  for (const clientId of clientIds) await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
}, 120_000);

describe("an implementer's environment change, through the contractor loop", () => {
  it("becomes a platform task whose new version the implementation's next dispatch runs on", async () => {
    const h = await harness("granted");
    const v1 = await runSprint0(h);

    const impl = await implementationTask(h, "Write hello.txt", "cat /workspace/hello.txt || exit 99", v1.version, v1.commit);
    h.scripts.set(ENVIRONMENT_CHANGE_GOAL, [
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN true\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: "Added the RUN step the implementer needs.", statement: STATEMENT }),
    ]);
    h.scripts.set("Write hello.txt", [
      // The first dispatch: the product file and a change to the recipe, which only environment work may make.
      toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN true\n` }),
      toolCallTurn("finish", { status: "done", summary: "The greeter needs a RUN step in the image." }),
      // The dispatch after the environment changed: the product file alone.
      toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt." }),
    ]);

    // The request: nothing merged, a Pending environment task owned by the platform role, the implementation waiting on it.
    const requested = await h.loop.runCycle();
    expect(requested.results).toEqual([expect.objectContaining({ taskId: impl, status: "blocked" })]);
    expect(await mainHead(h.target)).toBe(v1.commit);
    const environment = (await itemsOf(h.projectId)).find((item) => item.origin === "environment-change");
    expect(environment).toMatchObject({ status: "Pending", workKind: "environment", ownerRoleId: h.platformRoleId });
    if (environment === undefined) throw new Error("no environment task was opened");
    expect(await new WorkItemRowRepository(db).getDependencies(impl)).toEqual([environment.id]);
    expect((await itemsOf(h.projectId)).find((item) => item.id === impl)).toMatchObject({ status: "Pending" });

    // The platform task: only it is admitted; its change builds, passes its probe and the product's build and test, and merges.
    const changed = await h.loop.runCycle();
    expect(changed.results.map((r) => [r.taskId, r.status]), JSON.stringify(changed.results)).toEqual([[environment.id, "completed"]]);
    const versions = await succeededVersions(h.projectId);
    expect(versions).toHaveLength(2);
    const v2 = versions[1];
    expect(v2).not.toBe(v1.version);
    expect(await readFile(join(h.target, "environment", "Containerfile"), "utf8")).toBe(`FROM ${base.image}\nRUN true\n`);

    // The implementation's next dispatch resolves the new version, runs its cells from it, and merges.
    const done = await h.loop.runCycle();
    expect(done.results.map((r) => [r.taskId, r.status])).toEqual([[impl, "completed"]]);
    expect(h.events.filter((e) => e.event === "environment_resolved" && e["taskId"] === impl).map((e) => e["version"])).toEqual([v1.version, v2]);
    expect(await sessionVersions(impl)).toEqual([v1.version, v2]);
    expect(await readFile(join(h.target, "hello.txt"), "utf8")).toBe("hello\n");
    expect((await itemsOf(h.projectId)).filter((item) => item.status !== "Completed")).toEqual([]);
  }, 900_000);

  it("whose definition fails to build leaves the prior version current; the implementation never runs on it and its plan is repaired", async () => {
    const h = await harness("refused");
    const v1 = await runSprint0(h);

    const impl = await implementationTask(h, "Write hello.txt", "cat /workspace/hello.txt || exit 99", v1.version, v1.commit);
    const broken = (): Turn[] => [
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN echo broken-recipe; exit 7\n` }),
      toolCallTurn("finish", { status: "done", summary: "Added the RUN step.", statement: STATEMENT }),
    ];
    // One script per dispatch the failure router allows the platform task (FailureRouter(3)).
    h.scripts.set(ENVIRONMENT_CHANGE_GOAL, [...broken(), ...broken(), ...broken()]);
    h.scripts.set("Write hello.txt", [
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN exit 7\n` }),
      toolCallTurn("finish", { status: "done", summary: "The greeter needs a RUN step in the image." }),
    ]);

    await h.loop.runCycle();
    const environment = (await itemsOf(h.projectId)).find((item) => item.origin === "environment-change");
    if (environment === undefined) throw new Error("no environment task was opened");

    // The platform task's first dispatch: the image build fails, the gate fails it, nothing merges.
    const first = await h.loop.runCycle();
    expect(first.results.map((r) => [r.taskId, r.status])).toEqual([[environment.id, "failed"]]);
    expect(first.results[0]?.detail).toContain("substrate gate failed");
    expect(h.events.find((e) => e.event === "substrate_gate_result" && e["taskId"] === environment.id)).toMatchObject({ passed: false, report: "build_failed" });
    expect(await mainHead(h.target)).toBe(v1.commit);

    // Another implementation dispatched while the platform task retries runs on the prior version.
    const other = await implementationTask(h, "Write other.txt", "cat /workspace/other.txt || exit 99", v1.version, v1.commit);
    h.scripts.set("Write other.txt", [
      toolCallTurn("write_file", { path: "other.txt", content: "other\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote other.txt." }),
    ]);
    const second = await h.loop.runCycle();
    expect(second.results.map((r) => r.taskId).sort()).toEqual([environment.id, other].sort());
    expect(second.results.find((r) => r.taskId === environment.id)?.status).toBe("failed");
    expect(second.results.find((r) => r.taskId === other)?.status, JSON.stringify(second.results)).toBe("completed");
    expect(h.events.filter((e) => e.event === "environment_resolved" && e["taskId"] === other).map((e) => e["version"])).toEqual([v1.version]);
    expect(await sessionVersions(other)).toEqual([v1.version]);

    // The third failure exhausts the bound: the platform task is Abandoned, its plan repair opened.
    const third = await h.loop.runCycle();
    expect(third.results.map((r) => [r.taskId, r.status])).toEqual([[environment.id, "failed"]]);
    const items = await itemsOf(h.projectId);
    // Given up with the reason a plan repair reads (replan.ts abandonedOf), not bare Abandoned.
    expect(items.find((item) => item.id === environment.id)).toMatchObject({ status: "Abandoned", source: "failure_given_up" });
    const repairs = await db.execute(sql`SELECT work_item_id AS "id" FROM plan_repairs WHERE project_id = ${h.projectId} AND plan_revision_id IS NULL`);
    expect(z.array(z.object({ id: z.string() })).parse(repairs.rows)).toEqual([{ id: environment.id }]);

    // The prior version is current: every succeeded build is v1's, and main's definition is Sprint 0's.
    expect(await succeededVersions(h.projectId)).toEqual([v1.version]);
    const failedBuilds = await db.execute(sql`SELECT count(*)::int AS n FROM environment_builds WHERE project_id = ${h.projectId} AND status = 'failed'`);
    expect(z.array(z.object({ n: z.number() })).parse(failedBuilds.rows)[0]?.n).toBeGreaterThan(0);
    expect(await readFile(join(h.target, "environment", "Containerfile"), "utf8")).toBe(`FROM ${base.image}\n`);

    // The implementation is never dispatched again: the project waits on its plan repair.
    const after = await h.loop.runCycle();
    expect(after.tasksProcessed).toBe(0);
    expect((await itemsOf(h.projectId)).find((item) => item.id === impl)).toMatchObject({ status: "Pending" });
    expect(await sessionVersions(impl)).toEqual([v1.version]);
  }, 900_000);
});
