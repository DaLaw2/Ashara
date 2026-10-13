import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { PodmanSubstrate, environmentVersion } from "@ashara/execution-infra";
import { PreCallRefusal } from "@ashara/llm-gateway";
import type { ResolvedModel, TurnResult } from "@ashara/llm-gateway";
import type { AgentBrief } from "@ashara/shared";
import { createAgentBrief, createWorkItemId, parseProjectId, wrapError } from "@ashara/shared";
import type { Outcome } from "@ashara/workplace";
import { toAgentOutput } from "./cell-execution.js";
import type { ExecutionResult, SessionStore } from "./execution-service.js";
import { DevelopmentService, withSessionLifecycle } from "./execution-service.js";
import { taskBranchName } from "./merge.js";
import type { TaskCheckStore, TaskChecks } from "./task-checks.js";
import { ensureTargetGitInit } from "./workspace.js";

// The dev_sessions phases the DB CHECK constraint allows; "Preparing" is the
// only non-terminal one, so anything still holding it after a dispatch is a leak.
const TERMINAL_PHASES = ["Completed", "Failed"] as const;

class RecordingSessionStore implements SessionStore {
  readonly phases = new Map<string, string>();
  readonly failures = new Map<string, unknown>();
  readonly environmentVersions = new Map<string, string | null>();
  failOnWrite = false;

  async insert(sessionId: string, _taskId: string, _brief: unknown, environmentVersion: string | null): Promise<void> {
    this.phases.set(sessionId, "Preparing");
    this.environmentVersions.set(sessionId, environmentVersion);
  }

  async complete(sessionId: string): Promise<void> {
    if (this.failOnWrite) throw new Error("db unreachable");
    this.phases.set(sessionId, "Completed");
  }

  async fail(sessionId: string, verificationResult: unknown): Promise<void> {
    if (this.failOnWrite) throw new Error("db unreachable");
    this.phases.set(sessionId, "Failed");
    this.failures.set(sessionId, verificationResult);
  }
}

function brief(): AgentBrief {
  return createAgentBrief(
    {
      taskId: "11111111-1111-4111-8111-111111111111",
      goal: "do the thing",
      intent: "a thing",
      projectEnvironment: { kind: "to-define" },
      context: "end state: the thing exists",
      deliverables: [],
    },
    "test",
  );
}

function result(status: ExecutionResult["status"]): ExecutionResult {
  if (status === "environment_undefined") {
    return {
      status,
      reason: "no environment",
      detail: `${status} detail`,
      output: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "no environment", chain: wrapError("development", "resolveCurrentEnvironment", "no environment") },
    };
  }
  if (status === "environment_blocked") {
    return {
      status,
      unavailable: "task cell",
      detail: `${status} detail`,
      output: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "cell failed", chain: wrapError("development", "agentAttempt", "cell failed") },
    };
  }
  if (status === "refused") {
    const refusal = new PreCallRefusal("budget_cap: refused");
    return {
      status,
      refusal,
      detail: `${status} detail`,
      output: toAgentOutput({ ...base, kind: "refused", error: refusal }, "m", { input: 0, output: 0 }),
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "refused", chain: wrapError("development", "agentAttempt", refusal) },
    };
  }
  return {
    status,
    detail: `${status} detail`,
    output: null,
    sessionId: "s",
    attempt: 1,
  };
}

const session = { sessionId: "sess", taskId: "task", brief: brief(), environmentVersion: null };

