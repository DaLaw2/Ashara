import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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
  VisionRepository,
  WorkItemRepository,
} from "@ashara/db";
import { DevelopmentService } from "@ashara/development";
import { StackChoiceReports } from "@ashara/engagement";
import type { SessionStore, TaskDescriptor } from "@ashara/development";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import { RUN_SCOPE_AD_HOC, createWorkItemId } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { createStackChoiceStore } from "./stack-choice-store.js";

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
  priceWindows: [],
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

function definition(test: string): string {
  return ['owned = ["environment/"]', 'containerfile = "environment/Containerfile"', 'build = "true"', `test = ${JSON.stringify(test)}`, ""].join("\n");
}

/** A Sprint 0 work item on record, owned as environment work, as a first plan writes it. */
async function sprint0Task(): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const taskSpec = { goal: "Define and commit the project environment", origin: "sprint0", checkedBy: "substrate" } as const;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, run_scope, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', 'Define and commit the project environment', ${JSON.stringify(taskSpec)}::jsonb,
            ${RUN_SCOPE_AD_HOC}, ${projectId}, 'environment', ${randomUUID()})`);
  return {
    id,
    projectId,
    title: "Define and commit the project environment",
    taskSpec,
    dispatchCount: 0,
    workKind: "environment",
    successCriteria: ["environment/environment.toml parses"],
  };
}

/** An implementation task on record, as a first plan writes one after Sprint 0. */
async function implementationTask(): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, run_scope, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', 'Write hello.txt', ${RUN_SCOPE_AD_HOC}, ${projectId}, 'implementation', ${randomUUID()})`);
  return { id, projectId, title: "Write hello.txt", dispatchCount: 0, workKind: "implementation", successCriteria: [] };
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
  const gateway = buildGateway({
    config: {
      providers: [
        { name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true },
      ],
      defaultProvider: "anthropic",
    },
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(
      new LlmCallRepository(db),
      new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
    ) },
    clock: () => new Date(),
  });
  const substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
  const builds = new EnvironmentBuildRepository(db);
  const workItems = new WorkItemRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const service = new DevelopmentService({
    config: { workdirBase },
    sessionStore: sessions,
    knowledgeSink: { storeFinding: async () => {}, storeInsight: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => "A studio booking site" },
    cells: { substrate, baseCell: base, instance: `test-${randomUUID()}` },
    llm: gateway,
    staffing: {
      staff: (staffed) => ({
        role: staffed.workKind === "environment" ? "platform" : "developer",
        model: gateway.resolveModel("Strong", "agent-runner"),
      }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }) },
      statements: {
        record: (taskId, statement) => workItems.recordEnvironmentStatement(taskId, statement),
        current: (id) => workItems.currentEnvironmentStatement(id),
      },
    },
    shutdownSignal: new AbortController().signal,
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
  it("the environment role builds its environment, finishes with its statement, passes the substrate gate and merges", async () => {
    const { result, mock, events, target, taskId } = await runSprint0("pass", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: STATEMENT }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(mock.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toContain("build_environment");
    // build_environment ran the test in a cell from the image it built and told the model so.
    expect(promptText(mock, 3)).toContain("Verdict: PASSED");
    expect(promptText(mock, 3)).toMatch(/Environment version [0-9a-f]{64}/);

    // The gate rebuilt nothing (same environment version) and its CI cell's test passed.
    expect(events.find((e) => e.event === "substrate_gate_result")).toMatchObject({ passed: true, report: "tested" });
    expect(events.some((e) => e.event === "verify_started")).toBe(false);
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "passed" });
    expect(await buildsOf()).toEqual(["succeeded"]);

    // Merged into the target's main; the statement is kept on the work item.
    expect(await readFile(join(target, "environment", "environment.toml"), "utf8")).toBe(definition("echo ok"));
    expect(await statementOf(taskId)).toBe(STATEMENT);
  }, 300_000);

  it("a definition whose test fails fails the gate with its output, merges nothing and records no statement", async () => {
    const { result, target, taskId } = await runSprint0("broken", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo broken-test-output; exit 3") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: STATEMENT }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("substrate gate failed");
    expect(result.detail).toContain("FAILED: the test command exited 3");
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
      toolCallTurn("finish", { status: "done", summary: STATEMENT }),
    ]);
    expect(sprint0.result.status, sprint0.result.detail).toBe("completed");
    // Sprint 0 itself ran on the BaseCell.
    expect(sprint0.events.find((e) => e.event === "cell_created")).toMatchObject({ image: base.image, cellImage: { kind: "base-cell" } });
    // What the orchestrator does on a completed result.
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${sprint0.taskId}`);

    const [build] = z
      .array(z.object({ version: z.string(), imageId: z.string() }))
      .parse((await db.execute(sql`SELECT version, image_id AS "imageId" FROM environment_builds WHERE project_id = ${projectId} AND status = 'succeeded'`)).rows);
    if (build === undefined) throw new Error("no succeeded environment build is on record");

    const task = await implementationTask();
    const sessions = new DevSessionRepository(db);
    const liveImages: string[] = [];
    const check = "test -f /workspace/hello.txt";
    const { result, events, workdirBase, taskId } = await runTask(
      "flow",
      task,
      [
        toolCallTurn("write_file", { path: "verify.toml", content: `[checks]\nhello = "${check}"\n` }),
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
        complete: (sid) => sessions.complete(sid),
        fail: (sid, verification) => sessions.fail(sid, verification),
      },
    );

    expect(result.status, result.detail).toBe("completed");
    expect(liveImages).toEqual([build.imageId.replace(/^sha256:/, "")]);
    expect(events.find((e) => e.event === "environment_resolved")).toMatchObject({ version: build.version, imageId: build.imageId, reused: true });
    expect(events.some((e) => e.event === "post_merge_verify" && e["verdict"] === "passed")).toBe(true);

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
    const liaison = new StackChoiceReports(createStackChoiceStore(db));
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
});
