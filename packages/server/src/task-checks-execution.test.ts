import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  EnvironmentBuildRepository,
  LlmCallRepository,
  ProjectRepository,
  TaskCheckRepository,
} from "@ashara/db";
import { DevelopmentService } from "@ashara/development";
import type { TaskDescriptor } from "@ashara/development";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import { FailureRouter, classifyFailure } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, createWorkItemId } from "@ashara/shared";
import type { ProjectId, WorkItemId, WorkKind } from "@ashara/shared";
import { createTaskCheckStore } from "./task-check-store.js";

// Independent verification end to end (story s-independent-verify-m1) on real podman, real git, the
// real recorded gateway and the real task_checks table, with a scripted model: no real LLM call and
// no skip. A check task's checks are red-run on main and stored; an implementation task is decided
// by them on its tentative merge.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
// Caps far above anything a stubbed call can cost: these tests are about the checks, not the cap.
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

type Db = ReturnType<typeof createDb>;
let db: Db;
let clientId = "";
let projectId: ProjectId;
let root = "";
let workdirBase = "";
let target = "";
let base: BaseCellReference;
let substrate: PodmanSubstrate;

const HELLO_CHECK = "grep hello hello.txt\n";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: target });
  return stdout.trim();
}

/** An implementation task and its check task on record, as a first plan writes them after Sprint 0. */
async function plannedPair(title: string): Promise<{ readonly implementation: TaskDescriptor; readonly check: TaskDescriptor }> {
  const implementationId = createWorkItemId();
  const checkId = createWorkItemId();
  const checkTitle = `Write the checks for "${title}"`;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, run_scope, project_id, work_kind, owner_role_id)
    VALUES (${implementationId}, 'Task', 'Pending', ${title}, ${RUN_SCOPE_AD_HOC}, ${projectId}, 'implementation', ${randomUUID()}),
           (${checkId}, 'Task', 'InProgress', ${checkTitle}, ${RUN_SCOPE_AD_HOC}, ${projectId}, 'check', ${randomUUID()})`);
  await db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${implementationId}, ${checkId})`);
  const descriptor = (id: WorkItemId, taskTitle: string, workKind: WorkKind): TaskDescriptor => ({
    id,
    projectId,
    title: taskTitle,
    dispatchCount: 0,
    workKind,
    successCriteria: [],
  });
  return { implementation: descriptor(implementationId, title, "implementation"), check: descriptor(checkId, checkTitle, "check") };
}

interface TaskRun {
  readonly result: Awaited<ReturnType<DevelopmentService["execute"]>>;
  readonly mock: MockLanguageModelV4;
  readonly events: ReadonlyArray<Record<string, unknown> & { readonly event: string }>;
}

async function runTask(task: TaskDescriptor, script: Array<ReturnType<typeof toolCallTurn>>): Promise<TaskRun> {
  const mock = new MockLanguageModelV4({
    doGenerate: async () => {
      const next = script.shift();
      if (next === undefined) throw new Error("the mock model's script is exhausted");
      return next;
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
    recording: {
      kind: "recorded",
      recorder: new LlmCallLedger(
        new LlmCallRepository(db),
        new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
      ),
    },
    clock: () => new Date(),
  });
  const builds = new EnvironmentBuildRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const service = new DevelopmentService({
    config: { workdirBase },
    sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
    knowledgeSink: { storeFinding: async () => {}, storeInsight: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => "A greeting page" },
    cells: { substrate, baseCell: base, instance: `test-${randomUUID()}` },
    llm: gateway,
    staffing: {
      staff: (staffed) => ({
        role: staffed.workKind === "check" ? "check-author" : "developer",
        model: gateway.resolveModel("Strong", "agent-runner"),
      }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }) },
      statements: {
        record: async () => {
          throw new Error("no environment statement is recorded here");
        },
        current: async () => "A plain Debian shell environment: the project is text files.",
      },
    },
    checks: createTaskCheckStore(db),
    shutdownSignal: new AbortController().signal,
  });
  const result = await service.execute(task, target);
  const { stdout } = await run("podman", ["ps", "-a", "-q", "--filter", `label=ashara.task=${task.id}`]);
  expect(stdout.trim(), "every cell of the task is gone").toBe("");
  return { result, mock, events };
}

const CheckRowSchema = z.object({
  revision: z.number(),
  name: z.string(),
  command: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  environmentVersion: z.string(),
  checkTaskId: z.string(),
});

async function checkRowsOf(taskId: WorkItemId) {
  const result = await db.execute(sql`
    SELECT revision, name, command, files, environment_version AS "environmentVersion", check_task_id AS "checkTaskId"
    FROM task_checks WHERE task_id = ${taskId} ORDER BY revision, name`);
  return z.array(CheckRowSchema).parse(result.rows);
}

function toolNames(mock: MockLanguageModelV4): string[] {
  return mock.doGenerateCalls[0]?.tools?.map((tool) => tool.name) ?? [];
}

function promptText(mock: MockLanguageModelV4): string {
  return JSON.stringify(mock.doGenerateCalls[0]?.prompt ?? null);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`task-checks-${randomUUID()}`)).id;
  projectId = (await new ProjectRepository(db).create(`task-checks-${randomUUID().slice(0, 8)}`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-task-checks-")));
  workdirBase = join(root, "work");
  target = join(workdirBase, "projects", "p");
  await mkdir(join(target, "environment"), { recursive: true });
  base = await loadBaseCell();
  // The environment a merged Sprint 0 leaves on main: the BaseCell image, unchanged.
  await writeFile(
    join(target, "environment", "environment.toml"),
    'owned = ["environment/"]\ncontainerfile = "environment/Containerfile"\nbuild = "true"\ntest = "true"\n',
  );
  await writeFile(join(target, "environment", "Containerfile"), `FROM ${base.image}\n`);
  await run("git", ["init", "-q", "-b", "main"], { cwd: target });
  await git("add", "environment");
  await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment");
  substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
}, 60_000);