// E2E Run 39: six failure returns, none of which transitioned the session, left
// 6 rows in Preparing that listActive() reported as live agents. The fix is not
// six call sites — it is one seam every exit passes through.
describe("withSessionLifecycle — the session's terminal write cannot be skipped", () => {
  // EXHAUSTIVE over ExecutionResult["status"]: whatever a future seventh return
  // returns, it is one of these, so this is the proof that a new return site
  // cannot leak. Adding a member to the union without adding it here is a
  // compile error, not a silent gap.
  const ALL_STATUSES: ReadonlyArray<ExecutionResult["status"]> = ["completed", "failed", "blocked", "environment_blocked", "environment_undefined", "refused"];

  for (const status of ALL_STATUSES) {
    test(`a "${status}" return leaves the session in a terminal phase`, async () => {
      const store = new RecordingSessionStore();
      await withSessionLifecycle(store, session, async () => result(status));

      const phase = store.phases.get("sess");
      expect(TERMINAL_PHASES).toContain(phase);
      expect(phase).toBe(status === "completed" ? "Completed" : "Failed");
    });
  }

  test("a THROWN body still terminalizes the session, and the throw propagates", async () => {
    const store = new RecordingSessionStore();

    await expect(
      withSessionLifecycle(store, session, async () => {
        throw new Error("the attempt threw before an outcome");
      }),
    ).rejects.toThrow("the attempt threw before an outcome");

    expect(store.phases.get("sess")).toBe("Failed");
    expect(store.failures.get("sess")).toMatchObject({
      passed: false,
      outcome: "errored",
      detail: "the attempt threw before an outcome",
    });
  });

  test("the failure payload carries the outcome and detail, not just a phase", async () => {
    const store = new RecordingSessionStore();
    await withSessionLifecycle(store, session, async () => result("blocked"));

    expect(store.failures.get("sess")).toMatchObject({
      passed: false,
      outcome: "blocked",
      detail: "blocked detail",
    });
  });

  // Fail-SOFT on the write itself: a DB error must not un-complete a task that
  // already passed its gates. The row is then stranded on purpose, and the
  // startup reconciler is what resolves it.
  test("a failing terminal write does not swallow or alter the execution outcome", async () => {
    const store = new RecordingSessionStore();
    store.failOnWrite = true;

    const outcome = await withSessionLifecycle(store, session, async () =>
      result("completed"),
    );

    expect(outcome.status).toBe("completed");
    expect(store.phases.get("sess")).toBe("Preparing");
  });
});

// Never invoked by these tests: a dispatch that blocks or fails before the attempt touches no model.
const unusedModel: ResolvedModel = {
  model: "unused",
  modelId: "unused-model",
  provider: "none",
  modelConfig: {
    id: "unused-model",
    apiModelId: "unused-model",
    provider: "none",
    capabilityLevel: "Strong",
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    maxContextTokens: 1,
    priceWindows: [],
  },
  effectiveCapability: "Strong",
};

interface Probe {
  readonly sessions: RecordingSessionStore;
  staffed: number;
  modelCalls: number;
  builds: number;
  /** Failure lessons written through the knowledge sink. */
  findings: number;
}

/** The checks a check author stored for the task: one that reads the greeting file the agent writes. */
const STORED_CHECKS: TaskChecks = {
  checkTaskId: "33333333-3333-4333-8333-333333333333",
  revision: 1,
  environmentVersion: "e".repeat(64),
  checks: [{ name: "greets", command: "cat greet.txt" }],
  files: [],
};

function checkStore(stored: TaskChecks | null, checkedTasks: readonly string[] = []): TaskCheckStore {
  return {
    checkedTasksOf: async () => checkedTasks,
    append: async () => {
      throw new Error("no checks may be appended");
    },
    latest: async () => stored,
  };
}

