import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ClientRepository,
  createDb,
  DEFAULT_DATABASE_URL,
  DevSessionRepository,
  EnvironmentBuildRepository,
  LlmCallRepository,
  ProjectRepository,
  TaskCheckRepository,
  WorkItemRepository,
} from "@ashara/db";
import { DevelopmentService } from "@ashara/development";
import { StackChoiceReports, VisionRepository } from "@ashara/engagement";
import type { StackChoiceStore } from "@ashara/engagement";
import type { SessionStore, TaskDescriptor } from "@ashara/development";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell, pruneEnvironmentImages } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, systemClock } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { createStackChoiceStore } from "@ashara/server/stack-choice-store";
import { createTaskCheckStore } from "@ashara/server/task-check-store";

// Sprint 0 end to end on real podman, real git and the real recorded gateway, with a scripted
// model: no real LLM call and no skip. The environment role writes a minimal environment, calls
// build_environment, finishes with its stack statement, and Z0's substrate gate decides.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
// Caps far above anything a stubbed call can cost: these tests are about the calls, not the cap.
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };

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

const memorySessions: SessionStore = { insert: async () => {}, complete: async () => {}, fail: async () => {} };

type Db = ReturnType<typeof createDb>;
let db: Db;
let clientId = "";
let projectId: ProjectId;
let root = "";
let base: BaseCellReference;

const STATEMENT = "A shell-only environment on the pinned Debian base: the project needs no toolchain yet.";
/** The finish summary names files; only the statement may reach the work item and the client. */
const SUMMARY = "Wrote environment/environment.toml and environment/Containerfile.";

interface DefinitionOptions {
  readonly build?: string;
  readonly test?: string;
  readonly recipe?: readonly string[];
  readonly inputs?: readonly string[];
}

/** An environment definition (ADR-074 addendum 2 d72): the recipe, its inputs, the probe and the product's commands. */
function definition(probe: string, options: DefinitionOptions = {}): string {
  return [
    'containerfile = "environment/Containerfile"',
    `recipe = ${JSON.stringify(options.recipe ?? [])}`,
    `inputs = ${JSON.stringify(options.inputs ?? [])}`,
    `probe = ${JSON.stringify(probe)}`,
    `build = ${JSON.stringify(options.build ?? "true")}`,
    `test = ${JSON.stringify(options.test ?? "echo product tests ok")}`,
    "",
  ].join("\n");
}

/** A Sprint 0 work item on record, owned as environment work, as a first plan writes it. */
async function sprint0Task(): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const taskSpec = { goal: "Define and commit the project environment", origin: "sprint0", checkedBy: "substrate" } as const;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', 'Define and commit the project environment', ${JSON.stringify(taskSpec)}::jsonb,
            ${projectId}, 'environment', ${randomUUID()})`);
  return {
    id,
    projectId,
    title: "Define and commit the project environment",
    taskSpec,
    dispatchCount: 0,
    attempt: 1,
    workKind: "environment",
    successCriteria: ["environment/environment.toml parses"],
  };
}

/** An environment task Z0 opened for a requester, as requestEnvironmentChange writes it. */
async function environmentChangeTask(product: "present" | "absent"): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const title = `Environment change 1 (${product})`;
  const taskSpec = { goal: "Change the project environment as the requester needs", origin: "environment-change", checkedBy: "substrate", product } as const;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', ${title}, ${JSON.stringify(taskSpec)}::jsonb,
            ${projectId}, 'environment', ${randomUUID()})`);
  return { id, projectId, title, taskSpec, dispatchCount: 0, attempt: 1, workKind: "environment", successCriteria: [] };
}

/**
 * An implementation task on record, as a first plan writes it after Sprint 0, with the check its
 * check task stored for it (s-independent-verify-m1).
 */
