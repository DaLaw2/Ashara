import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { LlmCallNotRecorded, PreCallRefusal } from "@ashara/llm-gateway";
import type { AgentBrief } from "@ashara/shared";
import { createAgentBrief, createWorkItemId, parseProjectId } from "@ashara/shared";
import type { ExecutionResult, SessionStore } from "./execution-service.js";
import { DevelopmentService, withSessionLifecycle } from "./execution-service.js";
import type { EnvironmentSpec, ProvisionedEnv, Provisioner } from "./provisioner.js";

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
      tools: [],
      constraints: [],
      deliverables: [],
    },
    "test",
  );
}

function result(status: ExecutionResult["status"]): ExecutionResult {
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
  const ALL_STATUSES: ReadonlyArray<ExecutionResult["status"]> = ["completed", "failed", "blocked"];

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
        throw new Error("agent-runner produced no readable output");
      }),
    ).rejects.toThrow("agent-runner produced no readable output");

    expect(store.phases.get("sess")).toBe("Failed");
    expect(store.failures.get("sess")).toMatchObject({
      passed: false,
      outcome: "errored",
      detail: "agent-runner produced no readable output",
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

class UnpricedModelLike extends PreCallRefusal {
  constructor() {
    super(`model "m" has no price; call refused before the request`);
    this.name = "UnpricedModelLike";
  }
}

function ledgerNotWritten(): LlmCallNotRecorded {
  return new LlmCallNotRecorded(
    {
      projectId: "p",
      callSite: "environment-spec",
      provider: "prov",
      model: "m",
      operation: "generateStructured",
      callOutcome: "ok",
      providerError: undefined,
    },
    { cause: new Error("insert into llm_calls failed") },
  );
}

function throwingGateway(error: Error): ContextualLlm {
  return {
    forCall: () => ({
      generateStructured: async () => {
        throw error;
      },
    }),
  };
}

class RecordingProvisioner implements Provisioner {
  readonly provisioned: EnvironmentSpec[] = [];
  async provision(spec: EnvironmentSpec): Promise<ProvisionedEnv> {
    this.provisioned.push(spec);
    return { id: "env", version: 1, spec, status: "ready" };
  }
  async execute(): Promise<never> {
    throw new Error("execute must not be reached");
  }
  async teardown(): Promise<void> {}
  activeContainerName(): undefined {
    return undefined;
  }
  activeContainerMount(): undefined {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

// Since 7344ebfc the gateway throws two ledger failures. The environment-spec
// fallback catch used to log them and continue to the agent; it must not.
describe("environment-spec derivation does not swallow ledger failures", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const cases: ReadonlyArray<readonly [string, () => Error, abstract new (...args: never[]) => Error]> = [
    ["LlmCallNotRecorded", ledgerNotWritten, LlmCallNotRecorded],
    ["PreCallRefusal", () => new UnpricedModelLike(), PreCallRefusal],
  ];

  for (const [name, makeError, errorClass] of cases) {
    test(`${name} propagates out of execute, no agent is spawned, the worktree is removed`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-ledger-")));
      scratch.push(root);
      const target = join(root, "target");
      await mkdir(target);
      await writeFile(join(target, "Makefile"), "build:\n\techo built\n");

      const provisioner = new RecordingProvisioner();
      let spawned = 0;
      const service = new DevelopmentService({
        config: { workdirBase: join(root, "work") },
        sessionStore: new RecordingSessionStore(),
        knowledgeSink: { storeFinding: async () => {}, storeInsight: async () => {} },
        agentInvoker: {
          spawn: async () => {
            spawned++;
            throw new Error("agent must not be spawned");
          },
        },
        llmGateway: throwingGateway(makeError()),
        intentSource: { loadIntent: async () => "build the thing" },
        provisioner,
      });

      const run = service.execute(
        {
          id: createWorkItemId(),
          projectId: parseProjectId("22222222-2222-4222-8222-222222222222"),
          title: "t",
          dispatchCount: 0,
          successCriteria: [],
        },
        target,
      );

      await expect(run).rejects.toBeInstanceOf(errorClass);
      expect(spawned).toBe(0);
      expect(provisioner.provisioned).toHaveLength(0);
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: target });
      expect(stdout.match(/^worktree /gm)).toHaveLength(1);
    });
  }
});
