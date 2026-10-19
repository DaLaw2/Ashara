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
import { ClientRepository, createDb, EnvironmentBuildRepository, LlmCallRepository, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { DispatchService } from "@ashara/delivery";
import type { TaskCheckStore } from "@ashara/quality";
import type { SessionStore } from "@ashara/workplace";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell, pruneEnvironmentImages } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, recordingLogger, systemClock } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { testCellInstance } from "../test-cells.js";

// Real podman cells from the BaseCell image, the real recorded gateway writing llm_calls, a mock
// model: no real LLM call, and no skip (CI rejects skipped tests).

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = resolveTestDatabaseUrl(process.env);
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
  capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Strong",
  inputCostPer1M: 3,
  outputCostPer1M: 15,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: 0.3,
  cacheWriteCostPer1M: 3.75,
  priceWindows: [], priceTiers: [], datedPrices: [],
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
});

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
});

describe("a task runs on cells end to end", () => {
  it("runs the attempt and its stored checks on the merge in cells, one llm_calls row per turn, and leaves no cell", async () => {
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "p1");
    await mkdir(target, { recursive: true });
    const taskId = createWorkItemId();

    // /workspace exists only inside a cell: a check that passes on it ran in one. The check
    // author stored it before the task started.
    const check = "test -f /workspace/hello.txt && grep cell /workspace/hello.txt || exit 99";
    const checks: TaskCheckStore = {
      foundationOf: async () => {
        throw new Error("an implementation task resolves no foundation");
      },
      checkFilesOf: async () => [],
      completedOf: async () => ({ checked: [], unchecked: [] }),
      checkedTasksOf: async () => [],
      storedOfProject: async () => [],
      append: async () => {
        throw new Error("an implementation task appends no checks");
      },
      // Red-run on the commit the environment below makes: main as the task starts.
      latest: async () => ({
        checkTaskId: createWorkItemId(),
        revision: 1,
        environmentVersion: "e".repeat(64),
        baselineCommit: (await run("git", ["rev-parse", "main"], { cwd: target })).stdout.trim(),
        checks: [{ name: "hello", command: check, decides: ["S1"] }],
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

    const gateway = new GuardedModelAccess(buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          { name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true },
        ],
        defaultProvider: "anthropic",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }), new LlmCallLedger(
      new LlmCallRepository(db),
      new SpendCap({ ledger: new LlmCallRepository(db), caps: TEST_SPEND_CAPS }),
    ), recordingLogger());

    // The environment a merged Sprint 0 leaves on main: the BaseCell image, unchanged.
    const base = await loadBaseCell();
    await mkdir(join(target, "environment"));
    await writeFile(
      join(target, "environment", "environment.toml"),
      'containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "echo toolchain ok"\nbuild = "true"\ntest = "echo environment ok"\n',
    );
    await writeFile(join(target, "environment", "Containerfile"), `FROM ${base.image}\n`);
    await run("git", ["init", "-q", "-b", "main"], { cwd: target });
    await run("git", ["add", "environment"], { cwd: target });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment"], { cwd: target });

    const instance = testCellInstance();
    const substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot: workdirBase });
    const builds = new EnvironmentBuildRepository(db);
    const events: Array<Record<string, unknown> & { readonly event: string }> = [];
    const sessions = new MemorySessionStore();
    const service = new DispatchService({
      logger: recordingLogger(),
      config: { workdirBase },
      sessionStore: sessions,
      knowledgeSink: { storeFinding: async () => {} },
      eventSink: { emit: (event) => void events.push(event) },
      intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting file", assumptions: [] }) },
      cells: { substrate, baseCell: base, instance },
      llm: gateway,
      staffing: { widerModel: () => null, staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
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
      clock: systemClock,
    });

    try {
      const result = await service.execute(
        {
          id: taskId,
          projectId,
          title: "Write hello.txt",
          taskSpec: { goal: "Write hello.txt", endState: "hello.txt holds a greeting", scope: "hello.txt", deliverables: ["hello.txt"] },
          epicId: null,
          overflowedWindowTokens: null,
          dispatchCount: 0,
          attempt: 1,
          workKind: "implementation",
          successCriteria: [],
        },
        target,
      );

      expect(result.status, result.detail).toBe("completed");
      expect(result.outcome).toMatchObject({ kind: "finished", status: "done", turnsUsed: 3, cost: { measured: true } });
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
  });
});