async function implementationTask(check: string, environmentVersion: string, baselineCommit = "0".repeat(40)): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const checkTaskId = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', 'Write hello.txt', ${projectId}, 'implementation', ${randomUUID()}),
           (${checkTaskId}, 'Task', 'Completed', 'Write the checks for "Write hello.txt"', ${projectId}, 'check', ${randomUUID()})`);
  await new TaskCheckRepository(db).append({
    projectId,
    taskId: id,
    checkTaskId,
    environmentVersion,
    baselineCommit,
    checks: [{ name: "hello", command: check }],
    files: [],
  });
  return { id, projectId, title: "Write hello.txt", dispatchCount: 0, attempt: 1, workKind: "implementation", successCriteria: [] };
}

interface TaskRun {
  readonly result: Awaited<ReturnType<DevelopmentService["execute"]>>;
  readonly mock: MockLanguageModelV4;
  readonly events: ReadonlyArray<Record<string, unknown> & { readonly event: string }>;
  readonly target: string;
  readonly workdirBase: string;
  readonly taskId: WorkItemId;
}

/** One model turn, or a step run between turns (it sees the task's live cells) that yields the turn. */
type ScriptStep = ReturnType<typeof toolCallTurn> | (() => Promise<ReturnType<typeof toolCallTurn>>);

async function runSprint0(name: string, script: ScriptStep[]): Promise<TaskRun> {
  return runTask(name, await sprint0Task(), script, memorySessions);
}

async function runTask(name: string, task: TaskDescriptor, script: ScriptStep[], sessions: SessionStore): Promise<TaskRun> {
  const workdirBase = join(root, name);
  const target = join(workdirBase, "projects", "p");
  await mkdir(target, { recursive: true });
  const mock = new MockLanguageModelV4({
    doGenerate: async () => {
      const next = script.shift();
      if (next === undefined) throw new Error("the mock model's script is exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  stub.model = mock;
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        { name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true },
      ],
      defaultProvider: "anthropic",
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
  ));
  const substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
  const builds = new EnvironmentBuildRepository(db);
  const workItems = new WorkItemRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const service = new DevelopmentService({
    config: { workdirBase },
    sessionStore: sessions,
    knowledgeSink: { storeFinding: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A studio booking site", assumptions: [] }) },
    cells: { substrate, baseCell: base, instance: `test-${randomUUID()}` },
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
        prune: (projectId, keepVersion) => pruneEnvironmentImages(substrate, projectId, keepVersion),
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
  try {
    const result = await service.execute(task, target);
    const { stdout } = await run("podman", ["ps", "-a", "-q", "--filter", `label=ashara.task=${task.id}`]);
    expect(stdout.trim(), "every cell of the task is gone").toBe("");
    return { result, mock, events, target, workdirBase, taskId: task.id };
  } finally {
    await substrate.teardownAll();
  }
}

async function statementOf(taskId: WorkItemId): Promise<string | null> {
  const result = await db.execute(sql`SELECT environment_statement AS "statement" FROM work_items WHERE id = ${taskId}`);
  const [row] = z.array(z.object({ statement: z.string().nullable() })).parse(result.rows);
  return row?.statement ?? null;
}

async function buildsOf(): Promise<string[]> {
  const result = await db.execute(sql`SELECT status FROM environment_builds WHERE project_id = ${projectId} ORDER BY created_at`);
  return z.array(z.object({ status: z.string() })).parse(result.rows).map((row) => row.status);
}

function promptText(mock: MockLanguageModelV4, call: number): string {
  return JSON.stringify(mock.doGenerateCalls[call]?.prompt ?? null);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`sprint0-${randomUUID()}`)).id;
  projectId = (await new ProjectRepository(db).create(`sprint0-${randomUUID().slice(0, 8)}`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-sprint0-")));
  base = await loadBaseCell();
}, 60_000);

afterAll(async () => {
  const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
  const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
  if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (SELECT id FROM work_items WHERE project_id = ${projectId})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
}, 120_000);

describe("Sprint 0", () => {
  // ADR-074 addendum 2 d72 S: the gate builds the image and runs the probe on a tree that holds no
  // product; the product's build and test, which would fail there, are never run.
  it("the environment role writes only its recipe, its probe passes on an empty product, it passes the substrate gate and merges", async () => {
    const recipe = definition("echo toolchain ok", { build: "echo no product to build >&2; exit 1", test: "exit 1", inputs: ["manifest.txt"] });
    const { result, mock, events, target, taskId } = await runSprint0("pass", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: recipe }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(mock.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toContain("build_environment");
    // build_environment ran the probe in a cell from the image it built and told the model so.
    expect(promptText(mock, 3)).toContain("Probe stdout:\\ntoolchain ok");
    expect(promptText(mock, 3)).toContain("Verdict: PASSED");
    expect(promptText(mock, 3)).not.toContain("Build command");
    expect(promptText(mock, 3)).toMatch(/Environment version [0-9a-f]{64}/);

    // The gate rebuilt nothing (same environment version) and its CI cell's probe passed.
    expect(events.find((e) => e.event === "substrate_gate_result")).toMatchObject({ passed: true, report: "tested" });
    expect(events.some((e) => e.event === "verify_started")).toBe(false);
    const verify = events.find((e) => e.event === "post_merge_verify");
    expect(verify).toMatchObject({ verdict: "passed" });
    expect(String(verify?.["details"])).not.toContain("no product to build");
    expect(await buildsOf()).toEqual(["succeeded"]);

    // Merged into the target's main: the recipe and nothing else; the statement is kept on the work item.
    const { stdout: files } = await run("git", ["-C", target, "ls-tree", "-r", "--name-only", "main"]);
    expect(files.trim().split("\n")).toEqual(["environment/Containerfile", "environment/environment.toml"]);
    expect(await readFile(join(target, "environment", "environment.toml"), "utf8")).toBe(recipe);
    expect(await statementOf(taskId)).toBe(STATEMENT);
    expect(await statementOf(taskId)).not.toContain("environment/");
  }, 300_000);

  it.each([
    ["product code outside environment/", "src/x"],
    ["a product file inside environment/ the definition names as no recipe file", "environment/main.txt"],
    ["an input the recipe reads", "manifest.txt"],
  ])("work touching %s fails the gate listing it, and merges nothing", async (_label, path) => {
    const { result, target, taskId } = await runSprint0(`scope-${path.replace(/\W/g, "-")}`, [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok", { inputs: ["manifest.txt"] }) }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("write_file", { path, content: "product\n" }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("touches paths outside the recipe [environment/environment.toml, environment/Containerfile]");
    expect(result.detail).toContain(`- ${path}`);
    expect(existsSync(join(target, "environment"))).toBe(false);
    expect(await statementOf(taskId)).toBeNull();
  }, 300_000);

  it("a definition whose probe fails fails the gate with its output, merges nothing and records no statement", async () => {
    const { result, target, taskId } = await runSprint0("broken", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo broken-test-output; exit 3") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("substrate gate failed");
    expect(result.detail).toContain("FAILED: the probe command exited 3");
    expect(result.detail).toContain("broken-test-output");
    expect(existsSync(join(target, "environment"))).toBe(false);
    expect(await statementOf(taskId)).toBeNull();
  }, 300_000);

  it("after Sprint 0 merges, the next task's cells run from the environment image, and the stack choice reaches the vision and the client once", async () => {
    await new VisionRepository(db).create(projectId, {
      visionText: "A studio booking site",
      summary: "Book studio time online",
      inferences: [{ key: "A1", statement: "Bookings are in one time zone", rationale: "the tender names one city", status: "Inferred" }],
    });

    const sprint0 = await runSprint0("flow", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);
    expect(sprint0.result.status, sprint0.result.detail).toBe("completed");
    // Sprint 0 itself ran on the BaseCell.
    expect(sprint0.events.find((e) => e.event === "cell_created")).toMatchObject({ image: base.image, cellImage: { kind: "base-cell" } });
    // What the orchestrator does on a completed result: the merge record, then Completed.
    if (sprint0.result.status !== "completed" || sprint0.result.delivered.kind !== "merged") throw new Error("Sprint 0 did not merge");
    const mergeCommit = sprint0.result.delivered.mergeCommit;
    const { stdout: mainHead } = await run("git", ["-C", sprint0.target, "rev-parse", "main"]);
    expect(mainHead.trim()).toBe(mergeCommit);
    await new WorkItemRepository(db).recordMergeCommit(sprint0.taskId, mergeCommit, "merged");
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${sprint0.taskId}`);

    // The version Sprint 0's gate tested: earlier tests of this project built other versions.
    const gated = /Environment version ([0-9a-f]{64})/.exec(String(sprint0.events.find((e) => e.event === "substrate_gate_result")?.["output"]));
    const [build] = z
      .array(z.object({ version: z.string(), imageId: z.string() }))
      .parse(
        (await db.execute(sql`SELECT version, image_id AS "imageId" FROM environment_builds
                              WHERE project_id = ${projectId} AND status = 'succeeded' AND version = ${gated?.[1] ?? ""}`)).rows,
      );
    if (build === undefined) throw new Error("no succeeded environment build is on record");

    const task = await implementationTask("cat /workspace/hello.txt || exit 99", build.version);
    const sessions = new DevSessionRepository(db);
    const liveImages: string[] = [];
    const { result, events, workdirBase, taskId } = await runTask(
      "flow",
      task,
      [
        async () => {
          // The task's cell, inspected while the attempt runs.
          const { stdout } = await run("podman", ["ps", "--filter", `label=ashara.task=${task.id}`, "--format", "json"]);
          liveImages.push(...z.array(z.object({ ImageID: z.string() })).parse(JSON.parse(stdout)).map((cell) => cell.ImageID));
          return toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" });
        },
        toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt." }),
      ],
      {
        insert: (sid, tid, brief, version) => sessions.insert(sid, tid, brief, version),
        complete: (sid, attempt, end) => sessions.complete(sid, attempt, end),
        fail: (sid, verification, attempt) => sessions.fail(sid, verification, attempt),
      },
    );

    expect(result.status, result.detail).toBe("completed");
    expect(liveImages).toEqual([build.imageId.replace(/^sha256:/, "")]);
    expect(events.find((e) => e.event === "environment_resolved")).toMatchObject({ version: build.version, imageId: build.imageId, reused: true });
    expect(events.some((e) => e.event === "post_merge_verify" && e["verdict"] === "passed")).toBe(true);
    // The implementation attempt was never offered define_check, the environment attempt never was either.
    expect(sprint0.mock.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).not.toContain("define_check");

    // The version is recorded with the attempt and on its dev session.
    const [sessionDir] = await readdir(join(workdirBase, "records", taskId));
    const conversation = await readFile(join(workdirBase, "records", taskId, sessionDir ?? "", "conversation.jsonl"), "utf8");
    const first: unknown = JSON.parse(conversation.split("\n")[0] ?? "null");
    expect(first).toMatchObject({ kind: "attempt_started", cellImage: { kind: "environment", version: build.version, imageId: build.imageId } });
    expect(z.object({ system: z.string() }).parse(first).system).toContain(STATEMENT);
    const recorded = z
      .array(z.object({ version: z.string().nullable() }))
      .parse((await db.execute(sql`SELECT environment_version AS "version" FROM dev_sessions WHERE task_id = ${taskId}`)).rows);
    expect(recorded).toEqual([{ version: build.version }]);

    // The stack choice: an Inferred assumption in vision v2 and one report, however often the Liaison runs.
    // The scan reads every project: narrowed to this one, a project another file is running is neither reported nor blocked here.
    const store = createStackChoiceStore(db);
    const ours: StackChoiceStore = { ...store, dueStackChoices: async () => (await store.dueStackChoices()).filter((due) => due.projectId === projectId) };
    const liaison = new StackChoiceReports(ours);
    expect(await liaison.runPending()).toEqual([{ kind: "recorded", projectId, visionVersion: 2 }]);
    expect(await liaison.runPending()).toEqual([]);
    const vision = await new VisionRepository(db).getCurrent(projectId);
    expect(vision?.version).toBe(2);
    expect(vision?.visionText).toBe("A studio booking site");
    expect(vision?.inferences).toEqual([
      { key: "A1", statement: "Bookings are in one time zone", rationale: "the tender names one city", status: "Inferred" },
      expect.objectContaining({ key: "A2", statement: STATEMENT, status: "Inferred" }),
    ]);
    const reports = z
      .array(z.object({ body: z.string() }))
      .parse((await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND reports_on = 'stack-choice'`)).rows);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.body).toContain(STATEMENT);
  }, 600_000);

  // D5 of the 2026-10-14 Sprint 0 run: the statement was the project's latest, whatever version was on main.
  it("the statement is the one recorded for the version on main; a version no environment task recorded is environment_undefined", async () => {
    // Earlier cases in this project build other versions (the untracked-output case), so the version on main is
    // the one the last dispatch after Sprint 0 resolved, not any succeeded build.
    const [build] = z
      .array(z.object({ version: z.string() }))
      .parse((await db.execute(sql`
        SELECT s.environment_version AS "version" FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
        WHERE w.project_id = ${projectId} AND s.environment_version IS NOT NULL
        ORDER BY s.created_at DESC LIMIT 1`)).rows);
    if (build === undefined) throw new Error("no dispatch after Sprint 0 recorded an environment version");
    const recorded = z
      .array(z.object({ version: z.string().nullable() }))
      .parse((await db.execute(sql`
        SELECT environment_statement_version AS "version" FROM work_items
        WHERE project_id = ${projectId} AND work_kind = 'environment' AND status = 'Completed'`)).rows);
    expect(recorded).toEqual([{ version: build.version }]);

    // A later environment task's statement, recorded for another version.
    const OTHER = "A statement recorded for another environment version.";
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id,
                              environment_statement, environment_statement_version, updated_at)
      VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Change the environment', ${projectId}, 'environment',
              ${randomUUID()}, ${OTHER}, ${"f".repeat(64)}, now() + interval '1 hour')`);

    const chosen = await runTask(
      "flow",
      await implementationTask("cat /workspace/second.txt || exit 99", build.version),
      [toolCallTurn("write_file", { path: "second.txt", content: "second\n" }), toolCallTurn("finish", { status: "done", summary: "Wrote second.txt." })],
      memorySessions,
    );
    expect(chosen.result.status, chosen.result.detail).toBe("completed");
    const [sessionDir] = await readdir(join(chosen.workdirBase, "records", chosen.taskId));
    const conversation = await readFile(join(chosen.workdirBase, "records", chosen.taskId, sessionDir ?? "", "conversation.jsonl"), "utf8");
    const { system } = z.object({ system: z.string() }).parse(JSON.parse(conversation.split("\n")[0] ?? "null"));
    expect(system).toContain(STATEMENT);
    expect(system).not.toContain(OTHER);

    // A non-environment commit moves the version on main: no statement is on record for it.
    await writeFile(join(chosen.target, "environment", "Containerfile"), `FROM ${base.image}\n# moved by an implementer\n`);
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-am", "implementer"], { cwd: chosen.target });
    const moved = await runTask("flow", await implementationTask("cat /workspace/third.txt || exit 99", build.version), [], memorySessions);
    expect(moved.result.status, moved.result.detail).toBe("environment_undefined");
    expect(moved.result.detail).toContain("recorded a statement for that version: no merge Ashara verified produced it");
    expect(moved.result.detail).not.toContain(build.version);
    expect(moved.mock.doGenerateCalls).toHaveLength(0);
  }, 600_000);

  // ADR-074 addendum 2 d72 B1, B3: an input the recipe reads is the product's, versioned, not fenced;
  // only the recipe is protected, and a change there is requested, not parked.
  it("an implementation writing an input merges once the rebuilt image passes the product's build and test and the checks; the next dispatch runs on that version", async () => {
    const sprint0 = await runSprint0("owned", [
      toolCallTurn("write_file", {
        path: "environment/environment.toml",
        content: definition("echo ok", { test: "cat manifest.txt", inputs: ["manifest.txt"] }),
      }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);
    expect(sprint0.result.status, sprint0.result.detail).toBe("completed");
    if (sprint0.result.status !== "completed" || sprint0.result.delivered.kind !== "merged") throw new Error("Sprint 0 did not merge");
    await new WorkItemRepository(db).recordMergeCommit(sprint0.taskId, sprint0.result.delivered.mergeCommit, "merged");
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${sprint0.taskId}`);
    const gated = /Environment version ([0-9a-f]{64})/.exec(String(sprint0.events.find((e) => e.event === "substrate_gate_result")?.["output"]))?.[1];
    if (gated === undefined) throw new Error("the gate reported no environment version");

    const changed = await runTask(
      "owned",
      await implementationTask("cat /workspace/hello.txt || exit 99", gated),
      [
        toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
        toolCallTurn("write_file", { path: "manifest.txt", content: "dependencies: greeter\n" }),
        toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt and added the greeter dependency." }),
      ],
      memorySessions,
    );
    expect(changed.result.status, changed.result.detail).toBe("completed");
    expect(changed.events.find((e) => e.event === "ownership_gate")).toMatchObject({ verdict: "clean" });
    const rebuilt = changed.events.find((e) => e.event === "environment_rebuilt");
    expect(rebuilt).toMatchObject({ from: gated, to: expect.stringMatching(/^[0-9a-f]{64}$/), reused: false });
    const version = String(rebuilt?.["to"]);
    expect(version).not.toBe(gated);
    // The rebuilt image is recorded, and its build and test ran on the merge before the suites.
    const builds = z
      .array(z.object({ status: z.string() }))
      .parse((await db.execute(sql`SELECT status FROM environment_builds WHERE project_id = ${projectId} AND version = ${version}`)).rows);
    expect(builds).toEqual([{ status: "succeeded" }]);
    const verdict = changed.events.find((e) => e.event === "post_merge_verify");
    expect(verdict).toMatchObject({ verdict: "passed" });
    expect(String(verdict?.["details"])).toContain(`version ${gated} becomes ${version}`);
    expect(String(verdict?.["details"])).toContain("dependencies: greeter");
    expect(await readFile(join(changed.target, "manifest.txt"), "utf8")).toBe("dependencies: greeter\n");
    // The new version carries the statement of the one it was built from, on the implementation's own row.
    const carried = z
      .array(z.object({ statement: z.string().nullable(), version: z.string().nullable() }))
      .parse((await db.execute(sql`SELECT environment_statement AS "statement", environment_statement_version AS "version"
                                   FROM work_items WHERE id = ${changed.taskId}`)).rows);
    expect(carried).toEqual([{ statement: STATEMENT, version }]);

    if (changed.result.status !== "completed" || changed.result.delivered.kind !== "merged") throw new Error("the implementation did not merge");
    await new WorkItemRepository(db).recordMergeCommit(changed.taskId, changed.result.delivered.mergeCommit, "merged");
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${changed.taskId}`);

    const next = await runTask(
      "owned",
      await implementationTask("cat /workspace/next.txt || exit 99", version),
      [toolCallTurn("write_file", { path: "next.txt", content: "next\n" }), toolCallTurn("finish", { status: "done", summary: "Wrote next.txt." })],
      memorySessions,
    );
    expect(next.result.status, next.result.detail).toBe("completed");
    expect(next.events.find((e) => e.event === "environment_resolved")).toMatchObject({ version, reused: true });
    expect(next.events.some((e) => e.event === "environment_rebuilt")).toBe(false);
  }, 600_000);

  // The t-env-recipe review: the product scaffold asking for an environment change opens one whose
  // merge lands on a main with no product; running the product's build and test there fails it and
  // stalls every task behind the scaffold. Recorded "absent", only the probe runs (d72 S).
  it("an environment change opened with no product on main runs the probe only; one opened with a product runs its build and test", async () => {
    const recipe = definition("echo toolchain ok", { build: "cat product.txt", test: "cat product.txt" });
    const sprint0 = await runSprint0("scaffold-asks", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: recipe }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);
    expect(sprint0.result.status, sprint0.result.detail).toBe("completed");
    if (sprint0.result.status !== "completed" || sprint0.result.delivered.kind !== "merged") throw new Error("Sprint 0 did not merge");
    await new WorkItemRepository(db).recordMergeCommit(sprint0.taskId, sprint0.result.delivered.mergeCommit, "merged");
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${sprint0.taskId}`);
    const change = (): ScriptStep[] => [
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN true\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: "Added a RUN step.", statement: STATEMENT }),
    ];

    const present = await runTask("scaffold-asks", await environmentChangeTask("present"), change(), memorySessions);
    expect(present.result.status).toBe("failed");
    expect(String(present.events.find((e) => e.event === "post_merge_verify")?.["details"])).toContain("The product's build and test on the merge");

    const absent = await runTask("scaffold-asks", await environmentChangeTask("absent"), change(), memorySessions);
    expect(absent.result.status, absent.result.detail).toBe("completed");
    const verify = absent.events.find((e) => e.event === "post_merge_verify");
    expect(verify).toMatchObject({ verdict: "passed" });
    expect(String(verify?.["details"])).not.toContain("The product's build and test");
    expect(await readFile(join(absent.target, "environment", "Containerfile"), "utf8")).toBe(`FROM ${base.image}\nRUN true\n`);
  }, 600_000);

  it("an implementation changing a recipe file requests an environment change: nothing merged, its branch deleted", async () => {
    const { stdout: mainBefore } = await run("git", ["-C", join(root, "owned", "projects", "p"), "rev-parse", "main"]);
    const { result, events, target, taskId } = await runTask(
      "owned",
      // Stored on another environment: red-run again on its baseline, today's main.
      await implementationTask("cat /workspace/fourth.txt || exit 99", "0".repeat(64), mainBefore.trim()),
      [
        toolCallTurn("write_file", { path: "fourth.txt", content: "fourth\n" }),
        toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\nRUN true\n` }),
        toolCallTurn("finish", { status: "done", summary: "The greeter needs a RUN step in the image." }),
      ],
      memorySessions,
    );

    expect(result.status, result.detail).toBe("environment_change_requested");
    if (result.status !== "environment_change_requested") return;
    expect(result.paths).toEqual(["environment/Containerfile"]);
    expect(result.need).toBe("The greeter needs a RUN step in the image.");
    expect(result.diff).toContain("+RUN true");
    expect(events.some((e) => e.event === "post_merge_verify")).toBe(false);
    expect(existsSync(join(target, "fourth.txt"))).toBe(false);
    const { stdout: branches } = await run("git", ["-C", target, "branch", "--list", `task/${taskId}`]);
    expect(branches.trim()).toBe("");
    const { stdout: mainAfter } = await run("git", ["-C", target, "rev-parse", "main"]);
    expect(mainAfter).toBe(mainBefore);
  }, 600_000);
});
