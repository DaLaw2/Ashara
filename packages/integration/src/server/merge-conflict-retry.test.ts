import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, EnvironmentBuildRepository, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { TaskCheckRepository } from "@ashara/quality";
import { DispatchService, FailureRouter, PlanningService, failWorkItem, recoverFailedItem, startWorkItem, adaptWorkItemRepo, WorkItemRowRepository } from "@ashara/delivery";
import type { TaskDescriptor } from "@ashara/delivery";
import { PodmanSubstrate, buildEnvironmentImage, execFileGitRunner, loadBaseCell, pruneEnvironmentImages, withGitRunner } from "@ashara/execution-infra";
import type { BaseCellReference, GitRunner } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, parseWorkItemId, systemClock } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { createTaskCheckStore } from "@ashara/server/task-check-store";
import { testCellInstance } from "../test-cells.js";

// w12b D2 (ADR-074 d96 d, d99): two tasks dispatched in one batch left the same main and changed the
// same file. The first merged; the second's merge conflicted, and its retry was dispatched on its
// branch unchanged, so it conflicted again by construction. Real podman, real git, the scratch
// database and the real failure router, with a scripted model: no real LLM call.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
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
  priceTiers: [],
};

function toolCallTurn(toolName: string, input: unknown): LanguageModelV4GenerateResult {
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

/** One model turn: a fixed reply, or one produced when the turn comes (after whatever it does first). */
type Turn = LanguageModelV4GenerateResult | (() => Promise<LanguageModelV4GenerateResult>);

type Db = ReturnType<typeof createDb>;
let db: Db;
let clientId = "";
let projectId: ProjectId;
let root = "";
let workdirBase = "";
let target = "";
let base: BaseCellReference;
let substrate: PodmanSubstrate;
let foundation = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: target });
  return stdout.trim();
}

function workItems() {
  return adaptWorkItemRepo(new WorkItemRowRepository(db));
}

