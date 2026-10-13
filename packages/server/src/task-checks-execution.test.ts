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
  CheckDisputeRepository,
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
import { BlockReports } from "@ashara/engagement";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import { FailureRouter, classifyFailure } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, createWorkItemId } from "@ashara/shared";
import type { ProjectId, WorkItemId, WorkKind } from "@ashara/shared";
import { createBlockReportStore } from "./block-report-store.js";
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
    attempt: 1,
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
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting page", inferences: [] }) },
    cells: { substrate, baseCell: base, instance: `test-${randomUUID()}` },
    llm: gateway,
    staffing: {
      staff: async (staffed) => ({
        kind: "staffed",
        staff: {
          role: staffed.workKind === "check" ? { id: "check-author", name: "Check Author" } : { id: "developer", name: "Developer" },
          model: gateway.resolveModel("Strong", "agent-runner"),
        },
      }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }) },
      statements: {
        record: async () => {
          throw new Error("no environment statement is recorded here");
        },
        forVersion: async () => "A plain Debian shell environment: the project is text files.",
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
    'owned = ["environment/"]\ncontainerfile = "environment/Containerfile"\nbuild = "true"\ntest = "test ! -e BROKEN && echo environment ok"\n',
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
  await db.execute(sql`DELETE FROM check_disputes WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
}, 120_000);

/** "Write hello.txt" and its check task: stored and merged by the first describe, a regression set for the second. */
let hello: { readonly implementation: TaskDescriptor; readonly check: TaskDescriptor };

describe("independent verification", () => {

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

  // Second run N1/N5: checks in bash-only syntax failed on main with a dash syntax error, which the
  // red run accepts, and the author could not replace them.
  it("define_check red-runs the check at once and shows why it fails; a redefinition replaces it", async () => {
    const greeting = await plannedPair("Write hi.txt");

    const { result, mock, events } = await runTask(greeting.check, [
      toolCallTurn("define_check", { name: "says hi", command: "words=(hi); grep -q hi hi.txt && cat hi.txt" }),
      toolCallTurn("write_file", { path: "checks/hi.sh", content: "grep hi hi.txt\n" }),
      toolCallTurn("define_check", { name: "says hi", command: "sh checks/hi.sh" }),
      toolCallTurn("finish", { status: "done", summary: "One check: hi.txt says hi." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const afterFirst = JSON.stringify(mock.doGenerateCalls[1]?.prompt ?? null);
    expect(afterFirst).toContain('Defined check \\"says hi\\"');
    expect(afterFirst).toContain("exit code: 2");
    expect(afterFirst).toMatch(/Syntax error|unexpected/);
    const afterRedefine = JSON.stringify(mock.doGenerateCalls[3]?.prompt ?? null);
    expect(afterRedefine).toContain('Replaced check \\"says hi\\" (1 defined so far)');
    expect(afterRedefine).toContain("hi.txt: No such file");
    expect(events.filter((e) => e.event === "check_defined")).toMatchObject([
      { name: "says hi", replaced: false, exitCode: 2, rejection: null },
      { name: "says hi", replaced: true, exitCode: 2, rejection: null },
    ]);
    expect(await checkRowsOf(greeting.implementation.id)).toEqual([
      expect.objectContaining({ name: "says hi", command: "sh checks/hi.sh", files: [{ path: "checks/hi.sh", content: "grep hi hi.txt\n" }] }),
    ]);
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
    expect(promptText(mock)).toContain("#### checks/hello.sh");
    expect(promptText(mock)).toContain(HELLO_CHECK.trim());
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({
      verdict: "passed",
      revision: 1,
      details: expect.stringContaining('Check "says hello": PASSED'),
    });
    expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(target, "checks"))).toBe(false);
  }, 300_000);

  it("an implementation that rewrites its check file to pass is refused by the ownership gate before the merge", async () => {
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
    expect(result.detail).toContain(`checks/bye.sh (checks of task ${goodbye.implementation.id})`);
    expect(result.detail).toContain("check files belong to the check author");
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(result.errorEnvelope.chain.operation).toBe("ownershipGate");
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

// D3 of the 2026-10-14 Sprint 0 run: a merge was checked only against its own task's checks.
describe("post-merge regression suite", () => {
  /** What the orchestrator does on a completed result. */
  async function markCompleted(taskId: WorkItemId): Promise<void> {
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${taskId}`);
  }

  /** A pair whose check, stored on the current environment version, is one command with no file. */
  async function checkedPair(title: string, check: { readonly name: string; readonly command: string }) {
    const pair = await plannedPair(title);
    const [helloRow] = await checkRowsOf(hello.implementation.id);
    if (helloRow === undefined) throw new Error("the first describe's hello checks are not on record");
    await new TaskCheckRepository(db).append({
      projectId,
      taskId: pair.implementation.id,
      checkTaskId: pair.check.id,
      environmentVersion: helloRow.environmentVersion,
      checks: [check],
      files: [],
    });
    return pair;
  }

  beforeAll(async () => {
    // The first describe merged "Write hello.txt", decided by its stored "says hello" check.
    await markCompleted(hello.implementation.id);
  });

  it("a merge that breaks an earlier task's stored check fails naming that task and check, as this task's regression; nothing merged", async () => {
    const greet = await checkedPair("Write greet.txt", { name: "greets", command: "grep hi greet.txt" });
    const mainBefore = await git("rev-parse", "main");

    const { result, events } = await runTask(greet.implementation, [
      toolCallTurn("write_file", { path: "greet.txt", content: "hi\n" }),
      toolCallTurn("write_file", { path: "hello.txt", content: "bye\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote greet.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`REGRESSION: earlier task ${hello.implementation.id}'s checks revision 1`);
    expect(result.detail).toContain('check "says hello" FAILED: exited 1');
    expect(result.detail).toContain("the regression is this task's");
    // Its own check and the environment's test passed: only the regression failed it.
    expect(result.detail).toContain('Check "greets": PASSED');
    expect(result.detail).toContain('Check "environment test": PASSED');
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "failed", regressionTasks: [hello.implementation.id] });
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(classifyFailure(result.errorEnvelope)).toBe("VERIFICATION_GAP");
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(target, "greet.txt"))).toBe(false);
  }, 300_000);

  it("a merge that fails the environment's test fails naming it; nothing merged", async () => {
    const notes = await checkedPair("Write notes.txt", { name: "notes", command: "grep note notes.txt" });
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(notes.implementation, [
      toolCallTurn("write_file", { path: "notes.txt", content: "a note\n" }),
      toolCallTurn("write_file", { path: "BROKEN", content: "breaks the environment's test\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote notes.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`the environment's test (version `);
    expect(result.detail).toContain('check "environment test" FAILED: exited 1');
    expect(result.detail).not.toContain("REGRESSION");
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(join(target, "BROKEN"))).toBe(false);
  }, 300_000);

  it("a merge that passes the environment's test, every earlier task's checks and its own is merged", async () => {
    const wave = await checkedPair("Write wave.txt", { name: "waves", command: "grep wave wave.txt" });

    const { result, events } = await runTask(wave.implementation, [
      toolCallTurn("write_file", { path: "wave.txt", content: "wave\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote wave.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const verify = events.find((e) => e.event === "post_merge_verify");
    expect(verify).toMatchObject({ verdict: "passed", regressionTasks: [hello.implementation.id], boundSeconds: 3 * 60 });
    expect(verify?.["details"]).toContain('Check "environment test": PASSED');
    expect(verify?.["details"]).toContain('Check "says hello": PASSED');
    expect(verify?.["details"]).toContain('Check "waves": PASSED');
    expect(await readFile(join(target, "wave.txt"), "utf8")).toBe("wave\n");
    // The earlier task's check file was written over the checkout, never merged.
    expect(existsSync(join(target, "checks"))).toBe(false);
  }, 300_000);

  // The review of t-regression-suite-postmerge: CompletedTaskUnchecked blocked every later merge with no exit.
  it("an earlier task Completed with no stored check is named as not re-run, never a block; the merge is decided by the rest", async () => {
    const legacy = await plannedPair("Write legacy.txt");
    await markCompleted(legacy.implementation.id);
    const tide = await checkedPair("Write tide.txt", { name: "tides", command: "grep tide tide.txt" });

    const { result, events } = await runTask(tide.implementation, [
      toolCallTurn("write_file", { path: "tide.txt", content: "tide\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote tide.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const verify = events.find((e) => e.event === "post_merge_verify");
    expect(verify).toMatchObject({ verdict: "passed", uncheckedTasks: [legacy.implementation.id] });
    expect(verify?.["regressionTasks"]).not.toContain(legacy.implementation.id);
    expect(verify?.["details"]).toContain(`Not re-run, no check is stored for them (completed before checks existed): ${legacy.implementation.id}`);
  }, 300_000);

  // docs/investigations/second-run-2026-10-14.md N2 (no exit from a wrong check) and N3 (a retry judged
  // only on its own uncommitted diff).
  it("a disputed check ends the attempt as disputed with the work kept; a re-dispatch that finds it done on the branch runs the gates", async () => {
    const reef = await checkedPair("Write reef.txt", { name: "reefs", command: "grep reef reef.txt" });
    const mainBefore = await git("rev-parse", "main");

    const first = await runTask(reef.implementation, [
      toolCallTurn("write_file", { path: "reef.txt", content: "reef\n" }),
      toolCallTurn("run_checks", {}),
      toolCallTurn("dispute_check", { name: "reefs", reason: "the check reads the wrong file" }),
    ]);

    expect(toolNames(first.mock)).toContain("dispute_check");
    expect(first.result.status, first.result.detail).toBe("disputed");
    if (first.result.status !== "disputed") return;
    expect(first.result).toMatchObject({
      checkTaskId: reef.check.id,
      revision: 1,
      check: { name: "reefs", command: "grep reef reef.txt" },
      reason: "the check reads the wrong file",
    });
    expect(first.result.evidence).toContain('Check "reefs"');
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("log", "-1", "--format=%s", `task/${reef.implementation.id}`)).toContain("partial work for retry");

    const second = await runTask({ ...reef.implementation, attempt: 2, dispatchCount: 1 }, [
      toolCallTurn("finish", { status: "done", summary: "reef.txt is already on the task branch." }),
    ]);

    expect(second.result.status, second.result.detail).toBe("completed");
    expect(second.events.find((e) => e.event === "branch_work_found")).toMatchObject({ paths: ["reef.txt"] });
    expect(second.events.find((e) => e.event === "post_merge_verify")).toMatchObject({
      verdict: "passed",
      details: expect.stringContaining('Check "reefs": PASSED'),
    });
    expect(await readFile(join(target, "reef.txt"), "utf8")).toBe("reef\n");
  }, 300_000);

  it("a re-dispatch whose branch holds no change against main and that edits nothing still fails as no changes", async () => {
    const empty = await checkedPair("Write empty.txt", { name: "empties", command: "grep empty empty.txt" });

    const { result } = await runTask(empty.implementation, [toolCallTurn("finish", { status: "done", summary: "Nothing to do." })]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("the task branch holds no change against main");
  }, 300_000);
});

// Quality's dispute record and the Liaison's block (migrations 039, 040): the count survives in the
// table, and a project is blocked with exactly one report, posted by the block reports from the record.
describe("check disputes on record", () => {
  it("counts each check task's disputes, and blocks the project with one report however often it is asked", async () => {
    const pair = await plannedPair("Write disputed.txt");
    const other = await plannedPair("Write undisputed.txt");
    const disputes = new CheckDisputeRepository(db);
    const dispute = { projectId, taskId: pair.implementation.id, checkTaskId: pair.check.id, revision: 1, checkName: "c", reason: "r", evidence: null };

    expect(await disputes.record(dispute)).toBe(1);
    expect(await disputes.record({ ...dispute, evidence: "the last run" })).toBe(2);
    expect(await disputes.record({ ...dispute, taskId: other.implementation.id, checkTaskId: other.check.id })).toBe(1);
    expect(await disputes.record(dispute)).toBe(3);

    const reports = new BlockReports(createBlockReportStore(db));
    const bound = { projectId, taskTitle: "Write disputed.txt", checkTaskId: pair.check.id, checkName: "c", reason: "r", disputes: 3, bound: 2 };
    expect(await reports.blockOnDisputes(bound)).toBe("blocked");
    expect(await reports.blockOnDisputes(bound)).toBe("already-blocked");
    // Other suites share the database: only this project's outcomes are this test's.
    const ours = async () => (await reports.runPending()).filter((o) => o.projectId === projectId);
    expect(await ours()).toEqual([{ kind: "posted", projectId, subject: "project-blocked" }]);
    expect(await ours()).toEqual([]);

    const project = await db.execute(
      sql`SELECT status, blocked_error_class AS "errorClass", blocked_category AS "category" FROM projects WHERE id = ${projectId}`,
    );
    expect(project.rows).toEqual([{ status: "blocked", errorClass: "CheckDisputeBoundReached", category: "check_dispute" }]);
    const posted = await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND kind = 'report'`);
    expect(posted.rows).toHaveLength(1);
    const body = JSON.stringify(posted.rows[0]);
    expect(body).toContain('While building \\"Write disputed.txt\\"');
    expect(body).toContain("after 3 attempts");
  });
});
