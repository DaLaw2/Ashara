import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { EnvironmentBuildFailed, PodmanSubstrate, ensureTargetGitInit, environmentVersion } from "@ashara/execution-infra";
import { ContextBudgetExceeded, PreCallRefusal } from "@ashara/finance";
import type { CostedTurnResult } from "@ashara/finance";
import type { AgentBrief } from "@ashara/workplace";
import { createWorkItemId, parseProjectId, wrapError, systemClock } from "@ashara/shared";
import { createAgentBrief } from "@ashara/workplace";
import { checkBranchName, taskBranchName } from "@ashara/quality";
import type { ExecutionResult, TaskCheckStore, TaskChecks } from "@ashara/quality";
import { CHECK_MISSING_EXIT, attemptSummary, withSessionLifecycle } from "@ashara/workplace";
import type { AssignmentStaff, SessionStore } from "@ashara/workplace";
import { DispatchService } from "./dispatch-service.js";
import type { TaskDescriptor } from "./dispatch-service.js";

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

  readonly attempts = new Map<string, Parameters<SessionStore["complete"]>[1]>();

  async complete(sessionId: string, attempt: Parameters<SessionStore["complete"]>[1]): Promise<void> {
    if (this.failOnWrite) throw new Error("db unreachable");
    this.phases.set(sessionId, "Completed");
    this.attempts.set(sessionId, attempt);
  }

  async fail(sessionId: string, verificationResult: unknown, attempt: Parameters<SessionStore["fail"]>[2]): Promise<void> {
    if (this.failOnWrite) throw new Error("db unreachable");
    this.phases.set(sessionId, "Failed");
    this.failures.set(sessionId, verificationResult);
    this.attempts.set(sessionId, attempt);
  }
}

function brief(): AgentBrief {
  return createAgentBrief(
    {
      taskId: "11111111-1111-4111-8111-111111111111",
      goal: "do the thing",
      intent: "a thing",
      visionVersion: 1,
      assumptions: [],
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
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "no environment", chain: wrapError("development", "resolveCurrentEnvironment", "no environment") },
    };
  }
  if (status === "environment_blocked") {
    return {
      status,
      fault: "substrate",
      unavailable: "task cell",
      detail: `${status} detail`,
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "cell failed", chain: wrapError("development", "agentAttempt", "cell failed") },
    };
  }
  if (status === "checks_stale") {
    return {
      status,
      checkTaskId: "check-task",
      revision: 1,
      detail: `${status} detail`,
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "stale", chain: wrapError("development", "revalidateTaskChecks", "stale") },
    };
  }
  if (status === "environment_change_requested") {
    return {
      status,
      paths: ["environment/Containerfile"],
      need: "s",
      diff: "",
      detail: `${status} detail`,
      outcome: { ...base, kind: "finished", status: "done", summary: "s", blockedReason: null, statement: null },
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "environment change", chain: wrapError("development", "ownershipGate", "environment change") },
    };
  }
  if (status === "refused") {
    const refusal = new PreCallRefusal("budget_cap: refused");
    return {
      status,
      refusal,
      detail: `${status} detail`,
      outcome: { ...base, kind: "refused", error: refusal },
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "refused", chain: wrapError("development", "agentAttempt", refusal) },
    };
  }
  if (status === "disputed") {
    return {
      status,
      checksOf: "task",
      checkTaskId: "check-task",
      revision: 1,
      check: { name: "greets", command: "cat greet.txt" },
      reason: "the check cannot pass",
      evidence: null,
      detail: `${status} detail`,
      outcome: { ...base, kind: "disputed", checkName: "greets", ofTask: null, reason: "the check cannot pass", evidence: null },
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "disputed", chain: wrapError("development", "agentAttempt", "disputed") },
    };
  }
  if (status === "owner_unresolved") {
    return {
      status,
      ownerRoleId: null,
      rosterRevision: 1,
      reason: "the work item has no owner role",
      detail: `${status} detail`,
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "no owner", chain: wrapError("development", "assignAgent", "no owner") },
    };
  }
  if (status === "suite_review_problems") {
    return {
      status,
      problems: [{ checkTaskIds: ["check-task"], kind: "contradiction", problem: "p", evidence: "e" }],
      detail: `${status} detail`,
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "review", chain: wrapError("development", "reviewSuites", "review") },
    };
  }
  if (status === "completed") {
    return {
      status,
      delivered: { kind: "merged", mergeCommit: "0123456789abcdef0123456789abcdef01234567" },
      detail: `${status} detail`,
      outcome: { ...base, kind: "finished", status: "done", summary: "s", blockedReason: null, statement: null },
      sessionId: "s",
      attempt: 1,
    };
  }
  if (status === "context_exceeded") {
    const error = new ContextBudgetExceeded({ provider: "p", model: "m", windowTokens: 32_000, outputReserveTokens: 16_384, breach: { source: "provider", providerMessage: "too long" } });
    return {
      status,
      model: { provider: "p", modelId: "m" },
      windowTokens: 32_000,
      outputReserveTokens: 16_384,
      projectedInputTokens: null,
      providerMessage: "too long",
      wider: null,
      detail: `${status} detail`,
      outcome: { ...base, kind: "context_budget_exceeded", turn: 1, source: "provider", error },
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "context", chain: wrapError("development", "agentAttempt", error) },
    };
  }
  if (status === "no_wider_model") {
    return {
      status,
      overflowedWindowTokens: 32_000,
      detail: `${status} detail`,
      outcome: null,
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "no wider model", chain: wrapError("development", "assignAgent", "no wider model") },
    };
  }
  if (status === "interrupted") {
    return {
      status,
      detail: `${status} detail`,
      outcome: { ...base, kind: "cancelled", reason: "shutdown" },
      sessionId: "s",
      attempt: 1,
      errorEnvelope: { outcome: "blocked", summary: "interrupted", chain: wrapError("development", "agentAttempt", "shutdown") },
    };
  }
  return {
    status,
    verdict: { kind: "retryable", ground: "work" },
    detail: `${status} detail`,
    outcome: null,
    sessionId: "s",
    attempt: 1,
  };
}

const session = { sessionId: "sess", taskId: "task", brief: brief(), environmentVersion: null };