/** An implementation task on record, InProgress as the dispatch seam leaves it, with one stored check of its own. */
async function checkedTask(title: string, check: { readonly name: string; readonly command: string }): Promise<TaskDescriptor> {
  const id = createWorkItemId();
  const checkTaskId = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, dispatch_count)
    VALUES (${id}, 'Task', 'InProgress', ${title}, ${projectId}, 'implementation', ${randomUUID()},
            ${JSON.stringify({ goal: title, capability: "Strong" })}::jsonb, 1),
           (${checkTaskId}, 'Task', 'Completed', ${`Write the checks for "${title}"`}, ${projectId}, 'check', ${randomUUID()},
            ${JSON.stringify({ goal: "checks", origin: "check", checksFor: id })}::jsonb, 1)`);
  await new TaskCheckRepository(db).append({
    projectId,
    taskId: id,
    checkTaskId,
    environmentVersion: "e".repeat(64),
    baselineCommit: foundation,
    checks: [check],
    files: [],
  });
  return { id, projectId, title, taskSpec: { goal: title, endState: `${title} is done`, scope: title, deliverables: [], capability: "Strong" }, epicId: null, dispatchCount: 1, attempt: 1, workKind: "implementation", successCriteria: [] };
}

interface TaskRun {
  readonly result: Awaited<ReturnType<DispatchService["execute"]>>;
  readonly mock: MockLanguageModelV4;
  readonly events: ReadonlyArray<Record<string, unknown> & { readonly event: string }>;
}

async function runTask(task: TaskDescriptor, script: Turn[], caps: typeof TEST_SPEND_CAPS = TEST_SPEND_CAPS): Promise<TaskRun> {
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
    new SpendCap({ ledger: new LlmCallRepository(db), caps }),
  ));
  const builds = new EnvironmentBuildRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const service = new DispatchService({
    config: { workdirBase },
    sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
    knowledgeSink: { storeFinding: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A shared notes file", assumptions: [] }) },
    cells: { substrate, baseCell: base, instance: testCellInstance() },
    llm: gateway,
    staffing: {
      staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: {
        build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }),
        prune: (pruned, keepVersion) => pruneEnvironmentImages(substrate, pruned, keepVersion),
      },
      statements: {
        record: async () => {
          throw new Error("no environment statement is recorded here");
        },
        forVersion: async () => "A plain Debian shell environment: the project is text files.",
      },
    },
    checks: createTaskCheckStore(db),
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
  });
  const result = await service.execute(task, target);
  const { stdout } = await run("podman", ["ps", "-a", "-q", "--filter", `label=ashara.task=${task.id}`]);
  expect(stdout.trim(), "every cell of the task is gone").toBe("");
  return { result, mock, events };
}

function promptAt(mock: MockLanguageModelV4, call: number): string {
  return JSON.stringify(mock.doGenerateCalls[call]?.prompt ?? null);
}

/** What the orchestrator does with a failed result: the item to Failed, then the failure router on the stored record. */
async function routeFailure(taskId: WorkItemId, result: TaskRun["result"]): Promise<string> {
  if (result.status !== "failed" && result.status !== "blocked") throw new Error(`a ${result.status} result is not routed as a failure`);
  const repo = workItems();
  const item = await PlanningService.findWorkItem(repo, taskId);
  if (item === null) throw new Error(`task ${taskId} not found`);
  failWorkItem(item, { source: "task_failed", reason: result.detail }, result.verdict);
  await PlanningService.saveWorkItem(repo, item, "InProgress");
  return recoverFailedItem(
    { workItemRepo: repo, eventPublisher: { publish: async () => {} }, failureRouter: new FailureRouter(3) },
    item,
    { detail: result.detail, raw: result.errorEnvelope === undefined ? {} : { ...result.errorEnvelope } },
    result.verdict,
  );
}

/** What the dispatch seam does before a retry: the item InProgress again, its dispatch counted. */
async function redispatch(task: TaskDescriptor): Promise<TaskDescriptor> {
  const repo = workItems();
  const item = await PlanningService.findWorkItem(repo, parseWorkItemId(task.id, "test"));
  if (item === null) throw new Error(`task ${task.id} not found`);
  const blockedReason = item.blockedReason;
  startWorkItem(item);
  await PlanningService.saveWorkItem(repo, item, "Pending");
  const attempt = await new WorkItemRowRepository(db).incrementDispatchCount(task.id);
  return { ...task, attempt, dispatchCount: attempt, ...(blockedReason === undefined ? {} : { blockedReason }) };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`merge-conflict-${randomUUID()}`)).id;
  projectId = (await new ProjectRepository(db).create(`merge-conflict-${randomUUID().slice(0, 8)}`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-merge-conflict-")));
  workdirBase = join(root, "work");
  target = join(workdirBase, "projects", "p");
  await mkdir(join(target, "environment"), { recursive: true });
  base = await loadBaseCell();
  await writeFile(
    join(target, "environment", "environment.toml"),
    'containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "echo toolchain ok"\nbuild = "true"\ntest = "echo environment ok"\n',
  );
  await writeFile(join(target, "environment", "Containerfile"), `FROM ${base.image}\n`);
  await run("git", ["init", "-q", "-b", "main"], { cwd: target });
  await git("add", "environment");
  await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment");
  foundation = await git("rev-parse", "main");
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, merge_commit)
    VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Set up the project environment', ${projectId},
            'environment', ${randomUUID()}, ${JSON.stringify({ goal: "Set up the project environment", origin: "sprint0", checkedBy: "substrate" })}::jsonb,
            ${foundation})`);
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
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
}, 120_000);

