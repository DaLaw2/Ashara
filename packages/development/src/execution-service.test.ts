import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PodmanSubstrate } from "@ashara/execution-infra";
import type { ResolvedModel } from "@ashara/llm-gateway";
import type { AgentBrief } from "@ashara/shared";
import { createAgentBrief, createWorkItemId, parseProjectId, wrapError } from "@ashara/shared";
import type { Outcome } from "@ashara/workplace";
import { toAgentOutput } from "./cell-execution.js";
import type { ExecutionResult, SessionStore } from "./execution-service.js";
import { DevelopmentService, withSessionLifecycle } from "./execution-service.js";

// The dev_sessions phases the DB CHECK constraint allows; "Preparing" is the
// only non-terminal one, so anything still holding it after a dispatch is a leak.
const TERMINAL_PHASES = ["Completed", "Failed"] as const;

class RecordingSessionStore implements SessionStore {
  readonly phases = new Map<string, string>();
  readonly failures = new Map<string, unknown>();
  failOnWrite = false;

  async insert(sessionId: string): Promise<void> {
    this.phases.set(sessionId, "Preparing");
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
      projectFrame: { intent: "a thing", stack: ["Go"], source: "vision-derivation" },
      context: "end state: the thing exists",
      constraints: [],
      deliverables: [],
    },
    "test",
  );
}

function result(status: ExecutionResult["status"]): ExecutionResult {
  if (status === "environment_blocked") {
    return {
      status,
      unavailable: "task cell",
      detail: `${status} detail`,
      output: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "cell failed", chain: wrapError("development", "agentAttempt", "cell failed") },
      agentInvoked: true,
    };
  }
  return {
    status,
    detail: `${status} detail`,
    output: null,
    sessionId: "s",
    attempt: 1,
    agentInvoked: true,
  };
}

// E2E Run 39: six failure returns, none of which transitioned the session, left
// 6 rows in Preparing that listActive() reported as live agents. The fix is not
// six call sites — it is one seam every exit passes through.
describe("withSessionLifecycle — the session's terminal write cannot be skipped", () => {
  // EXHAUSTIVE over ExecutionResult["status"]: whatever a future seventh return
  // returns, it is one of these, so this is the proof that a new return site
  // cannot leak. Adding a member to the union without adding it here is a
  // compile error, not a silent gap.
  const ALL_STATUSES: ReadonlyArray<ExecutionResult["status"]> = ["completed", "failed", "blocked", "environment_blocked"];

  for (const status of ALL_STATUSES) {
    test(`a "${status}" return leaves the session in a terminal phase`, async () => {
      const store = new RecordingSessionStore();
      await withSessionLifecycle(store, "sess", "task", brief(), async () => result(status));

      const phase = store.phases.get("sess");
      expect(TERMINAL_PHASES).toContain(phase);
      expect(phase).toBe(status === "completed" ? "Completed" : "Failed");
    });
  }

  test("a THROWN body still terminalizes the session, and the throw propagates", async () => {
    const store = new RecordingSessionStore();

    await expect(
      withSessionLifecycle(store, "sess", "task", brief(), async () => {
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
    await withSessionLifecycle(store, "sess", "task", brief(), async () => result("blocked"));

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

    const outcome = await withSessionLifecycle(store, "sess", "task", brief(), async () =>
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
}

function serviceOn(substrate: PodmanSubstrate, workdirBase: string): { service: DevelopmentService; probe: Probe } {
  const probe: Probe = { sessions: new RecordingSessionStore(), staffed: 0, modelCalls: 0 };
  const service = new DevelopmentService({
    config: { workdirBase },
    sessionStore: probe.sessions,
    knowledgeSink: { storeFinding: async () => {}, storeInsight: async () => {} },
    intentSource: { loadIntent: async () => "build the thing" },
    stackDeriver: { deriveStack: async () => ["C"] },
    cells: {
      substrate,
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: "test-instance",
    },
    llm: {
      forCall: () => ({
        generateTurn: async () => {
          probe.modelCalls++;
          throw new Error("no model may be called");
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
    shutdownSignal: new AbortController().signal,
  });
  return { service, probe };
}

const someTask = () => ({
  id: createWorkItemId(),
  projectId: parseProjectId("22222222-2222-4222-8222-222222222222"),
  title: "t",
  dispatchCount: 0,
  successCriteria: [],
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
    expect(result.agentInvoked).toBe(false);
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
    expect(result.agentInvoked).toBe(false);
    expect(result.errorEnvelope?.chain.operation).toBe("resolveTargetWorkspace");
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(existsSync(workdirBase)).toBe(false);
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