// Every exit of a dispatch passes through one seam that writes the
// session's terminal status, so no failure return leaves a row in Preparing that
// listActive() reports as a live agent.
describe("withSessionLifecycle — the session's terminal write cannot be skipped", () => {
  // EXHAUSTIVE over ExecutionResult["status"]: whatever a future seventh return
  // returns, it is one of these, so this is the proof that a new return site
  // cannot leak. Adding a member to the union without adding it here is a
  // compile error, not a silent gap.
  const ALL_STATUSES: ReadonlyArray<ExecutionResult["status"]> = ["completed", "failed", "blocked", "environment_blocked", "environment_undefined", "refused", "checks_stale", "environment_change_requested", "interrupted", "context_exceeded"];

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
      outcome: "errored",
      detail: "Error: the attempt threw before an outcome",
    });
  });

  test("the attempt body ran is written with the terminal phase, a throw included; none when it ran none", async () => {
    const attempt = { promptDigest: "a".repeat(64), terminal: "turn_cap" as const, turns: 4, provider: "p", model: "m", cell: "base-cell" as const };
    const thrown = new RecordingSessionStore();
    await expect(
      withSessionLifecycle(thrown, session, async (slot) => {
        slot.attempt = attempt;
        throw new Error("after the attempt");
      }),
    ).rejects.toThrow("after the attempt");
    expect(thrown.attempts.get("sess")).toEqual(attempt);

    const completed = new RecordingSessionStore();
    await withSessionLifecycle(completed, session, async (slot) => {
      slot.attempt = { ...attempt, terminal: "finished:done" };
      return result("completed");
    });
    expect(completed.attempts.get("sess")).toMatchObject({ terminal: "finished:done" });

    const none = new RecordingSessionStore();
    await withSessionLifecycle(none, session, async () => result("checks_stale"));
    expect(none.attempts.get("sess")).toBeNull();
  });

  test("the failure payload carries the outcome and detail, not just a phase", async () => {
    const store = new RecordingSessionStore();
    await withSessionLifecycle(store, session, async () => result("blocked"));

    expect(store.failures.get("sess")).toMatchObject({
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
const unusedModel: AssignmentStaff["model"] = {
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
    priceWindows: [], priceTiers: [],
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
  /** The environment version the last build reported. */
  version: string | null;
  /** Statements recorded through the store, with the version each holds for. */
  readonly recorded: Array<{ readonly taskId: string; readonly statement: string; readonly version: string }>;
  /** Every build after the first fails as the builder reports a failed image build. */
  rebuildFails: boolean;
  /** Every model request, as sent. */
  readonly requests: unknown[];
  /** The version each environment image prune was asked to keep. */
  readonly prunes: string[];
  /** Every window a model larger than which was asked of staffing. */
  readonly widerAsked: number[];
}

/** The roster role the test's tasks are owned by: a UUID id, as roster_roles stores it, and a name. */
const OWNER_ROLE = { id: "44444444-4444-4444-8444-444444444444", name: "Greeting Developer" };

/** The project's current vision as the intent source returns it: text and keyed assumptions, as Delivery rendered them. */
const VISION = {
  version: 2,
  visionText: "build the thing",
  assumptions: [
    { key: "A1", statement: "Greetings are written in lower case.", note: "Inferred; reported to the client; client-visible behaviour" },
    { key: "A2", statement: "The greeting file is plain text, one line.", note: "Stated by the client; client-visible behaviour" },
  ],
};

/** The checks a check author stored for the task: one that reads the greeting file the agent writes. */
const STORED_CHECKS: TaskChecks = {
  checkTaskId: "33333333-3333-4333-8333-333333333333",
  revision: 1,
  environmentVersion: "e".repeat(64),
  baselineCommit: "b".repeat(40),
  checks: [{ name: "greets", command: "cat greet.txt", decides: ["S1"] }],
  files: [],
};

function checkStore(stored: TaskChecks | null, checkedTasks: readonly string[] = [], checkFiles: Awaited<ReturnType<TaskCheckStore["checkFilesOf"]>> = []): TaskCheckStore {
  return {
    foundationOf: async () => ({ kind: "none", reason: "no foundation in this unit test" }),
    checkFilesOf: async () => checkFiles,
    completedOf: async () => ({ checked: [], unchecked: [] }),
    checkedTasksOf: async () => checkedTasks,
    storedOfProject: async () => [],
    append: async () => {
      throw new Error("no checks may be appended");
    },
    latest: async () => stored,
  };
}

function serviceOn(
  substrate: PodmanSubstrate,
  workdirBase: string,
  turns?: (probe: Probe) => CostedTurnResult,
  checks: TaskCheckStore | ((probe: Probe) => TaskCheckStore) = checkStore(STORED_CHECKS),
  shutdownSignal: AbortSignal = new AbortController().signal,
  staffing:
    | "owned"
    | { readonly kind: "owner-unresolved"; readonly ownerRoleId: string | null; readonly rosterRevision: number | null; readonly reason: string }
    | { readonly kind: "no-wider-model"; readonly overflowedWindowTokens: number } = "owned",
  wider: AssignmentStaff["model"] | null = null,
): { service: DispatchService; probe: Probe; events: Array<Record<string, unknown>> } {
  const probe: Probe = {
    sessions: new RecordingSessionStore(), staffed: 0, modelCalls: 0, builds: 0, findings: 0, version: null, requests: [], recorded: [], rebuildFails: false, prunes: [],
    widerAsked: [],
  };
  const events: Array<Record<string, unknown>> = [];
  const service = new DispatchService({
    config: { workdirBase },
    sessionStore: probe.sessions,
    knowledgeSink: { storeFinding: async () => void probe.findings++ },
    intentSource: { loadIntent: async () => VISION },
    cells: {
      substrate,
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: "test-instance",
    },
    eventSink: { emit: (event) => void events.push(event) },
    llm: {
      forCall: () => ({
        generateTurn: async (request) => {
          probe.modelCalls++;
          probe.requests.push(request);
          if (turns === undefined) throw new Error("no model may be called");
          return turns(probe);
        },
      }),
    },
    staffing: {
      widerModel: (_task, windowTokens) => {
        probe.widerAsked.push(windowTokens);
        return wider;
      },
      staff: async () => {
        probe.staffed++;
        return staffing === "owned" ? { kind: "staffed", staff: { role: OWNER_ROLE, model: unusedModel } } : staffing;
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
          if (probe.rebuildFails && probe.builds > 1) {
            throw new EnvironmentBuildFailed(request.projectId, version, 1, false, [{ kind: "kept", text: "step 2/2: missing package\n" }], "the image build exited 1");
          }
          probe.version = version;
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
        prune: async (_projectId, keepVersion) => {
          probe.prunes.push(keepVersion);
          return { removed: [], kept: [] };
        },
      },
      statements: {
        record: async (taskId, statement, version) => void probe.recorded.push({ taskId, statement, version }),
        forVersion: async () => STATEMENT,
      },
    },
    checks: typeof checks === "function" ? checks(probe) : checks,
    suiteReview: {
      review: async () => {
        throw new Error("no suite review may run in these dispatches");
      },
    },
    shutdownSignal,
    clock: systemClock,
  });
  return { service, probe, events };
}

const ENV_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const STATEMENT = "A POSIX shell environment: the project is a greeting file.";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, { cwd });
  return stdout.trim();
}

/**
 * Commits a minimal environment definition to the target's main, as a merged Sprint 0 leaves it;
 * with `inputs`, the definition names those product files as inputs the image build reads, and
 * main holds them (a merged product scaffold's manifests).
 */
async function commitEnvironment(target: string, inputs: Readonly<Record<string, string>> = {}): Promise<void> {
  await mkdir(join(target, "environment"));
  const named = Object.keys(inputs).map((path) => JSON.stringify(path)).join(", ");
  await writeFile(
    join(target, "environment", "environment.toml"),
    `containerfile = "environment/Containerfile"\nrecipe = []\ninputs = [${named}]\nprobe = "echo ok"\nbuild = "true"\ntest = "true"\n`,
  );
  await writeFile(join(target, "environment", "Containerfile"), "FROM scratch\n");
  for (const [path, content] of Object.entries(inputs)) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content);
  }
  await git(target, "add", "environment", ...Object.keys(inputs));
  await git(target, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment");
}

/** The one vision item a check task of these tests cites. */
const CITED_SCOPE = { type: "scope" as const, id: "S1", text: "t works", side: "in" as const };

const someTask = () => ({
  id: createWorkItemId(),
  projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"),
  title: "t",
  dispatchCount: 0,
  attempt: 1,
  successCriteria: [],
  workKind: "implementation" as const,
  epicId: null,
  overflowedWindowTokens: null,
  taskSpec: { goal: "t", endState: "t is done", scope: "t", deliverables: [] as string[] },
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
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    const missing = join(root, "no-such-podman");
    const { service, probe } = serviceOn(new PodmanSubstrate({ trace: () => "test-trace", podmanPath: missing, mountRoot: root }), workdirBase);

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
    expect(await readdir(workdirBase)).toEqual(["projects"]);
    expect(await readdir(root)).toEqual(["work"]);
  });

  // s-platform-role-m1 C2: a task after Sprint 0 never falls back to the BaseCell.
  test("no environment on main: environment_undefined; no build, no cell, no model, no session, no worktree", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-noenv-")));
    scratch.push(root);
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    await ensureTargetGitInit(target, workdirBase);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({ trace: () => "test-trace", 
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null, statusReport: null };
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
    expect(await readdir(workdirBase)).toEqual(["projects"]);
    vi.restoreAllMocks();
  });

  // s-team-roster-m1: no default role stands in for a missing or unknown owner.
  test("no roster role owns the task: owner_unresolved; no worktree, no cell, no model, no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-noowner-")));
    scratch.push(root);
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    await ensureTargetGitInit(target, workdirBase);
    await commitEnvironment(target);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({ trace: () => "test-trace", 
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null, statusReport: null };
      },
    });
    const unresolved = { kind: "owner-unresolved", ownerRoleId: null, rosterRevision: 1, reason: "the work item has no owner role" } as const;
    const { service, probe, events } = serviceOn(substrate, workdirBase, undefined, checkStore(STORED_CHECKS), undefined, unresolved);

    const task = { ...someTask(), attempt: 3 };
    const result = await service.execute(task, target);

    expect(result.status).toBe("owner_unresolved");
    if (result.status !== "owner_unresolved") return;
    expect(result.ownerRoleId).toBeNull();
    expect(result.rosterRevision).toBe(1);
    expect(result.reason).toBe("the work item has no owner role");
    expect(result.attempt).toBe(3);
    expect(result.errorEnvelope.chain.operation).toBe("assignAgent");
    expect(events.filter((e) => e.event === "task_blocked")).toEqual([expect.objectContaining({ stage: "assignAgent", attempt: 3 })]);
    expect(probe.staffed).toBe(1);
    expect(probe.modelCalls).toBe(0);
    expect(probe.sessions.phases.size).toBe(0);
    expect(await git(target, "branch", "--list", taskBranchName(task.id))).toBe("");
    vi.restoreAllMocks();
  });

  // t-overflow-edges: a catalog with no window larger than one the task overflowed is a typed result
  // the orchestrator gives the task up on, never a throw routed as Ashara's fault.
  test("no catalog model wider than the task's overflow: no_wider_model; no worktree, no cell, no model, no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-nowider-")));
    scratch.push(root);
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    await ensureTargetGitInit(target, workdirBase);
    await commitEnvironment(target);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({ trace: () => "test-trace",
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null, statusReport: null };
      },
    });
    const unfit = { kind: "no-wider-model", overflowedWindowTokens: 32_000 } as const;
    const { service, probe, events } = serviceOn(substrate, workdirBase, undefined, checkStore(STORED_CHECKS), undefined, unfit);

    const task = { ...someTask(), attempt: 2, overflowedWindowTokens: 32_000 };
    const result = await service.execute(task, target);

    expect(result.status).toBe("no_wider_model");
    if (result.status !== "no_wider_model") return;
    expect(result.overflowedWindowTokens).toBe(32_000);
    expect(result.detail).toMatch(/overflowed a context window of 32000 tokens, and no catalog model graded for it has a larger one/);
    expect(result.errorEnvelope.chain.operation).toBe("assignAgent");
    expect(events.filter((e) => e.event === "task_blocked")).toEqual([expect.objectContaining({ stage: "assignAgent", attempt: 2 })]);
    expect(probe.modelCalls).toBe(0);
    expect(probe.sessions.phases.size).toBe(0);
    expect(await git(target, "branch", "--list", taskBranchName(task.id))).toBe("");
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

  async function dispatchWith(checks: TaskCheckStore, workKind: "implementation" | "check" | "environment", taskSpec: TaskDescriptor["taskSpec"] = someTask().taskSpec) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-nochecks-")));
    scratch.push(root);
    const workdirBase = join(root, "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    await ensureTargetGitInit(target, workdirBase);
    await commitEnvironment(target);
    const info = JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } });
    const substrate = new PodmanSubstrate({ trace: () => "test-trace", 
      podmanPath: "podman",
      mountRoot: root,
      runner: async (request) => {
        if (request.args[0] !== "info") throw new Error(`no cell may be created: podman ${request.args.join(" ")}`);
        return { exitCode: 0, signal: null, stdout: info, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null, statusReport: null };
      },
    });
    const { service, probe } = serviceOn(substrate, workdirBase, undefined, checks);
    const result = await service.execute({ ...someTask(), workKind, taskSpec }, target);
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
    expect(await readdir(workdirBase)).toEqual(["projects"]);
  });

  test("a task whose stored spec has no end state: failed before its brief, never given an invented one", async () => {
    const { endState: _dropped, ...withoutEndState } = someTask().taskSpec;
    const { result, probe, workdirBase } = await dispatchWith(checkStore(STORED_CHECKS), "implementation", withoutEndState);

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("readTaskSpec");
    expect(result.detail).toContain("has no endState");
    expect(probe.staffed).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(await readdir(workdirBase)).toEqual(["projects"]);
  });

  // ADR-080 d3 c (development #1): a store that throws is Ashara's own fault, never the task's work.
  test("a check store that throws: blocked under class ashara, never failed; no lesson, no model, no worktree", async () => {
    const throwing: TaskCheckStore = {
      ...checkStore(null),
      latest: async () => {
        throw new Error("task_checks read: connection terminated");
      },
    };
    const { result, probe, workdirBase } = await dispatchWith(throwing, "implementation");

    expect(result.status).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.fault).toBe("ashara");
    expect(result.unavailable).toBe("Ashara's own machinery (read the checks that decide the work)");
    expect(result.detail).toContain("connection terminated");
    expect(probe.findings).toBe(0);
    expect(probe.modelCalls).toBe(0);
    expect(await readdir(workdirBase)).toEqual(["projects"]);
  });

  test("an environment task's images are pruned when it ends, however it ends, keeping main's version", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { result, probe } = await dispatchWith(checkStore(null), "environment");

    expect(result.status).toBe("failed");
    expect(probe.prunes).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  test("an implementation task prunes nothing", async () => {
    const { probe } = await dispatchWith(checkStore(null), "implementation");
    expect(probe.prunes).toEqual([]);
  });

  test.each([[[]], [["a", "b"]]])("a check task that decides %j tasks: failed before the agent", async (checked) => {
    const { result, probe } = await dispatchWith(checkStore(null, checked), "check");

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("resolveCheckedTask");
    expect(result.detail).toContain("must decide exactly one implementation task");
    expect(probe.modelCalls).toBe(0);
  });

  // ADR-083: a check set is kept only when it decides every item its task cites; none on record is no set to judge.
  test("a check task that records no vision item it cites: failed before the agent", async () => {
    const store: TaskCheckStore = {
      ...checkStore(null, [createWorkItemId()]),
      foundationOf: async () => ({ kind: "found", taskId: createWorkItemId(), commit: "c".repeat(40) }),
    };
    const { result, probe } = await dispatchWith(store, "check", { ...someTask().taskSpec, origin: "check", sources: [] });

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("resolveCitedItems");
    expect(result.detail).toContain("records no vision item it cites");
    expect(probe.modelCalls).toBe(0);
  });
});