describe("a merge conflict between two tasks of one batch", () => {
  it("the second task's next attempt starts with main merged in and the conflict named; resolved, it merges", async () => {
    const first = await checkedTask("Write alpha into notes.txt", { name: "has alpha", command: "grep -x alpha notes.txt || exit 99" });
    const second = await checkedTask("Write beta into notes.txt", { name: "has beta", command: "grep -x beta notes.txt || exit 99" });

    // Both leave the same main. The first is merged while the second is still at work.
    const attempt1 = await runTask(second, [
      toolCallTurn("write_file", { path: "notes.txt", content: "beta\n" }),
      async () => {
        const merged = await runTask(first, [
          toolCallTurn("write_file", { path: "notes.txt", content: "alpha\n" }),
          toolCallTurn("finish", { status: "done", summary: "Wrote alpha." }),
        ]);
        expect(merged.result.status, merged.result.detail).toBe("completed");
        await db.execute(sql`UPDATE work_items SET status = 'Completed', merge_commit = ${await git("rev-parse", "main")} WHERE id = ${first.id}`);
        return toolCallTurn("finish", { status: "done", summary: "Wrote beta." });
      },
    ]);

    const conflicted = attempt1.result;
    expect(conflicted.status).toBe("failed");
    expect(conflicted.detail).toMatch(/^merge into main failed for /);
    expect(conflicted.detail).toContain("- notes.txt");
    if (conflicted.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(conflicted.errorEnvelope.chain.operation).toBe("tentativeMerge");
    if (conflicted.status !== "failed") throw new Error("expected a failed result");
    expect(conflicted.verdict).toEqual({ kind: "retryable", ground: "merge-conflict" });
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("alpha\n");
    expect(await routeFailure(second.id, conflicted)).toBe("replan");

    const retry = await redispatch(second);
    const mainBefore = await git("rev-parse", "main");
    const attempt2 = await runTask(retry, [
      toolCallTurn("read_file", { path: "notes.txt" }),
      toolCallTurn("write_file", { path: "notes.txt", content: "alpha\nbeta\n" }),
      toolCallTurn("finish", { status: "done", summary: "Kept alpha and beta." }),
    ]);

    expect(attempt2.result.status, attempt2.result.detail).toBe("completed");
    expect(promptAt(attempt2.mock, 0)).toContain("Merge with main in progress");
    expect(promptAt(attempt2.mock, 0)).toContain("- notes.txt");
    // The conflict is in the worktree the implementer reads, not only in its brief.
    expect(promptAt(attempt2.mock, 1)).toMatch(/<{7} [^"\\]*\\nbeta\\n={7}\\nalpha\\n>{7} /);
    expect(attempt2.events.find((e) => e.event === "merge_conflict_presented")).toMatchObject({ mainCommit: mainBefore, files: ["notes.txt"] });
    expect(attempt2.events.find((e) => e.event === "merge_conflict_resolution")).toMatchObject({ markersLeft: [] });
    // Both tasks' checks decided the merge: the first's as the regression suite.
    expect(attempt2.events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "passed" });
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(await git("rev-parse", "main~1")).toBe(mainBefore);
  }, 600_000);

  it("a conflict that cannot be prepared is never dispatched on the branch as it is: blocked as Ashara's fault", async () => {
    const third = await checkedTask("Write gamma into notes.txt", { name: "has gamma", command: "grep -x gamma notes.txt || exit 99" });
    // Its branch left main before the merges above, and changes the same file.
    await git("branch", `task/${third.id}`, foundation);
    const work = join(root, "third");
    await git("worktree", "add", "-q", work, `task/${third.id}`);
    await writeFile(join(work, "notes.txt"), "gamma\n");
    await run("git", ["add", "-A"], { cwd: work });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "gamma"], { cwd: work });
    await git("worktree", "remove", "--force", work);
    const branchBefore = await git("rev-parse", `task/${third.id}`);

    // Z0's git fails the one step that asks whether the branch conflicts with main.
    const failingMergeTree: GitRunner = {
      text: (invocation) =>
        invocation.args.includes("merge-tree")
          ? Promise.reject(Object.assign(new Error("git merge-tree: simulated failure"), { code: 128, stderr: "fatal: simulated\n", stdout: "" }))
          : execFileGitRunner.text(invocation),
      bytes: (invocation) => execFileGitRunner.bytes(invocation),
    };
    const { result, mock } = await withGitRunner(failingMergeTree, () => runTask({ ...third, attempt: 2, dispatchCount: 2 }, []));

    // Z0's git, never the task's work (ADR-080 d3 c): blocked under class ashara, not routed against
    // the task, and the branch is never dispatched as it is.
    expect(result.status).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.fault).toBe("ashara");
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(result.errorEnvelope.chain.operation).toBe("prepareConflictRetry");
    expect(result.detail).toContain("merge-tree: simulated failure");
    expect(await git("rev-parse", `task/${third.id}`)).toBe(branchBefore);
  }, 300_000);

  it("an attempt handed a conflict that ends without done says its merge is discarded, never that its work is kept", async () => {
    const fourth = await checkedTask("Write delta into notes.txt", { name: "has delta", command: "grep -x delta notes.txt || exit 99" });
    await git("branch", `task/${fourth.id}`, foundation);
    const work = join(root, "fourth");
    await git("worktree", "add", "-q", work, `task/${fourth.id}`);
    await writeFile(join(work, "notes.txt"), "delta\n");
    await run("git", ["add", "-A"], { cwd: work });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "delta"], { cwd: work });
    await git("worktree", "remove", "--force", work);
    const branchBefore = await git("rev-parse", `task/${fourth.id}`);

    // The project has spent more than this cap above: the first model call is refused before it is sent.
    const { result, events } = await runTask({ ...fourth, attempt: 2, dispatchCount: 2 }, [], { deploymentUsd: 1_000_000, perProjectUsd: 0.000001 });

    expect(events.find((e) => e.event === "merge_conflict_presented")).toMatchObject({ files: ["notes.txt"] });
    expect(result.status, result.detail).toBe("refused");
    expect(result.detail).toContain("the attempt's merge of main is discarded uncommitted");
    expect(result.detail).not.toContain("kept on the task branch");
    expect(await git("rev-parse", `task/${fourth.id}`)).toBe(branchBefore);
  }, 300_000);
});