function serviceOn(
  substrate: PodmanSubstrate,
  workdirBase: string,
  turns?: (probe: Probe) => TurnResult,
  checks: TaskCheckStore = checkStore(STORED_CHECKS),
): { service: DevelopmentService; probe: Probe; events: Array<Record<string, unknown>> } {
  const probe: Probe = { sessions: new RecordingSessionStore(), staffed: 0, modelCalls: 0, builds: 0, findings: 0 };
  const events: Array<Record<string, unknown>> = [];
  const service = new DevelopmentService({
    config: { workdirBase },
    sessionStore: probe.sessions,
    knowledgeSink: { storeFinding: async () => void probe.findings++, storeInsight: async () => {} },
    intentSource: { loadIntent: async () => "build the thing" },
    cells: {
      substrate,
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: "test-instance",
    },
    eventSink: { emit: (event) => void events.push(event) },
    llm: {
      forCall: () => ({
        generateTurn: async () => {
          probe.modelCalls++;
          if (turns === undefined) throw new Error("no model may be called");
          return turns(probe);
        },
      }),
    },
    staffing: {
      staff: () => {
        probe.staffed++;
        return { role: "developer", model: unusedModel };
      },
    },
    attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
    environment: {
      // Stands for the recorded builder: the version it reports is the one the real code computes
      // at that commit, and the image is "already built".
      images: {
        build: async (request) => {
          probe.builds++;
          const { version, commit } = await environmentVersion(request.repoGitDir, request.commit, request.definition);
          return {
            projectId: request.projectId,
            version,
            commit,
            imageRef: `localhost/ashara-env-${request.projectId}:${version.slice(0, 16)}`,
            network: "private",
            imageId: ENV_IMAGE_ID,
            reused: true,
          };
        },
      },
      statements: {
        record: async () => {
          throw new Error("no environment statement may be recorded");
        },
        current: async () => STATEMENT,
      },
    },
    checks,
    shutdownSignal: new AbortController().signal,
  });
  return { service, probe, events };
}

const ENV_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const STATEMENT = "A POSIX shell environment: the project is a greeting file.";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, { cwd });
  return stdout.trim();
}

/** Commits a minimal environment definition to the target's main, as a merged Sprint 0 leaves it. */
async function commitEnvironment(target: string): Promise<void> {
  await mkdir(join(target, "environment"));
  await writeFile(
    join(target, "environment", "environment.toml"),
    'owned = ["environment/"]\ncontainerfile = "environment/Containerfile"\nbuild = "true"\ntest = "true"\n',
  );
  await writeFile(join(target, "environment", "Containerfile"), "FROM scratch\n");
  await git(target, "add", "environment");
  await git(target, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment");
}

const someTask = () => ({
  id: createWorkItemId(),
  projectId: parseProjectId("22222222-2222-4222-8222-222222222222"),
  title: "t",
  dispatchCount: 0,
  successCriteria: [],
  workKind: "implementation" as const,
});

describe("a dispatch that cannot run in a cell ends before anything runs", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  // The real PodmanSubstrate, pointed at a binary that does not exist: the observation C2 asks
  // for, without uninstalling podman.
  test("a missing podman binary: environment_blocked at the probe; no model, no session, no worktree, no records", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-envblk-")));
    scratch.push(root);
    const target = join(root, "target");
    const workdirBase = join(root, "work");
    await mkdir(target);
    const missing = join(root, "no-such-podman");
    const { service, probe } = serviceOn(new PodmanSubstrate({ podmanPath: missing, mountRoot: root }), workdirBase);

    const result = await service.execute(someTask(), target);

    expect(result.status).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.unavailable).toBe(`container substrate (${missing})`);
    expect(result.detail).toContain("no agent ran");
    expect(result.detail).toContain(missing);
    expect(result.errorEnvelope.chain.operation).toBe("probeSubstrate");
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(probe.sessions.phases.size).toBe(0);
    // Blocked before the worktree: the target and the workdir base are untouched.
    expect(existsSync(join(target, ".git"))).toBe(false);
    expect(existsSync(workdirBase)).toBe(false);
    expect(await readdir(root)).toEqual(["target"]);
  });

  // Without a target checkout there is no git dir Z0 owns, so nothing it could run git against.
  test("no target workspace: failed before the agent, with no workdir", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-notarget-")));
    scratch.push(root);
    const workdirBase = join(root, "work");
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutTruncated: false, stderr: "", stderrTruncated: false, killedByHost: false, stdinError: null };
      },
    });
    const { service, probe } = serviceOn(substrate, workdirBase);

    const result = await service.execute(someTask(), null);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorEnvelope?.chain.operation).toBe("resolveTargetWorkspace");
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(existsSync(workdirBase)).toBe(false);
  });

  // s-platform-role-m1 C2: a task after Sprint 0 never falls back to the BaseCell.
  test("no environment on main: environment_undefined; no build, no cell, no model, no session, no worktree", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-noenv-")));
    scratch.push(root);
    const target = join(root, "target");
    const workdirBase = join(root, "work");
    await mkdir(target);
    await ensureTargetGitInit(target);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutTruncated: false, stderr: "", stderrTruncated: false, killedByHost: false, stdinError: null };
      },
    });
    const { service, probe, events } = serviceOn(substrate, workdirBase);

    const result = await service.execute(someTask(), target);

    expect(result.status).toBe("environment_undefined");
    if (result.status !== "environment_undefined") return;
    expect(result.reason).toContain("no environment is defined on main");
    expect(result.reason).toContain("environment/environment.toml");
    expect(result.errorEnvelope.chain.operation).toBe("resolveCurrentEnvironment");
    expect(events.filter((e) => e.event === "task_blocked")).toEqual([expect.objectContaining({ stage: "resolveCurrentEnvironment" })]);
    expect(probe.builds).toBe(0);
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(probe.sessions.phases.size).toBe(0);
    expect(existsSync(workdirBase)).toBe(false);
    vi.restoreAllMocks();
  });
});

