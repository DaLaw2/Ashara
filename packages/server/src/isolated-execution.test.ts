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
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, EnvironmentBuildRepository, LlmCallRepository, ProjectRepository } from "@ashara/db";
import { DevelopmentService } from "@ashara/development";
import type { SessionStore, TaskCheckStore } from "@ashara/development";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell, pruneEnvironmentImages } from "@ashara/execution-infra";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import { createWorkItemId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { cellInstanceFor, reconcileCellsAtStartup } from "./cells.js";

// Real podman cells from the BaseCell image, the real recorded gateway writing llm_calls, a mock
// model: no real LLM call, and no skip (CI rejects skipped tests).

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
// Caps far above anything a stubbed call can cost: these tests are about the calls, not the cap.
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const psSchema = z.array(z.object({ Id: z.string() }));

async function ps(filter: string): Promise<z.infer<typeof psSchema>> {
  const { stdout } = await run("podman", ["ps", "-a", "--filter", filter, "--format", "json"]);
  return psSchema.parse(JSON.parse(stdout));
}

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

class MemorySessionStore implements SessionStore {
  readonly phases = new Map<string, string>();
  async insert(sessionId: string): Promise<void> {
    this.phases.set(sessionId, "Preparing");
  }
  async complete(sessionId: string): Promise<void> {
    this.phases.set(sessionId, "Completed");
  }
  async fail(sessionId: string): Promise<void> {
    this.phases.set(sessionId, "Failed");
  }
}

type Db = ReturnType<typeof createDb>;
let db: Db;
let clientId = "";
let projectId: ProjectId;
let root = "";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`iso-exec-${randomUUID()}`)).id;
  projectId = (await new ProjectRepository(db).create(`iso-exec-${randomUUID().slice(0, 8)}`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-iso-exec-")));
}, 60_000);

afterAll(async () => {
  const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
  const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
  if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
}, 60_000);