afterAll(async () => {
  await substrate.teardownAll();
  const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
  const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
  if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
}, 120_000);

describe("independent verification", () => {
  let hello: { readonly implementation: TaskDescriptor; readonly check: TaskDescriptor };

  it("a check task's check that fails on main is stored; nothing of the check task reaches main", async () => {
    hello = await plannedPair("Write hello.txt");
    const mainBefore = await git("rev-parse", "main");

    const { result, mock, events } = await runTask(hello.check, [
      toolCallTurn("write_file", { path: "checks/hello.sh", content: HELLO_CHECK }),
      toolCallTurn("define_check", { name: "says hello", command: "sh checks/hello.sh" }),
      toolCallTurn("finish", { status: "done", summary: "One check: hello.txt says hello." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(toolNames(mock)).toContain("define_check");
    expect(toolNames(mock)).not.toContain("build_environment");
    expect(events.find((e) => e.event === "check_red_run")).toMatchObject({ rejected: [] });
    const rows = await checkRowsOf(hello.implementation.id);
    expect(rows).toEqual([
      {
        revision: 1,
        name: "says hello",
        command: "sh checks/hello.sh",
        files: [{ path: "checks/hello.sh", content: HELLO_CHECK }],
        environmentVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
        checkTaskId: hello.check.id,
      },
    ]);
    // Discarded: main is where it was, the throwaway branch and its worktree are gone.
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("branch", "--list", `check/${hello.check.id}`)).toBe("");
    expect(existsSync(join(target, "checks"))).toBe(false);
    expect(await git("worktree", "list", "--porcelain")).not.toContain("checkouts");
  }, 300_000);

  it("a vacuous check, one that already passes on main, is rejected and nothing is stored", async () => {
    const vacuous = await plannedPair("Write a page");

    const { result } = await runTask(vacuous.check, [
      toolCallTurn("define_check", { name: "always", command: "echo fine" }),
      toolCallTurn("finish", { status: "done", summary: "One check." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("already passes on main");
    expect(await checkRowsOf(vacuous.implementation.id)).toEqual([]);
    expect(await git("branch", "--list", `check/${vacuous.check.id}`)).toBe("");
  }, 300_000);

  it("a check whose command the environment cannot run is rejected, though it fails on main", async () => {
    const unrunnable = await plannedPair("Write a form");

    const { result } = await runTask(unrunnable.check, [
      toolCallTurn("define_check", { name: "form", command: "no-such-tool-in-this-environment --check" }),
      toolCallTurn("finish", { status: "done", summary: "One check." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("cannot be run in the project environment (exit 127)");
    expect(await checkRowsOf(unrunnable.implementation.id)).toEqual([]);
  }, 300_000);

  it("an implementation task whose stored check passes on its merge completes, and the check files are not merged", async () => {
    const { result, mock, events } = await runTask(hello.implementation, [
      toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(toolNames(mock)).not.toContain("define_check");
    expect(promptText(mock)).toContain("Checks that decide this task");
    expect(promptText(mock)).toContain("sh checks/hello.sh");
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({
      verdict: "passed",
      revision: 1,
      details: expect.stringContaining('Check "says hello": PASSED'),
    });
    expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(target, "checks"))).toBe(false);
  }, 300_000);

  it("an implementation that rewrites its check file to pass still runs the stored original, and fails", async () => {
    const goodbye = await plannedPair("Write bye.txt");
    const original = "grep goodbye bye.txt\n";
    await new TaskCheckRepository(db).append({
      projectId,
      taskId: goodbye.implementation.id,
      checkTaskId: goodbye.check.id,
      environmentVersion: "e".repeat(64),
      checks: [{ name: "says goodbye", command: "sh checks/bye.sh" }],
      files: [{ path: "checks/bye.sh", content: original }],
    });
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(goodbye.implementation, [
      toolCallTurn("write_file", { path: "checks/bye.sh", content: "echo goodbye\nexit 0\n" }),
      toolCallTurn("write_file", { path: "bye.txt", content: "see you\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote bye.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("post-merge verify failed");
    expect(JSON.stringify(result.errorEnvelope)).toContain('Check \\"says goodbye\\": FAILED: exited 1');
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    const category = classifyFailure(result.errorEnvelope);
    expect(category).toBe("VERIFICATION_GAP");
    expect(new FailureRouter(2).route({
      item: { id: goodbye.implementation.id },
      failure: { detail: result.detail, raw: {} },
      priorAttempts: 1,
      category,
    })).toMatchObject({ action: "replan", attempt: 2 });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("branch", "--list", `task/${goodbye.implementation.id}`)).not.toBe("");
  }, 300_000);

  it("an implementation task with no stored checks fails before any model call", async () => {
    const unchecked = await plannedPair("Write nothing.txt");

    const { result, mock } = await runTask(unchecked.implementation, []);

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("loadTaskChecks");
    expect(mock.doGenerateCalls).toHaveLength(0);
  }, 300_000);
});