// s-independent-verify-m1: no task is verified from nothing, and a check task decides exactly one task.
describe("a task nothing could decide ends before the agent", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function dispatchWith(checks: TaskCheckStore, workKind: "implementation" | "check") {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-nochecks-")));
    scratch.push(root);
    const target = join(root, "target");
    await mkdir(target);
    await ensureTargetGitInit(target);
    await commitEnvironment(target);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutTruncated: false, stderr: "", stderrTruncated: false, killedByHost: false, stdinError: null };
      },
    });
    const workdirBase = join(root, "work");
    const { service, probe } = serviceOn(substrate, workdirBase, undefined, checks);
    const result = await service.execute({ ...someTask(), workKind }, target);
    return { result, probe, workdirBase };
  }

  test("an implementation task with no stored checks: failed; no model, no session, no worktree", async () => {
    const { result, probe, workdirBase } = await dispatchWith(checkStore(null), "implementation");

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("loadTaskChecks");
    expect(result.detail).toContain("no checks are stored for task");
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(probe.sessions.phases.size).toBe(0);
    expect(existsSync(workdirBase)).toBe(false);
  });

  test.each([[[]], [["a", "b"]]])("a check task that decides %j tasks: failed before the agent", async (checked) => {
    const { result, probe } = await dispatchWith(checkStore(null, checked), "check");

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("resolveCheckedTask");
    expect(result.detail).toContain("must decide exactly one implementation task");
    expect(probe.modelCalls).toBe(0);
  });
});