// A cell the substrate refuses is an infrastructure fault, never a tree regression that abandons
// the task. Every stage that runs on the substrate is failed here in
// turn, with the real PodmanSubstrate over a fake process runner and a real git target.
describe("a substrate failure at any stage blocks the task on the environment", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  type Role = "developer" | "verifier" | "ci";

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
    /** The second turn does not fit its model's window, after the first wrote greet.txt. */
    readonly overflowsSecondTurn?: ContextBudgetExceeded;
    /** The model staffing offers with a window larger than the one overflowed; none when absent. */
    readonly widerModel?: AssignmentStaff["model"];
    /** The environment version the stored checks were red-run on; the dispatch's own when absent. */
    readonly storedVersion?: string;
    /** The stored checks' files. */
    readonly storedFiles?: TaskChecks["files"];
    /** The exit code of every check run in a CI cell (a red run or run_checks); 0 when absent. */
    readonly ciExit?: number;
    /** A CI-cell command that exits 1 whatever ciExit says: the environment's test is "true". */
    readonly ciFailsCommand?: string;
    /** What every check run in a CI cell prints; "hello\n" when absent. */
    readonly ciStdout?: string;
    /** The first turn writes greet.txt and calls run_checks; the second finishes. */
    readonly agentRunsChecks?: boolean;
    /** A file sits where the throwaway checkouts' directory must be: Z0 cannot make a checkout. */
    readonly checkoutsBlocked?: boolean;
    /** The process shuts down during the second turn's model call, after the first wrote greet.txt. */
    readonly shutdownDuringSecondTurn?: AbortController;
    /** The attempt's wall clock is past its limit once the first turn, which wrote greet.txt, returns. */
    readonly wallClockRunsOutAfterFirstTurn?: boolean;
    /** The dispatch's ordinal, as the orchestrator's dispatch seam counted it; 1 when absent. */
    readonly attempt?: number;
    /** Files the agent's first turn writes beside greet.txt, by path. */
    readonly agentAlsoWrites?: Readonly<Record<string, string>>;
    /** The project's stored check files, as the store reports them to the ownership gate. */
    readonly checkFiles?: Awaited<ReturnType<TaskCheckStore["checkFilesOf"]>>;
    /** The task is a check task deciding one implementation task; an implementation task when absent. */
    readonly checkWork?: boolean;
    /** Product files the definition names as inputs of the image build, on main with their content. */
    readonly inputs?: Readonly<Record<string, string>>;
    /** The task is the product scaffold (ADR-074 addendum 2 d72 B2), decided by the definition's build and test. */
    readonly scaffold?: boolean;
    /** A verifier cell's run of exactly this command exits 1. */
    readonly verifierFailsCommand?: string;
    /** A build of an environment version other than main's fails. */
    readonly rebuildFails?: boolean;
    /** The agent finishes done at once, writing nothing: its branch holds no change against main. */
    readonly agentWritesNothing?: boolean;
    /**
     * The exit code of every stored check in the delivered sweep's cell on main (ADR-074 addendum 2
     * d74 A); 1 when absent: the task's work is not on main yet, so it is dispatched.
     */
    readonly sweepExit?: number;
    /** The exit code of every check red-run on the stored baseline (a revalidation); ciExit when absent. */
    readonly baselineExit?: number;
    /** Like checkoutsBlocked, but only from the model's first call: the checkouts before the model are made. */
    readonly checkoutsBlockedAfterSweep?: boolean;
    /** The exit code of the environment's build on a red run's foundation; 0 when absent. */
    readonly foundationBuildExit?: number;
  }

  /** The delivered sweep's CI cell: told apart by its checkout, and kept out of `started` and `runs`. */
  const SWEEP_ID = "e".repeat(64);
  /** A CI cell red-running on the stored baseline: in `started` as "ci", told apart only for baselineExit. */
  const BASELINE_ID = "f".repeat(64);
  /** The CI cell of the environment's build on a red run's foundation: kept out of `started` and `runs`. */
  const FOUNDATION_BUILD_ID = "9".repeat(64);

  const ok = (stdout = "", exitCode = 0, stderr = "", statusReport: string | null = null) => ({
    exitCode, signal: null, stdout, stdoutCut: null, stderr, stderrCut: null, killedByHost: false, stdinError: null, statusReport,
  });
  /** An exec the in-cell wrapper reported the command's own status for. */
  const ran = (stdout: string, exitCode = 0) => ok(stdout, exitCode, "", `${exitCode}\n`);
  const ids: Record<Role, string> = { developer: "a".repeat(64), verifier: "b".repeat(64), ci: "d".repeat(64) };
  const roleOf = (id: string | undefined): Role | undefined =>
    id === ids.developer ? "developer" : id === ids.verifier ? "verifier" : id === ids.ci ? "ci" : undefined;

  function turn(name: string, input: unknown): CostedTurnResult {
    return {
      assistant: { role: "assistant", content: [{ type: "tool-call", toolCallId: `tc-${name}`, toolName: name, input }] },
      text: "",
      toolCalls: [{ kind: "valid", toolCallId: `tc-${name}`, toolName: name, input }],
      finishReason: "tool_calls",
      rawFinishReason: null,
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reportedOutputTokens: 1,
      reportedInputTokens: 10,
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
    const workdirBase = join(root, "cells", "work");
    const target = join(workdirBase, "projects", "target");
    await mkdir(target, { recursive: true });
    await ensureTargetGitInit(target, workdirBase);
    await commitEnvironment(target, faults.inputs);
    const mainBefore = await git(target, "rev-parse", "main");
    const started: Array<{ readonly role: Role; readonly image: string | undefined }> = [];
    /** Every `podman run`'s argv, as the substrate built it, but the delivered sweep's. */
    const runs: string[][] = [];
    const sweepRuns: string[][] = [];
    const foundationBuilds: string[][] = [];

    const substrate = new PodmanSubstrate({ trace: () => "test-trace", 
      podmanPath: "podman",
      mountRoot,
      runner: async ({ args }) => {
        switch (args[0]) {
          case "info":
            return ok(JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } }));
          case "run": {
            if (args.some((arg) => arg.includes("/checkouts/delivered-sweep-"))) {
              sweepRuns.push([...args]);
              return ok(`${SWEEP_ID}\n`);
            }
            if (args.some((arg) => arg.includes("/checkouts/foundation-build-"))) {
              foundationBuilds.push([...args]);
              return ok(`${FOUNDATION_BUILD_ID}\n`);
            }
            runs.push([...args]);
            const role: Role = args.includes("ashara.role=verifier") ? "verifier" : args.includes("ashara.role=ci") ? "ci" : "developer";
            started.push({ role, image: args.find((arg) => arg.startsWith("sha256:") || arg.includes("@sha256:")) });
            if (faults.startFails === role) return ok("", 125, "Error: OCI runtime error");
            return ok(`${role === "ci" && args.some((arg) => arg.includes("/checkouts/red-run-")) ? BASELINE_ID : ids[role]}\n`);
          }
          case "exec": {
            const cellId = args.find((arg) => /^[0-9a-f]{64}$/.test(arg));
            // The cell probe after an exec with no status report: a fresh exec of the sweep.
            const probe = args.includes("ashara-sweep");
            // argv travels in the wrapper's environment; the command is its last element.
            const command = [...args].reverse().find((arg) => arg.startsWith("ASHARA_ARG_"))?.replace(/^ASHARA_ARG_\d+=/, "");
            if (cellId === FOUNDATION_BUILD_ID) {
              const exit = faults.foundationBuildExit ?? 0;
              return ran(exit === 0 ? "built\n" : "error: no build manifest in the tree\n", exit);
            }
            if (cellId === SWEEP_ID) return ran(faults.sweepExit === 0 ? "hello\n" : "", faults.sweepExit ?? 1);
            if (cellId === BASELINE_ID && faults.execFails !== "ci") return ran(faults.ciStdout ?? "hello\n", faults.baselineExit ?? faults.ciExit ?? 0);
            const role = cellId === BASELINE_ID ? "ci" : roleOf(cellId);
            // No status report, and the cell fails its probe too: podman exec itself failed, the command never ran.
            if (faults.execFails !== undefined && faults.execFails === role) {
              return probe ? ok("", 125, "Error: OCI runtime error") : ok("", 125, "Error: OCI runtime error", "");
            }
            if (role === "ci" && faults.ciFailsCommand !== undefined && command === faults.ciFailsCommand) return ran("broken\n", 1);
            if (role === "verifier" && faults.verifierFailsCommand !== undefined && command === faults.verifierFailsCommand) return ran("broken\n", 1);
            return role === "ci" ? ran(faults.ciStdout ?? "hello\n", faults.ciExit ?? 0) : ran("hello\n");
          }
          case "rm":
            return faults.teardownFails === true ? ok("", 1, "Error: container is busy") : ok();
          default:
            throw new Error(`unexpected podman ${args.join(" ")}`);
        }
      },
    });
    if (faults.checkoutsBlocked === true) {
      await mkdir(workdirBase, { recursive: true });
      await writeFile(join(workdirBase, "checkouts"), "not a directory\n");
    }
    const checkWork = faults.checkWork === true;
    const task = {
      ...someTask(),
      attempt: faults.attempt ?? 1,
      workKind: checkWork ? ("check" as const) : ("implementation" as const),
      ...(faults.scaffold === true ? { taskSpec: { ...someTask().taskSpec, origin: "product-scaffold" as const, checkedBy: "substrate" as const } } : {}),
      ...(checkWork ? { taskSpec: { ...someTask().taskSpec, origin: "check" as const, sources: [CITED_SCOPE] } } : {}),
    };
    const workDir = join(workdirBase, (checkWork ? checkBranchName(task.id) : taskBranchName(task.id)).replace(/\//g, "-"));
    const shutdown = faults.shutdownDuringSecondTurn;
    // Read when the dispatch plans its work, after the environment's build reported its version.
    const stored = (probe: Probe): TaskCheckStore => ({
      ...checkStore(null, checkWork ? [createWorkItemId()] : [], faults.checkFiles ?? []),
      // The plan's foundation: the environment's commit, main as the dispatch starts.
      foundationOf: async () => ({ kind: "found", taskId: createWorkItemId(), commit: mainBefore }),
      latest: async () => ({ ...STORED_CHECKS, environmentVersion: faults.storedVersion ?? probe.version ?? "", baselineCommit: mainBefore, files: faults.storedFiles ?? [] }),
    });
    const { service, events, probe } = serviceOn(substrate, workdirBase, (probe) => {
      if (faults.checkoutsBlockedAfterSweep === true && probe.modelCalls === 1) {
        rmSync(join(workdirBase, "checkouts"), { recursive: true, force: true });
        writeFileSync(join(workdirBase, "checkouts"), "not a directory\n");
      }
      if (shutdown !== undefined) {
        if (probe.modelCalls === 2) {
          shutdown.abort();
          // What a provider call throws when its abort signal fires.
          throw new DOMException("This operation was aborted", "AbortError");
        }
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        return turn("run_command", { command: "true" });
      }
      if (faults.wallClockRunsOutAfterFirstTurn === true) {
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        const later = Date.now() + 21 * 60 * 1000;
        vi.spyOn(Date, "now").mockImplementation(() => later);
        return turn("run_command", { command: "true" });
      }
      if (faults.agentRunsChecks === true) {
        if (probe.modelCalls === 1) {
          writeFileSync(join(workDir, "greet.txt"), "hello\n");
          return turn("run_checks", {});
        }
        return turn("finish", { status: "done", summary: `check files in the worktree: ${(faults.storedFiles ?? []).filter((f) => existsSync(join(workDir, f.path))).length}` });
      }
      if (faults.refusesSecondTurn !== undefined) {
        if (probe.modelCalls === 2) throw faults.refusesSecondTurn;
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        return turn("run_command", { command: "true" });
      }
      if (faults.overflowsSecondTurn !== undefined) {
        if (probe.modelCalls === 2) throw faults.overflowsSecondTurn;
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        return turn("run_command", { command: "true" });
      }
      if (faults.agentRunsCommand === true && probe.modelCalls === 1) return turn("run_command", { command: "true" });
      if (probe.modelCalls === 1 && faults.agentWritesNothing !== true) {
        writeFileSync(join(workDir, "greet.txt"), "hello\n");
        for (const [path, content] of Object.entries(faults.agentAlsoWrites ?? {})) {
          mkdirSync(dirname(join(workDir, path)), { recursive: true });
          writeFileSync(join(workDir, path), content);
        }
      }
      return turn("finish", { status: "done", summary: "wrote greet.txt" });
    }, stored, shutdown?.signal, "owned", faults.widerModel ?? null);
    probe.rebuildFails = faults.rebuildFails === true;

    const result = await service.execute(task, target);
    const branches = await git(target, "branch", "--list", taskBranchName(task.id));
    return {
      result, events, warns, target, started, runs, sweepRuns, foundationBuilds, probe, workdirBase, taskId: task.id,
      mainBefore, mainAfter: await git(target, "rev-parse", "main"), branchKept: branches !== "",
    };
  }

  test("an implementation task's cells start from the environment image; the version is recorded with the attempt", async () => {
    const { result, started, runs, probe, events, workdirBase, taskId } = await dispatch({});

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
    expect([...probe.sessions.attempts.values()]).toEqual([
      { promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/), terminal: "finished:done", turns: 1, provider: expect.any(String), model: expect.any(String), cell: "environment" },
    ]);

    const [sessionDir] = await readdir(join(workdirBase, "records", taskId));
    const conversation = await readFile(join(workdirBase, "records", taskId, sessionDir ?? "", "conversation.jsonl"), "utf8");
    const first: unknown = JSON.parse(conversation.split("\n")[0] ?? "null");
    expect(first).toMatchObject({ kind: "attempt_started", cellImage: { kind: "environment", version, imageId: ENV_IMAGE_ID } });
    const { system } = z.object({ system: z.string() }).parse(first);
    expect(system).toContain(STATEMENT);
    expect(system).toContain(`version ${String(version)}`);

    // s-team-roster-m1: the attempt runs as the work item's owner role, never a literal role.
    expect(first).toMatchObject({ role: OWNER_ROLE });
    expect(runs[0]).toContain(`ashara.role=${OWNER_ROLE.id}`);
    expect(events.find((e) => e.event === "agent_launched")).toMatchObject({ roleId: OWNER_ROLE.id, role: OWNER_ROLE.name });
    // ADR-074 addendum 2 d73: every cell (the task's, and the verifier's, made like the probe's
    // and every check's) sees a throwaway repository of its own in place of the worktree's gitlink,
    // and runs as the same non-root user with the same writable home. No volume source is a .git.
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const volumes = run.filter((_, i, all) => all[i - 1] === "-v");
      expect(volumes.some((v) => v.endsWith("/.ashara-cell-gitlink:/workspace/.git:ro,z"))).toBe(true);
      expect(volumes.some((v) => v.endsWith("/git:/ashara-cell/git:Z"))).toBe(true);
      expect(volumes.some((v) => v.split(":")[0]?.endsWith("/.git"))).toBe(false);
      expect(run).toContain("--userns=keep-id");
      expect(run[run.indexOf("-e") + 1]).toBe("HOME=/ashara-cell/home");
    }
    // The brief carries the vision's assumptions, not only its text.
    expect(system).toContain("vision version 2");
    expect(system).toContain("- A1 (Inferred; reported to the client; client-visible behaviour): Greetings are written in lower case.");
    expect(system).toContain("- A2 (Stated by the client; client-visible behaviour): The greeting file is plain text, one line.");
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
      // The blocked chain keeps the typed error itself: its class and its own fields, not a string.
      const origin = result.errorEnvelope.chain.cause;
      expect(origin).toMatchObject({ boundary: "origin", operation: errorClass, context: expect.objectContaining({ errorClass }) });
      if (errorClass === "CellExecFailed") {
        expect(origin?.context).toMatchObject({ exitCode: 125, stderr: "Error: OCI runtime error", argv: expect.any(Array), cellId: expect.any(String) });
      }
      if (errorClass === "MountPathRejected") {
        expect(origin?.context).toMatchObject({ hostPath: expect.any(String), mountRoot: expect.any(String), reason: expect.any(String) });
      }
      expect(events.filter((e) => e.event === "task_blocked")).toEqual([expect.objectContaining({ stage, errorClass })]);
      expect(events.some((e) => e.event === "task_failed" || e.event === "gate_failed" || e.event === "task_completed")).toBe(false);
      // Nothing merged; the agent's work, where there was any, waits on its branch for the retry.
      expect(mainAfter).toBe(mainBefore);
      expect(await git(target, "status", "--porcelain")).toBe("");
      if (stage === "postMergeVerify") expect(branchKept).toBe(true);
    },
  );

  // Teardown never ends a stage: the cell is left to teardownAll and reconcileOrphans.
  test("a failed teardown of every cell: the task still completes, the failures logged and emitted", async () => {
    const { result, events, warns, mainBefore, mainAfter } = await dispatch({ teardownFails: true });

    expect(result.status).toBe("completed");
    expect(mainAfter).not.toBe(mainBefore);
    // The task's, the delivered sweep's and the verifier's.
    expect(events.filter((e) => e.event === "cell_teardown_failed")).toHaveLength(3);
    expect(warns.some((w) => w.includes("still on disk"))).toBe(false);
  });

  // A turn refused before it was sent is neither transport_exhausted nor a failure for the FailureRouter.
  test("a turn refused before it was sent: refused carrying the refusal, never failed; no lesson; partial work kept", async () => {
    const refusal = new PreCallRefusal("budget_cap: the spend cap of project p is $1.000000");
    const { result, events, probe, mainBefore, mainAfter, branchKept } = await dispatch({ refusesSecondTurn: refusal });

    expect(result.status, result.detail).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal).toBe(refusal);
    expect(result.detail).toContain("turn 2");
    expect(result.outcome?.kind).toBe("refused");
    expect(probe.modelCalls).toBe(2);
    expect(probe.findings).toBe(0);
    expect(events.filter((e) => e.event === "task_refused")).toEqual([expect.objectContaining({ errorClass: "PreCallRefusal" })]);
    expect(events.some((e) => e.event === "task_failed" || e.event === "task_blocked" || e.event === "task_completed")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(true);
  });

  // t-context-overflow-routing: an overflow is deterministic, so it is never the agent's failure nor
  // retried on the model whose window it did not fit.
  const overflowOf = (breach: ConstructorParameters<typeof ContextBudgetExceeded>[0]["breach"]) =>
    new ContextBudgetExceeded({ provider: "none", model: "unused-model", windowTokens: 32_000, outputReserveTokens: 16_384, breach });
  const WIDE: AssignmentStaff["model"] = {
    ...unusedModel,
    modelId: "wide-model",
    provider: "wide",
    modelConfig: { ...unusedModel.modelConfig, id: "wide-model", provider: "wide", maxContextTokens: 200_000 },
  };

  test("a turn that does not fit its window: context_exceeded naming a larger-window model, never failed; no lesson; partial work kept", async () => {
    const overflow = overflowOf({ source: "preflight", projectedInputTokens: 20_000, basis: "estimated" });
    const { result, events, probe, mainBefore, mainAfter, branchKept } = await dispatch({ overflowsSecondTurn: overflow, widerModel: WIDE });

    expect(result.status, result.detail).toBe("context_exceeded");
    if (result.status !== "context_exceeded") return;
    expect(result).not.toHaveProperty("verdict");
    expect(result.model).toEqual({ provider: "none", modelId: "unused-model" });
    expect(result.windowTokens).toBe(32_000);
    expect(result.projectedInputTokens).toBe(20_000);
    expect(result.wider).toEqual({ provider: "wide", modelId: "wide-model", windowTokens: 200_000 });
    expect(probe.widerAsked).toEqual([32_000]);
    expect(probe.findings).toBe(0);
    expect(result.detail).toContain("its next dispatch is on wide/wide-model");
    expect(events.filter((e) => e.event === "context_exceeded")).toEqual([expect.objectContaining({ windowTokens: 32_000, wider: "wide/wide-model" })]);
    expect(events.some((e) => e.event === "task_failed" || e.event === "task_blocked" || e.event === "task_completed")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(true);
  });

  test("a provider's overflow with no larger-window model in the catalog: context_exceeded with none to escalate to, the provider's words kept", async () => {
    const overflow = overflowOf({ source: "provider", providerMessage: "exceeds the maximum number of tokens allowed" });
    const { result, probe } = await dispatch({ overflowsSecondTurn: overflow });

    expect(result.status, result.detail).toBe("context_exceeded");
    if (result.status !== "context_exceeded") return;
    expect(result.wider).toBeNull();
    expect(result.projectedInputTokens).toBeNull();
    expect(result.providerMessage).toBe("exceeds the maximum number of tokens allowed");
    expect(result.detail).toContain("no catalog model graded for the task has a window larger than 32000 tokens");
    expect(probe.findings).toBe(0);
  });

  // A git step of Z0's around the stored checks that fails never blames the task as a verification gap.
  test("Z0 cannot make the checks' checkout: blocked under postMergeCheckRun, never a failure of the task", async () => {
    const { result, events, started, mainBefore, mainAfter, branchKept } = await dispatch({ checkoutsBlockedAfterSweep: true });

    expect(result.status, result.detail).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.errorEnvelope.chain.operation).toBe("postMergeCheckRun");
    expect(result.detail).toContain("stage postMergeCheckRun (VerificationInfrastructureFault)");
    expect(result.unavailable).toBe("verification infrastructure (stored-check run)");
    expect(started.map((s) => s.role)).toEqual(["developer"]);
    expect(events.some((e) => e.event === "gate_failed" || e.event === "task_failed" || e.event === "task_completed")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(true);
  });

  // ADR-074 addendum 2 d74 A: the delivered sweep runs before every implementation dispatch.
  test("Z0 cannot make the delivered sweep's checkout: blocked under deliveredCheckRun before the model, never a failure", async () => {
    const { result, probe, events, sweepRuns } = await dispatch({ checkoutsBlocked: true });

    expect(result.status, result.detail).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.errorEnvelope.chain.operation).toBe("deliveredCheckRun");
    expect(result.unavailable).toBe("verification infrastructure (delivered sweep on main)");
    expect(probe.modelCalls).toBe(0);
    expect(sweepRuns).toEqual([]);
    expect(events.some((e) => e.event === "task_failed" || e.event === "agent_launched")).toBe(false);
  });

  test("stored checks that all pass on main: closed as already delivered by the sweep before the model, nothing merged", async () => {
    const { result, probe, events, sweepRuns, mainBefore, mainAfter } = await dispatch({ sweepExit: 0, ciExit: 0 });

    expect(result.status, result.detail).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.delivered).toEqual({ kind: "already-delivered", mainCommit: mainBefore });
    expect(probe.modelCalls).toBe(0);
    expect(sweepRuns).toHaveLength(1);
    expect(events.find((e) => e.event === "delivered_sweep")).toMatchObject({ allPass: true, mainCommit: mainBefore, passed: ["greets"] });
    expect(mainAfter).toBe(mainBefore);
  });

  test("a stored check failing on main: the sweep dispatches the implementer", async () => {
    const { result, probe, events, sweepRuns } = await dispatch({});

    expect(result.status, result.detail).toBe("completed");
    expect(probe.modelCalls).toBeGreaterThan(0);
    expect(sweepRuns).toHaveLength(1);
    expect(events.find((e) => e.event === "delivered_sweep")).toMatchObject({ allPass: false, passed: [] });
  });

  // (c): checks red-run on another environment version are red-run again on this one before the model.
  test("checks from another environment version that still fail on main are trusted, then decide the task", async () => {
    const { result, events, started } = await dispatch({ storedVersion: "e".repeat(64), ciExit: CHECK_MISSING_EXIT });

    expect(result.status, result.detail).toBe("completed");
    expect(started.map((s) => s.role)).toEqual(["developer", "ci", "verifier"]);
    expect(events.find((e) => e.event === "checks_revalidated")).toMatchObject({ storedVersion: "e".repeat(64), trusted: true });
  });

  // A check's own exit 125 is also podman exec's failure code, but here it is the check's own exit,
  // not its verdict that the work is missing, so the set is stale on this environment, never an
  // environment failure.
  test("a stored check that itself exits 125 on its baseline is the check's own, never an environment failure", async () => {
    const { result, events, probe } = await dispatch({ storedVersion: "e".repeat(64), ciExit: 125 });

    expect(result.status, result.detail).toBe("checks_stale");
    expect(result.detail).toContain("it exited 125 on the foundation, not 99");
    expect(probe.modelCalls).toBe(0);
    expect(events.find((e) => e.event === "checks_revalidated")).toMatchObject({ trusted: false });
    expect(result.errorEnvelope?.chain.operation).toBe("revalidateTaskChecks");
  });

  // t-checks-before-work review: an over-delivering task that moved the environment version sent the
  // next task's passing checks to checks_stale, whose check task's red run could never accept a check.
  test("checks from another environment version that hold on their baseline and all pass on main: already delivered before the model, nothing merged", async () => {
    const { result, probe, events, started, mainBefore, mainAfter, branchKept } = await dispatch({ storedVersion: "e".repeat(64), baselineExit: CHECK_MISSING_EXIT, sweepExit: 0, ciExit: 0 });

    expect(result.status, result.detail).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.delivered).toEqual({ kind: "already-delivered", mainCommit: mainBefore });
    expect(result.outcome).toBeNull();
    expect(probe.modelCalls).toBe(0);
    expect(events.some((e) => e.event === "agent_launched" || e.event === "task_blocked")).toBe(false);
    expect(events.find((e) => e.event === "delivered_on_main_verify")).toMatchObject({ verdict: "passed", mainCommit: mainBefore });
    expect(events.find((e) => e.event === "task_completed")).toMatchObject({ result: "already_delivered" });
    expect(started.map((s) => s.role)).toEqual(["developer", "ci", "ci"]);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(false);
  });

  // t-delivered-paths-exits (ADR-074 addendum 2 d68 a): main's own regression failed the task before any model ran.
  test("checks from another environment version that all pass on main while main's environment test fails: dispatched to the implementer, never failed before the model", async () => {
    const { result, probe, events } = await dispatch({ storedVersion: "e".repeat(64), baselineExit: CHECK_MISSING_EXIT, sweepExit: 0, ciExit: 0, ciFailsCommand: "true" });

    expect(events.find((e) => e.event === "delivered_on_main_verify")).toMatchObject({ verdict: "failed" });
    expect(events.some((e) => e.event === "agent_launched")).toBe(true);
    expect(probe.modelCalls).toBeGreaterThan(0);
    expect(result.errorEnvelope?.chain.operation).not.toBe("revalidateTaskChecks");
    expect(result.status === "completed" && result.delivered.kind === "already-delivered").toBe(false);
  });

  // The (c) review: stale checks were "failed", so replanned and lessoned against the implementer.
  test("checks from another environment version none of which fails on their baseline: checks_stale before the model, naming the check task and both versions", async () => {
    const { result, probe, events, mainBefore, mainAfter } = await dispatch({ storedVersion: "e".repeat(64), ciExit: 0, ciStdout: "" });

    expect(result.status, result.detail).toBe("checks_stale");
    if (result.status !== "checks_stale") return;
    expect(result.checkTaskId).toBe(STORED_CHECKS.checkTaskId);
    expect(result.revision).toBe(STORED_CHECKS.revision);
    expect(result.detail).toContain(`check task ${STORED_CHECKS.checkTaskId}`);
    expect(result.errorEnvelope.outcome).toBe("blocked");
    expect(result.errorEnvelope.chain.operation).toBe("revalidateTaskChecks");
    expect(probe.findings).toBe(0);
    expect(events.some((e) => e.event === "task_failed")).toBe(false);
    expect(result.detail).toContain(`environment version ${"e".repeat(64)}`);
    expect(result.detail).toContain(`environment version ${String(probe.version)}`);
    expect(result.detail).toContain("no check of the set fails on the foundation");
    // The detail reopens the check task as its brief: the baseline commit stays in the chain, for the operator.
    expect(result.detail).not.toContain(mainBefore);
    expect(result.errorEnvelope.chain.context).toMatchObject({ baselineCommit: mainBefore });
    expect(probe.modelCalls).toBe(0);
    expect(events.find((e) => e.event === "checks_revalidated")).toMatchObject({ trusted: false });
    expect(events.some((e) => e.event === "agent_launched")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
  });

  // A check that fails because the foundation does not build is never kept by the red run.
  test("checks from another environment version on a baseline the environment no longer builds: checks_stale, never trusted on failures the build caused", async () => {
    const { result, probe, events, foundationBuilds } = await dispatch({ storedVersion: "e".repeat(64), ciExit: 1, foundationBuildExit: 1 });

    expect(foundationBuilds).toHaveLength(1);
    expect(result.status, result.detail).toBe("checks_stale");
    expect(result.detail).toContain("the environment's build fails on the baseline");
    expect(result.detail).toContain("no build manifest in the tree");
    expect(events.find((e) => e.event === "checks_revalidated")).toMatchObject({ trusted: false });
    expect(probe.modelCalls).toBe(0);
  });

  test("a check task on a foundation the environment does not build: environment_undefined before the model; the red run is never reached", async () => {
    const { result, probe, events, target, taskId, foundationBuilds, started } = await dispatch({ checkWork: true, foundationBuildExit: 1 });

    expect(foundationBuilds).toHaveLength(1);
    expect(result.status, result.detail).toBe("environment_undefined");
    if (result.status !== "environment_undefined") return;
    expect(result.reason).toContain("the environment's build");
    expect(result.reason).toContain("fails on the plan's foundation");
    expect(result.reason).toContain("no build manifest in the tree");
    expect(result.errorEnvelope.chain.operation).toBe("foundationBuild");
    expect(events.find((e) => e.event === "foundation_build")).toMatchObject({ passed: false, exitCode: 1 });
    expect(events.some((e) => e.event === "agent_launched" || e.event === "check_red_run" || e.event === "task_checks_recorded")).toBe(false);
    expect(probe.modelCalls).toBe(0);
    expect(started.map((s) => s.role)).toEqual(["developer"]);
    expect(await git(target, "branch", "--list", checkBranchName(taskId))).toBe("");
  });

  test("a check task on a foundation the environment builds: the build runs once before the model, then the attempt goes on", async () => {
    const { probe, events, foundationBuilds } = await dispatch({ checkWork: true });

    expect(foundationBuilds).toHaveLength(1);
    expect(events.find((e) => e.event === "foundation_build")).toMatchObject({ passed: true, exitCode: 0 });
    expect(probe.modelCalls).toBeGreaterThan(0);
  });

  // The (c) review: a git or checkout step of the revalidating red run was rethrown into processTask.
  test("Z0 cannot make the revalidating red run's checkout: blocked under checkRedRun before the model, never a failure", async () => {
    const { result, probe, events, mainBefore, mainAfter } = await dispatch({ storedVersion: "e".repeat(64), checkoutsBlocked: true });

    expect(result.status, result.detail).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.errorEnvelope.chain.operation).toBe("checkRedRun");
    expect(result.detail).toContain("stage checkRedRun (VerificationInfrastructureFault)");
    expect(result.unavailable).toBe("verification infrastructure (build on the baseline)");
    expect(probe.modelCalls).toBe(0);
    expect(events.some((e) => e.event === "task_failed" || e.event === "agent_launched")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
  });

  // (d): the implementer sees the bar before finishing, on a copy; its worktree never gets the check files.
  test("run_checks runs the stored checks on a copy of the current work in a CI cell; the worktree is untouched", async () => {
    const storedFiles = [{ path: "checks/greet.sh", content: "cat greet.txt\n" }];
    const { result, events, started, probe } = await dispatch({ agentRunsChecks: true, storedFiles });

    expect(result.status, result.detail).toBe("completed");
    expect(started.map((s) => s.role)).toEqual(["developer", "ci", "verifier"]);
    expect(events.filter((e) => e.event === "task_checks_run")).toEqual([expect.objectContaining({ run: 1, passed: ["greets"] })]);
    expect(JSON.stringify(probe.requests[1])).toContain('Check \\"greets\\": PASSED');
    expect(result.outcome !== null ? attemptSummary(result.outcome) : null).toBe("check files in the worktree: 0");
  });

  // A SIGTERM mid-attempt is an interruption, never a failure the FailureRouter can abandon the item for.
  test("the shutdown signal mid-attempt: interrupted, never failed; no lesson; partial work kept", async () => {
    const { result, events, probe, mainBefore, mainAfter, branchKept } = await dispatch({ shutdownDuringSecondTurn: new AbortController(), attempt: 3 });

    expect(result.status, result.detail).toBe("interrupted");
    expect(result.attempt).toBe(3);
    expect(probe.modelCalls).toBe(2);
    expect(probe.findings).toBe(0);
    expect(events.filter((e) => e.event === "task_interrupted")).toEqual([expect.objectContaining({ attempt: 3 })]);
    expect(events.some((e) => e.event === "task_failed" || e.event === "task_blocked" || e.event === "task_completed")).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(true);
  });

  // The review of t-shutdown-cancel-not-failure: the summary claimed a check task's work was kept.
  test.each([
    ["the shutdown signal", { shutdownDuringSecondTurn: new AbortController() }, "interrupted"],
    ["a refused turn", { refusesSecondTurn: new PreCallRefusal("budget_cap: refused") }, "refused"],
  ] satisfies ReadonlyArray<[string, Faults, ExecutionResult["status"]]>)(
    "%s stops a check task: its summary says its partial work is discarded, and nothing of it is left",
    async (_label, faults, status) => {
      const { result, target, taskId } = await dispatch({ ...faults, checkWork: true });

      expect(result.status, result.detail).toBe(status);
      expect(result.detail).toContain("the check task's partial work is discarded");
      expect(result.detail).not.toContain("kept on the task branch");
      expect(await git(target, "branch", "--list", checkBranchName(taskId))).toBe("");
    },
  );

  // A fault of Z0's own machinery inside run_checks is never labelled "task cell".
  test("Z0 cannot make run_checks' checkout: blocked as verification infrastructure, never the task cell", async () => {
    const { result, events } = await dispatch({ agentRunsChecks: true, checkoutsBlockedAfterSweep: true });

    expect(result.status, result.detail).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.unavailable).toBe("verification infrastructure (run_checks)");
    expect(result.detail).toContain("stage agentAttempt (VerificationInfrastructureFault)");
    expect(result.detail).toContain("the agent's work is kept on the task branch");
    expect(events.some((e) => e.event === "task_failed")).toBe(false);
  });

  test("the attempt's own wall clock running out stays a failure", async () => {
    const { result, events } = await dispatch({ wallClockRunsOutAfterFirstTurn: true });

    expect(result.status, result.detail).toBe("failed");
    expect(result.detail).toContain("wall_clock");
    expect(events.some((e) => e.event === "task_interrupted")).toBe(false);
  });

  // ADR-074 addendum 2 d67 b: work an earlier task over-delivered has an exit other than the operator.
  test("no change against main and the checks, the environment's test and the regression suite pass on main: already delivered at main, nothing merged", async () => {
    const { result, events, started, mainBefore, mainAfter, branchKept } = await dispatch({ agentWritesNothing: true, ciExit: 0 });

    expect(result.status, result.detail).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.delivered).toEqual({ kind: "already-delivered", mainCommit: mainBefore });
    expect(result.detail).toContain(`already delivered on main at ${mainBefore}`);
    // Main itself, in a CI cell: no developer work to merge, so no verifier cell and no merge.
    expect(started.map((s) => s.role)).toEqual(["developer", "ci"]);
    expect(started[1]?.image).toBe(ENV_IMAGE_ID);
    expect(mainAfter).toBe(mainBefore);
    expect(branchKept).toBe(false);
    expect(events.find((e) => e.event === "delivered_on_main_verify")).toMatchObject({
      verdict: "passed",
      mainCommit: mainBefore,
      revision: STORED_CHECKS.revision,
      details: expect.stringContaining("environment test"),
    });
    expect(events.find((e) => e.event === "task_completed")).toMatchObject({ result: "already_delivered" });
    expect(events.some((e) => e.event === "post_merge_verify" || e.event === "task_failed")).toBe(false);
  });

  test("no change against main and a check fails on main: failed as no changes with the run's output; never completed on the implementer's word", async () => {
    const { result, events, started, mainBefore, mainAfter } = await dispatch({ agentWritesNothing: true, ciExit: 1 });

    expect(result.status, result.detail).toBe("failed");
    expect(result.detail).toContain("the task branch holds no change against main");
    expect(result.detail).toContain("do not all pass on main, so its work is not already delivered");
    expect(result.detail).not.toContain(mainBefore);
    expect(result.detail).toContain("FAILED");
    expect(result.errorEnvelope?.chain.operation).toBe("agentExecution");
    expect(started.map((s) => s.role)).toEqual(["developer", "ci"]);
    expect(mainAfter).toBe(mainBefore);
    expect(events.find((e) => e.event === "delivered_on_main_verify")).toMatchObject({ verdict: "failed" });
    expect(events.some((e) => e.event === "task_completed")).toBe(false);
  });

  test("no change against main and Z0 cannot make main's checkout: blocked under deliveredCheckRun, never completed or failed", async () => {
    const { result, events } = await dispatch({ agentWritesNothing: true, checkoutsBlockedAfterSweep: true });

    expect(result.status, result.detail).toBe("environment_blocked");
    if (result.status !== "environment_blocked") return;
    expect(result.errorEnvelope.chain.operation).toBe("deliveredCheckRun");
    expect(result.unavailable).toBe("verification infrastructure (checks run on main)");
    expect(events.some((e) => e.event === "task_completed" || e.event === "task_failed")).toBe(false);
  });

  // An implementer's commit must not change the environment's files and so move its version.
  describe("the ownership gate: an implementer's branch touches only what its role may write", () => {
    const CHECK_FILE: Awaited<ReturnType<TaskCheckStore["checkFilesOf"]>>[number] = { taskId: "44444444-4444-4444-8444-444444444444", path: "checks/greet.sh" };

    // A refused environment change has an exit other than an operator editing main.
    test("a branch changing environment/Containerfile: an environment change is requested with the need and the diff; branch deleted, nothing merged", async () => {
      const { result, events, started, probe, mainBefore, mainAfter, branchKept } = await dispatch({
        agentAlsoWrites: { "environment/Containerfile": "FROM scratch\nRUN true\n" },
        checkFiles: [CHECK_FILE],
      });

      expect(result.status, result.detail).toBe("environment_change_requested");
      if (result.status !== "environment_change_requested") return;
      expect(result.paths).toEqual(["environment/Containerfile"]);
      expect(result.need).toBe("wrote greet.txt");
      expect(result.diff).toContain("+RUN true");
      expect(result.diff).not.toContain("greet.txt");
      expect(result.detail).toContain("the environment recipe (environment/environment.toml, environment/Containerfile) belongs to the platform role");
      expect(result.errorEnvelope.chain.operation).toBe("ownershipGate");
      expect(started.map((s) => s.role)).toEqual(["developer"]);
      expect(events.filter((e) => e.event === "environment_change_requested")).toEqual([expect.objectContaining({ paths: ["environment/Containerfile"] })]);
      expect(events.some((e) => e.event === "task_failed" || e.event === "gate_failed" || e.event === "task_completed")).toBe(false);
      expect(probe.modelCalls).toBe(1);
      expect(probe.findings).toBe(0);
      expect(mainAfter).toBe(mainBefore);
      expect(branchKept).toBe(false);
    });

    // ADR-074 addendum 2 d72 B1, B3: an input the recipe reads is the product's, versioned, not fenced,
    // wherever it lives.
    test.each([
      ["outside environment/", "manifest.txt"],
      ["inside environment/ but no recipe file", "environment/manifest.txt"],
    ])("a branch changing an input %s: the merge's environment is rebuilt, the product's build and test pass, it merges and carries the statement", async (_label, input) => {
      const { result, events, started, probe, mainBefore, mainAfter, taskId } = await dispatch({
        inputs: { [input]: "dependencies: none\n" },
        agentAlsoWrites: { [input]: "dependencies: greeter\n" },
      });

      expect(result.status, result.detail).toBe("completed");
      expect(mainAfter).not.toBe(mainBefore);
      expect(events.filter((e) => e.event === "ownership_gate")).toEqual([expect.objectContaining({ verdict: "clean" })]);
      const resolved = events.find((e) => e.event === "environment_resolved")?.["version"];
      const rebuilt = events.find((e) => e.event === "environment_rebuilt");
      expect(rebuilt).toMatchObject({ from: resolved, to: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(rebuilt?.["to"]).not.toBe(resolved);
      expect(probe.builds).toBe(2);
      // The rebuilt environment's build and test, then the suites, each in a verifier cell from the new image.
      expect(started.map((s) => s.role)).toEqual(["developer", "verifier", "verifier"]);
      expect(probe.recorded).toEqual([{ taskId, statement: STATEMENT, version: rebuilt?.["to"] }]);
      expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "passed" });
    });

    test("a branch writing a manifest the definition does not name: no recipe file, so the gate passes and nothing is rebuilt", async () => {
      const { result, events, probe } = await dispatch({
        agentAlsoWrites: { "environment/go.mod-like.txt": "module x\n", "manifest.txt": "dependencies: greeter\n" },
      });

      expect(result.status, result.detail).toBe("completed");
      expect(events.filter((e) => e.event === "ownership_gate")).toEqual([expect.objectContaining({ verdict: "clean" })]);
      expect(events.some((e) => e.event === "environment_rebuilt")).toBe(false);
      expect(probe.builds).toBe(1);
    });

    test("a branch changing an input whose rebuilt image cannot be built: failed with the build output; nothing merged, no statement", async () => {
      const { result, events, probe, mainBefore, mainAfter, branchKept } = await dispatch({
        inputs: { "manifest.txt": "dependencies: none\n" },
        agentAlsoWrites: { "manifest.txt": "dependencies: greeter\n" },
        rebuildFails: true,
      });

      expect(result.status, result.detail).toBe("failed");
      expect(result.detail).toContain("The merge changes the environment's build context (its inputs)");
      expect(result.detail).toContain("the image build exited 1");
      expect(result.detail).toContain("step 2/2: missing package");
      expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "failed" });
      expect(probe.recorded).toEqual([]);
      expect(mainAfter).toBe(mainBefore);
      expect(branchKept).toBe(true);
    });

    test("a branch writing a stored check file (and an environment file): failed naming both and both rules; nothing merged", async () => {
      const { result, events, started, mainBefore, mainAfter, branchKept } = await dispatch({
        agentAlsoWrites: { "checks/greet.sh": "true\n", "environment/Containerfile": "FROM scratch\nRUN true\n" },
        checkFiles: [CHECK_FILE],
      });

      expect(result.status, result.detail).toBe("failed");
      expect(result.detail).toContain(`checks/greet.sh (checks of task ${CHECK_FILE.taskId})`);
      expect(result.detail).toContain("check files belong to the check author");
      expect(result.detail).toContain("The branch changed these recipe files: environment/Containerfile");
      expect(result.detail).toContain("belongs to the platform role");
      expect(result.errorEnvelope?.chain.operation).toBe("ownershipGate");
      expect(started.map((s) => s.role)).toEqual(["developer"]);
      expect(events.filter((e) => e.event === "gate_failed")).toHaveLength(1);
      expect(mainAfter).toBe(mainBefore);
      expect(branchKept).toBe(true);
    });

    test("a branch clear of both: the gate passes and the work merges; its worktree and branch are gone", async () => {
      const { result, events, probe, mainBefore, mainAfter, branchKept, workdirBase, taskId } = await dispatch({ agentAlsoWrites: { "src/greet.sh": "cat greet.txt\n" }, checkFiles: [CHECK_FILE] });

      expect(result.status, result.detail).toBe("completed");
      expect(events.filter((e) => e.event === "ownership_gate")).toEqual([expect.objectContaining({ verdict: "clean" })]);
      expect(events.some((e) => e.event === "environment_rebuilt")).toBe(false);
      expect(probe.recorded).toEqual([]);
      expect(mainAfter).not.toBe(mainBefore);
      expect(branchKept).toBe(false);
      expect(existsSync(join(workdirBase, `task-${taskId}`))).toBe(false);
    });

    // ADR-074 addendum 2 d72 B2: the scaffold is decided by the product's build and test, never by stored checks.
    test("the product scaffold: no stored check is read; the definition's build and test pass on its merge and it merges", async () => {
      const { result, events, started, mainBefore, mainAfter } = await dispatch({ scaffold: true, agentAlsoWrites: { "manifest.txt": "module greeter\n" } });

      expect(result.status, result.detail).toBe("completed");
      expect(mainAfter).not.toBe(mainBefore);
      expect(events.filter((e) => e.event === "ownership_gate")).toEqual([expect.objectContaining({ verdict: "clean" })]);
      expect(started.map((s) => s.role)).toEqual(["developer", "verifier"]);
      const verify = events.find((e) => e.event === "post_merge_verify");
      expect(verify).toMatchObject({ verdict: "passed", details: expect.stringContaining("the product's build and test") });
      expect(verify?.["details"]).toContain("Checkout after build and test: clean.");
      expect(events.some((e) => e.event === "checks_revalidated" || e.event === "task_checks_run")).toBe(false);
    });

    test("the product scaffold whose build fails on its merge: failed with the run; nothing merged", async () => {
      const { result, mainBefore, mainAfter } = await dispatch({ scaffold: true, verifierFailsCommand: "true" });

      expect(result.status, result.detail).toBe("failed");
      expect(result.detail).toContain("Verdict: FAILED");
      expect(mainAfter).toBe(mainBefore);
    });

    test("the product scaffold may not write the recipe either: an environment change is requested", async () => {
      const { result, mainBefore, mainAfter } = await dispatch({ scaffold: true, agentAlsoWrites: { "environment/environment.toml": "probe = \"x\"\n" } });

      expect(result.status, result.detail).toBe("environment_change_requested");
      expect(mainAfter).toBe(mainBefore);
    });

    // ADR-074 addendum 2 d66 c, d72: the brief names what the gate refuses before work starts.
    test("the implementer's brief names the recipe, the stored check files and the inputs it may change", async () => {
      const { result, workdirBase, taskId } = await dispatch({ inputs: { "manifest.txt": "dependencies: none\n" }, checkFiles: [CHECK_FILE] });

      expect(result.status, result.detail).toBe("completed");
      const [sessionDir] = await readdir(join(workdirBase, "records", taskId));
      const conversation = await readFile(join(workdirBase, "records", taskId, sessionDir ?? "", "conversation.jsonl"), "utf8");
      const { system } = z.object({ system: z.string() }).parse(JSON.parse(conversation.split("\n")[0] ?? "null"));
      expect(system).toContain("# Protected paths");
      expect(system).toContain(
        "- The environment recipe belongs to the platform role, who builds the project's image from it: " +
          "environment/environment.toml, environment/Containerfile.",
      );
      expect(system).toContain("The stored check files belong to the check author who wrote them: checks/greet.sh.");
      expect(system).toContain("The inputs the image build reads (manifest.txt) are product files: you may change them.");
      expect(system).toContain("Every other file is the product's, wherever it lives");
      expect(system).toContain("Z0 opens an environment task for the platform role");
    });
  });
});

const base = {
  turnsUsed: 3,
  cost: { measured: true as const, totalUsd: 0.25, turns: 3 },
  lastToolCall: { turn: 3, toolName: "run_command", input: "{}" },
  promptDigest: "0".repeat(64),
  detail: "why it ended",
};