describe("a task runs on cells end to end", () => {
  it("runs the attempt and its stored checks on the merge in cells, one llm_calls row per turn, and leaves no cell", async () => {
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "p1");
    await mkdir(target, { recursive: true });
    const taskId = createWorkItemId();

    // /workspace exists only inside a cell: a check that passes on it ran in one. The check
    // author stored it before the task started (s-independent-verify-m1).
    const check = "test -f /workspace/hello.txt && grep cell /workspace/hello.txt";
    const checks: TaskCheckStore = {
      checkFilesOf: async () => [],
      completedOf: async () => ({ checked: [], unchecked: [] }),
      checkedTasksOf: async () => [],
      storedOfProject: async () => [],
      append: async () => {
        throw new Error("an implementation task appends no checks");
      },
      latest: async () => ({
        checkTaskId: createWorkItemId(),
        revision: 1,
        environmentVersion: "e".repeat(64),
        checks: [{ name: "hello", command: check }],
        files: [],
      }),
    };
    const script = [
      toolCallTurn("write_file", { path: "hello.txt", content: "hello from the cell\n" }),
      toolCallTurn("run_command", { command: "cat hello.txt" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt and its check." }),
    ];
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
      recording: { kind: "recorded", recorder: new LlmCallLedger(
      new LlmCallRepository(db),
      new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
    ) },
      clock: () => new Date(),
    });

    // The environment a merged Sprint 0 leaves on main: the BaseCell image, unchanged.
    const base = await loadBaseCell();
    await mkdir(join(target, "environment"));
    await writeFile(
      join(target, "environment", "environment.toml"),
      'owned = ["environment/"]\ncontainerfile = "environment/Containerfile"\nbuild = "true"\ntest = "echo environment ok"\n',
    );
    await writeFile(join(target, "environment", "Containerfile"), `FROM ${base.image}\n`);
    await run("git", ["init", "-q", "-b", "main"], { cwd: target });
    await run("git", ["add", "environment"], { cwd: target });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment"], { cwd: target });

    const instance = `test-${randomUUID()}`;
    const substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
    const builds = new EnvironmentBuildRepository(db);
    const events: Array<Record<string, unknown> & { readonly event: string }> = [];
    const sessions = new MemorySessionStore();
    const service = new DevelopmentService({
      config: { workdirBase },
      sessionStore: sessions,
      knowledgeSink: { storeFinding: async () => {}, storeInsight: async () => {} },
      eventSink: { emit: (event) => void events.push(event) },
      intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting file", inferences: [] }) },
      cells: { substrate, baseCell: base, instance },
      llm: gateway,
      staffing: { staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
      attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
      environment: {
        images: {
          build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }),
          prune: (projectId, keepVersion) => pruneEnvironmentImages(substrate, projectId, keepVersion),
        },
        statements: {
          record: async () => {
            throw new Error("an implementation task records no environment statement");
          },
          forVersion: async () => "A plain Debian shell environment: the project is one text file.",
        },
      },
      checks,
      suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
      shutdownSignal: new AbortController().signal,
    });

    try {
      const result = await service.execute(
        { id: taskId, projectId, title: "Write hello.txt", dispatchCount: 0, attempt: 1, workKind: "implementation", successCriteria: [] },
        target,
      );

      expect(result.status, result.detail).toBe("completed");
      expect(result.output).toMatchObject({ status: "done", turn_count: 3, cost_measured: true, total_tokens: { input: 3000, output: 150 } });
      expect([...sessions.phases.values()]).toEqual(["Completed"]);

      // The files the agent wrote in its cell reached the worktree and were merged into main.
      expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello from the cell\n");

      // The stored check ran in a verifier cell on the merge and passed.
      expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "passed", details: expect.stringContaining('Check "hello": PASSED') });
      const created = events.filter((e) => e.event === "cell_created");
      expect(created).toHaveLength(1);
      // Its cells started from the environment version's image, built and recorded for it.
      const resolved = events.find((e) => e.event === "environment_resolved");
      expect(resolved).toMatchObject({ reused: false, imageId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
      expect(created[0]).toMatchObject({ image: resolved?.["imageId"] });
      const recordedBuilds = await db.execute(sql`SELECT status FROM environment_builds WHERE project_id = ${projectId}`);
      expect(recordedBuilds.rows).toEqual([{ status: "succeeded" }]);

      // Every cell of the task is gone.
      expect(await ps(`label=ashara.task=${taskId}`)).toHaveLength(0);

      // One llm_calls row per turn, charged to the task.
      const rows = await db.execute(
        sql`SELECT call_site AS "callSite", outcome FROM llm_calls WHERE project_id = ${projectId} AND task_id = ${taskId}`,
      );
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.every((row) => row["callSite"] === "agent-runner" && row["outcome"] === "ok")).toBe(true);
      expect(mock.doGenerateCalls).toHaveLength(3);

      // Records sit Z0-side under workdirBase/records/<task>/<session>/; nothing of Ashara's in the worktree.
      const sessionDirs = await readdir(join(workdirBase, "records", taskId));
      expect(sessionDirs).toHaveLength(1);
      const recordDir = join(workdirBase, "records", taskId, sessionDirs[0] ?? "");
      expect(existsSync(join(recordDir, "brief.json"))).toBe(true);
      const conversation = (await readFile(join(recordDir, "conversation.jsonl"), "utf8")).trim().split("\n");
      expect(conversation.filter((line) => line.includes('"kind":"turn"'))).toHaveLength(3);
      expect(existsSync(join(target, ".ashara"))).toBe(false);
    } finally {
      await substrate.teardownAll();
    }
  }, 180_000);
});

describe("reconcileCellsAtStartup", () => {
  it("removes a leaked labelled cell of this instance only", async () => {
    const workdirBase = join(root, "reconcile");
    const workspace = join(workdirBase, "ws");
    await mkdir(workspace, { recursive: true });
    const base = await loadBaseCell();
    const instance = cellInstanceFor(workdirBase);
    const other = cellInstanceFor(join(root, "another-deployment"));
    expect(instance).not.toBe(other);

    // A previous process of this deployment, and another deployment, each with a live cell.
    const previous = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
    const foreign = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
    const spec = { image: base.image, project: "proj-reconcile", task: `task-${randomUUID()}`, role: "developer", mount: { hostPath: workspace, shared: true } };
    const leaked = await previous.createCell({ ...spec, instance });
    const kept = await foreign.createCell({ ...spec, instance: other });
    try {
      const restarted = new PodmanSubstrate({ podmanPath: "podman", mountRoot: workdirBase });
      await reconcileCellsAtStartup(restarted, instance);
      expect(await ps(`id=${leaked.id}`)).toHaveLength(0);
      expect(await ps(`id=${kept.id}`)).toHaveLength(1);

      // An unreachable substrate does not stop the boot; tasks block at their own probe.
      const missing = new PodmanSubstrate({ podmanPath: join(root, "no-such-podman"), mountRoot: workdirBase });
      await expect(reconcileCellsAtStartup(missing, instance)).resolves.toBeUndefined();
    } finally {
      // `previous` stands for a dead process: its cell is removed by id, whatever reconciliation did.
      await run("podman", ["rm", "-f", "--ignore", leaked.id]);
      await foreign.teardownAll();
    }
  }, 120_000);
});
