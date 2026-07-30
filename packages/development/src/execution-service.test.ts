import { describe, expect, test } from "vitest";
import type { AgentBrief } from "@ashara/shared";
import { createAgentBrief } from "@ashara/shared";
import type { ExecutionResult, SessionStore } from "./execution-service.js";
import { withSessionLifecycle } from "./execution-service.js";

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
    filesChanged: [],
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