// The isolated-worker run's finding 1: a verifier cell refused by the substrate was routed as a
// tree regression and the task Abandoned. Every stage that runs on the substrate is failed here in
// turn, with the real PodmanSubstrate over a fake process runner and a real git target.
describe("a substrate failure at any stage blocks the task on the environment", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  type Role = "developer" | "verifier";

  interface Faults {
    /** Where the substrate's mount root sits, relative to the scratch root. */
    readonly mountRoot?: string;
    readonly startFails?: Role;
    readonly execFails?: Role;
    readonly teardownFails?: boolean;
    /** The model's single turn: run a command (an exec in the developer cell), or write and finish. */
    readonly agentRunsCommand?: boolean;
    /** The recorder refuses the second turn's call before it is sent, after the first wrote greet.txt. */
    readonly refusesSecondTurn?: PreCallRefusal;
  }

  const ok = (stdout = "", exitCode = 0, stderr = "") => ({
    exitCode, signal: null, stdout, stdoutTruncated: false, stderr, stderrTruncated: false, killedByHost: false, stdinError: null,
  });
  const ids: Record<Role, string> = { developer: "a".repeat(64), verifier: "b".repeat(64) };
  const roleOf = (id: string | undefined): Role | undefined => (id === ids.developer ? "developer" : id === ids.verifier ? "verifier" : undefined);

  function turn(name: string, input: unknown): TurnResult {
    return {
      assistant: { role: "assistant", content: [{ type: "tool-call", toolCallId: `tc-${name}`, toolName: name, input }] },
      text: "",
      toolCalls: [{ kind: "valid", toolCallId: `tc-${name}`, toolName: name, input }],
      finishReason: "tool_calls",
      rawFinishReason: null,
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: { measured: true, inputCost: 0.001, outputCost: 0.001, cacheSavings: 0, totalCost: 0.002 },
      provider: "fake",
      model: "fake-model",
    };
  }

  async function dispatch(faults: Faults) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(args.map(String).join(" ")));
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-stage-")));
    scratch.push(root);
    const mountRoot = join(root, faults.mountRoot ?? ".");
    await mkdir(mountRoot, { recursive: true });
    const target = join(root, "target");
    await mkdir(target);
    await ensureTargetGitInit(target);
    await commitEnvironment(target);
    const mainBefore = await git(target, "rev-parse", "main");
    const workdirBase = join(root, "cells", "work");
    const started: Array<{ readonly role: Role; readonly image: string | undefined }> = [];

    const substrate = new PodmanSubstrate({
      podmanPath: "podman",
      mountRoot,
      runner: async ({ args }) => {
        switch (args[0]) {
          case "info":
            return ok(JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } }));
          case "run": {
            const role: Role = args.includes("ashara.role=verifier") ? "verifier" : "developer";
            started.push({ role, image: args.find((arg) => arg.startsWith("sha256:") || arg.includes("@sha256:")) });
            return faults.startFails === role ? ok("", 125, "Error: OCI runtime error") : ok(`${ids[role]}\n`);
          }
          case "exec":
            return faults.execFails !== undefined && faults.execFails === roleOf(args[4]) ? ok("", 125, "Error: OCI runtime error") : ok("hello\n");
          case "rm":
            return faults.teardownFails === true ? ok("", 1, "Error: container is busy") : ok();
          default:
            throw new Error(`unexpected podman ${args.join(" ")}`);
        }
      },
    });
    const task = someTask();
    const workDir = join(workdirBase, taskBranchName(task.id).replace(/\//g, "-"));
    const { service, events, probe } = serviceOn(substrate, workdirBase, (probe) => {
      if (faults.refusesSecondTurn !== undefined) {
        if (probe.modelCalls === 2) throw faults.refusesSecondTurn;
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        return turn("run_command", { command: "true" });
      }
      if (faults.agentRunsCommand === true && probe.modelCalls === 1) return turn("run_command", { command: "true" });
      if (probe.modelCalls === 1) writeFileSync(join(workDir, "greet.txt"), "hello\n");
      return turn("finish", { status: "done", summary: "wrote greet.txt" });
    });

    const result = await service.execute(task, target);
    const branches = await git(target, "branch", "--list", taskBranchName(task.id));
    return {
      result, events, warns, target, started, probe, workdirBase, taskId: task.id,
      mainBefore, mainAfter: await git(target, "rev-parse", "main"), branchKept: branches !== "",
    };
  }

  test("an implementation task's cells start from the environment image; the version is recorded with the attempt", async () => {
    const { result, started, probe, events, workdirBase, taskId } = await dispatch({});

    expect(result.status, result.detail).toBe("completed");
    expect(probe.builds).toBe(1);
    expect(started).toEqual([
      { role: "developer", image: ENV_IMAGE_ID },
      { role: "verifier", image: ENV_IMAGE_ID },
    ]);
    const resolved = events.find((e) => e.event === "environment_resolved");
    expect(resolved).toMatchObject({ imageId: ENV_IMAGE_ID, version: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const version = resolved?.["version"];
    expect([...probe.sessions.environmentVersions.values()]).toEqual([version]);

    const [sessionDir] = await readdir(join(workdirBase, "records", taskId));
    const conversation = await readFile(join(workdirBase, "records", taskId, sessionDir ?? "", "conversation.jsonl"), "utf8");
    const first: unknown = JSON.parse(conversation.split("\n")[0] ?? "null");
    expect(first).toMatchObject({ kind: "attempt_started", cellImage: { kind: "environment", version, imageId: ENV_IMAGE_ID } });
    const { system } = z.object({ system: z.string() }).parse(first);
    expect(system).toContain(STATEMENT);
    expect(system).toContain(`version ${String(version)}`);
  });

  test.each([
    { stage: "createCell", errorClass: "CellStartFailed", faults: { startFails: "developer" }, unavailable: "task cell", agentInvoked: false },
    { stage: "createCell", errorClass: "MountPathRejected", faults: { mountRoot: "elsewhere" }, unavailable: "task cell mount", agentInvoked: false },
    { stage: "agentAttempt", errorClass: "CellExecFailed", faults: { execFails: "developer", agentRunsCommand: true }, unavailable: "task cell", agentInvoked: true },
    { stage: "postMergeVerify", errorClass: "CellStartFailed", faults: { startFails: "verifier" }, unavailable: "verifier cell", agentInvoked: true },
    { stage: "postMergeVerify", errorClass: "CellExecFailed", faults: { execFails: "verifier" }, unavailable: "verifier cell", agentInvoked: true },
  ] satisfies ReadonlyArray<{ stage: string; errorClass: string; faults: Faults; unavailable: string; agentInvoked: boolean }>)(
    "$stage, $errorClass: environment_blocked naming the stage and the class; main untouched",
    async ({ stage, errorClass, faults, unavailable, agentInvoked }) => {
      const { result, events, target, mainBefore, mainAfter, branchKept } = await dispatch(faults);

      expect(result.status).toBe("environment_blocked");
      if (result.status !== "environment_blocked") return;
      expect(result.detail).toContain(`stage ${stage} (${errorClass})`);
      expect(result.unavailable).toContain(unavailable);
      expect(result.detail).toContain(agentInvoked ? "the agent's work is kept on the task branch" : "no agent ran");
      expect(result.errorEnvelope.outcome).toBe("blocked");
      expect(result.errorEnvelope.chain.operation).toBe(stage);
      expect(events.filter((e) => e.event === "task_blocked")).toEqual([expect.objectContaining({ stage, errorClass })]);
      expect(events.some((e) => e.event === "task_failed" || e.event === "gate_failed" || e.event === "task_completed")).toBe(false);
      // Nothing merged; the agent's work, where there was any, waits on its branch for the retry.
      expect(mainAfter).toBe(mainBefore);
      expect(await git(target, "status", "--porcelain")).toBe("");
      if (stage === "postMergeVerify") expect(branchKept).toBe(true);
    },
  );

  // Teardown never ends a stage: the cell is left to teardownAll and reconcileOrphans.
  test("a failed teardown of both cells: the task still completes, the failures logged and emitted", async () => {
    const { result, events, warns, mainBefore, mainAfter } = await dispatch({ teardownFails: true });

    expect(result.status).toBe("completed");
    expect(mainAfter).not.toBe(mainBefore);
    expect(events.filter((e) => e.event === "cell_teardown_failed")).toHaveLength(2);
    expect(warns.some((w) => w.includes("still on disk"))).toBe(false);
  });

  // The 509bbbc5 review: a refused turn was transport_exhausted, then "failed" for the FailureRouter.
  test("a turn refused before it was sent: refused carrying the refusal, never failed; no lesson; partial work kept", async () => {
    const refusal = new PreCallRefusal("budget_cap: the spend cap of project p is $1.000000");
    const { result, events, probe, mainBefore, mainAfter, branchKept } = await dispatch({ refusesSecondTurn: refusal });

    expect(result.status, result.detail).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toBe(refusal);
    expect(result.detail).toContain("turn 2");
    expect(result.output.status).toBe("blocked");
    expect(probe.modelCalls).toBe(2);
    expect(probe.findings).toBe(0);
    expect(events.filter((e) => e.event === "task_refused")).toEqual([expect.objectContaining({ errorClass: "PreCallRefusal" })]);
    expect(events.some((e) => e.event === "task_failed" || e.event === "task_blocked" || e.event === "task_completed")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(true);
  });
});

const base = {
  turnsUsed: 3,
  cost: { measured: true as const, totalUsd: 0.25, turns: 3 },
  lastToolCall: { turn: 3, toolName: "run_command", input: "{}" },
  detail: "why it ended",
};

type FailedKind = Exclude<Outcome["kind"], "finished">;

function terminal(kind: FailedKind): Outcome {
  switch (kind) {
    case "turn_cap":
      return { ...base, kind, maxTurns: 3 };
    case "wall_clock":
      return { ...base, kind, wallClockMs: 1000, elapsedMs: 1001 };
    case "model_stopped_without_finish":
      return { ...base, kind, finishReason: "stop", rawFinishReason: "end_turn", finalText: "bye" };
    case "transport_exhausted":
      return { ...base, kind, error: new Error("provider down") };
    case "cancelled":
      return { ...base, kind, reason: new Error("shutdown") };
    case "environment_failure":
      return { ...base, kind, source: "cell", error: new Error("podman exec failed") };
    case "refused":
      return { ...base, kind, error: new PreCallRefusal("budget_cap: refused") };
  }
}

// The M1 adapter: only finished(done) may read as done; every other terminal is named.
describe("toAgentOutput", () => {
  test("finished(done) is done with the measured cost and the recorded tokens", () => {
    const output = toAgentOutput({ ...base, kind: "finished", status: "done", summary: "did it", blockedReason: null }, "m", { input: 10, output: 5 });
    expect(output).toMatchObject({ status: "done", summary: "did it", total_cost: 0.25, cost_measured: true, total_tokens: { input: 10, output: 5 }, finish_reason: "completed", error_detail: null });
  });

  test("finished(blocked) is blocked and carries the reason", () => {
    const output = toAgentOutput({ ...base, kind: "finished", status: "blocked", summary: "stuck", blockedReason: "needs a key" }, "m", { input: 0, output: 0 });
    expect(output.status).toBe("blocked");
    expect(output.error_detail?.message).toBe("needs a key");
  });

  test.each(["turn_cap", "wall_clock", "model_stopped_without_finish", "transport_exhausted", "cancelled", "environment_failure"] as const)(
    "%s is failed, never done, and names the terminal",
    (kind) => {
      const output = toAgentOutput(terminal(kind), "m", { input: 0, output: 0 });
      expect(output.status).toBe("failed");
      expect(output.summary).toContain(kind);
      expect(output.error_detail).toMatchObject({ model: "m", turn_count: 3, last_tool_call: "run_command" });
    },
  );

  test("refused is blocked, never failed or done, and names the terminal", () => {
    const output = toAgentOutput(terminal("refused"), "m", { input: 0, output: 0 });
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("refused");
  });

  test("an unmeasured attempt reports only the lower bound and says so", () => {
    const output = toAgentOutput(
      {
        ...base,
        kind: "finished",
        status: "done",
        summary: "did it",
        blockedReason: null,
        cost: { measured: false, measuredUsd: 0.1, unmeasuredTurns: [{ turn: 2, reason: "no usage" }] },
      },
      "m",
      { input: 0, output: 0 },
    );
    expect(output).toMatchObject({ total_cost: 0.1, cost_measured: false });
  });
});
