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
import { createTaskCheckStore } from "./task-check-store.js";

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
/** The finish summary names files; only the statement may reach the work item and the client. */
const SUMMARY = "Wrote environment/environment.toml and environment/Containerfile.";

function definition(test: string, options: { readonly build?: string; readonly owned?: readonly string[] } = {}): string {
  return [
    `owned = ${JSON.stringify(options.owned ?? ["environment/"])}`,
    'containerfile = "environment/Containerfile"',
    `build = ${JSON.stringify(options.build ?? "true")}`,
    `test = ${JSON.stringify(test)}`,
    "",
  ].join("\n");
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
    attempt: 1,
    workKind: "environment",
    successCriteria: ["environment/environment.toml parses"],
  };
}

/**
 * An implementation task on record, as a first plan writes it after Sprint 0, with the check its
 * check task stored for it (s-independent-verify-m1).
 */
async function implementationTask(check: string, environmentVersion: string): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const checkTaskId = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, run_scope, project_id, work_kind, owner_role_id)
    VALUES (${id}, 'Task', 'InProgress', 'Write hello.txt', ${RUN_SCOPE_AD_HOC}, ${projectId}, 'implementation', ${randomUUID()}),
           (${checkTaskId}, 'Task', 'Completed', 'Write the checks for "Write hello.txt"', ${RUN_SCOPE_AD_HOC}, ${projectId}, 'check', ${randomUUID()})`);
  await new TaskCheckRepository(db).append({
    projectId,
    taskId: id,
    checkTaskId,
    environmentVersion,
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
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A studio booking site", inferences: [] }) },
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
      images: { build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }) },
      statements: {
        record: (taskId, statement, version) => workItems.recordEnvironmentStatement(taskId, statement, version),
        forVersion: (id, version) => workItems.environmentStatementFor(id, version),
      },
    },
    checks: createTaskCheckStore(db),
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
  it("the environment role builds its environment, finishes with its statement, passes the substrate gate and merges", async () => {
    const { result, mock, events, target, taskId } = await runSprint0("pass", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
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
    expect(await statementOf(taskId)).not.toContain("environment/");
  }, 300_000);

  it("work outside the owned paths fails the gate listing each path, and merges nothing", async () => {
    const { result, target, taskId } = await runSprint0("scope", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("write_file", { path: "src/x", content: "product code\n" }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("touches paths outside the owned paths [environment/]");
    expect(result.detail).toContain("- src/x");
    expect(result.detail).not.toContain("- environment/");
    expect(existsSync(join(target, "environment"))).toBe(false);
    expect(await statementOf(taskId)).toBeNull();
  }, 300_000);

  it("a build output left untracked fails build_environment and the gate listing it; a .gitignore that lists it passes both", async () => {
    const build = "mkdir -p out && echo a > out/a";
    const dirty = await runSprint0("dirty", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo ok", { build }) }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);
    expect(promptText(dirty.mock, 3)).toContain("Checkout after build and test: NOT clean");
    expect(promptText(dirty.mock, 3)).toContain("- out/a");
    expect(dirty.result.status).toBe("failed");
    expect(dirty.result.detail).toContain("substrate gate failed");
    expect(dirty.result.detail).toContain("- out/a");
    expect(existsSync(join(dirty.target, "environment"))).toBe(false);

    // Its test reads what build wrote: post-merge verify must run build before test, as the gate does.
    const owned = ["environment/", ".gitignore"];
    const clean = await runSprint0("clean", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("cat out/a", { build, owned }) }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("write_file", { path: ".gitignore", content: "out/\n" }),
      toolCallTurn("build_environment", {}),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
    ]);
    expect(promptText(clean.mock, 4)).toContain("Checkout after build and test: clean.");
    expect(clean.result.status, clean.result.detail).toBe("completed");
    expect(clean.events.find((e) => e.event === "substrate_gate_result")).toMatchObject({ passed: true, report: "tested" });
    expect(clean.events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "passed" });
    expect(await readFile(join(clean.target, ".gitignore"), "utf8")).toBe("out/\n");
    expect(existsSync(join(clean.target, "out")), "post-merge verify ran on a throwaway checkout, not the target").toBe(false);
  }, 600_000);

  it("a definition whose test fails fails the gate with its output, merges nothing and records no statement", async () => {
    const { result, target, taskId } = await runSprint0("broken", [
      toolCallTurn("write_file", { path: "environment/environment.toml", content: definition("echo broken-test-output; exit 3") }),
      toolCallTurn("write_file", { path: "environment/Containerfile", content: `FROM ${base.image}\n` }),
      toolCallTurn("finish", { status: "done", summary: SUMMARY, statement: STATEMENT }),
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
    await new WorkItemRepository(db).recordMergeCommit(sprint0.taskId, mergeCommit);
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

    const task = await implementationTask("cat /workspace/hello.txt", build.version);
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
        complete: (sid) => sessions.complete(sid),
        fail: (sid, verification) => sessions.fail(sid, verification),
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
      INSERT INTO work_items (id, level, status, title, run_scope, project_id, work_kind, owner_role_id,
                              environment_statement, environment_statement_version, updated_at)
      VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Change the environment', ${RUN_SCOPE_AD_HOC}, ${projectId}, 'environment',
              ${randomUUID()}, ${OTHER}, ${"f".repeat(64)}, now() + interval '1 hour')`);

    const chosen = await runTask(
      "flow",
      await implementationTask("cat /workspace/second.txt", build.version),
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
    const moved = await runTask("flow", await implementationTask("cat /workspace/third.txt", build.version), [], memorySessions);
    expect(moved.result.status, moved.result.detail).toBe("environment_undefined");
    expect(moved.result.detail).toContain("no completed environment task recorded a statement for that version");
    expect(moved.result.detail).not.toContain(build.version);
    expect(moved.mock.doGenerateCalls).toHaveLength(0);
  }, 600_000);
});
