import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, LlmCallRepository, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { DevSessionRepository, createAgentBrief, createSessionId, readRunEvidence, toSessionAttempt, withSessionLifecycle, runAttempt } from "@ashara/workplace";
import type { SessionStore } from "@ashara/workplace";
import type { AttemptCellImage, CellBackend } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { SuiteReviewJudgementRepository } from "@ashara/quality";
import { parseWorkItemId, recordingLogger, wholeText } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { runReport } from "./run-report-body.js";
import { formatRunReport } from "./run-report-format.js";

// The trace contract of a run's evidence, on a scripted run: the real gateway, the Finance ledger
// writing llm_calls, the Workplace attempt loop and the dev session's terminal write, with a mock
// model in place of DeepSeek (no real LLM call) and an in-memory cell. Every attempt must carry a
// typed terminal, a prompt digest and its environment version; every llm_calls row a measured cost
// or an explicit NULL with its estimate, never $0. run-report must read the cache-hit share back.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `run-report-test-${randomUUID().slice(0, 8)}`;

const deepseek: ModelConfig = {
  id: "deepseek-scripted",
  apiModelId: "deepseek-scripted-api",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 0.27,
  outputCostPer1M: 1.1,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: 0.07,
  cacheWriteCostPer1M: null,
  priceWindows: [], priceTiers: [], datedPrices: [],
};

function toolCallTurn(toolName: string, input: unknown, usage: { input: number | undefined; cacheHit: number | undefined }) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName, input: JSON.stringify(input) }],
    usage: {
      inputTokens: { total: usage.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
      raw: usage.cacheHit === undefined ? undefined : { prompt_cache_hit_tokens: usage.cacheHit },
    },
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    warnings: [],
  };
}

function memoryCell(): CellBackend {
  const files = new Map<string, string>();
  return {
    async readFile(path) {
      return wholeText(files.get(path) ?? "");
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async listDirectory() {
      return wholeText([...files.keys()].sort().join("\n"));
    },
    async search() {
      return wholeText("");
    },
    async run() {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, stdoutCut: null, stderrCut: null, statusLost: false };
    },
  };
}

const LlmCallRowSchema = z.object({
  costUsd: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
});

type Db = ReturnType<typeof createDb>;
let db: Db;
let projectId: ProjectId;
const taskIds: string[] = [];

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  const client = await new ClientRepository(db).create(NAME);
  projectId = (await new ProjectRepository(db).create(NAME, client.id)).id;
  for (const title of ["scripted attempt", "ended before the model"]) {
    const id = randomUUID();
    taskIds.push(id);
    await db.execute(sql`
      INSERT INTO work_items (id, level, title, project_id)
      VALUES (${id}, 'Task', ${title}, ${projectId})`);
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (SELECT id FROM work_items WHERE project_id = ${projectId})`);
  await db.execute(sql`DELETE FROM undecided_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${NAME}`);
  await db.$client.end();
});

describe("the trace contract on a scripted run", () => {
  test("every attempt has a terminal, a prompt digest and its environment; every call a cost or an explicit NULL", async () => {
    const [attemptTaskId, idleTaskId] = taskIds;
    if (attemptTaskId === undefined || idleTaskId === undefined) throw new Error("tasks not created");
    const script = [
      toolCallTurn("write_file", { path: "a.txt", content: "a\n" }, { input: 1000, cacheHit: 600 }),
      // A call that reports no input count: its cost is unknown, so its row must say so (NULL).
      toolCallTurn("write_file", { path: "b.txt", content: "b\n" }, { input: undefined, cacheHit: undefined }),
      toolCallTurn("finish", { status: "done", summary: "Wrote a.txt and b.txt." }, { input: 3000, cacheHit: 2400 }),
    ];
    stub.model = new MockLanguageModelV4({
      doGenerate: async () => {
        const next = script.shift();
        if (next === undefined) throw new Error("the mock model's script is exhausted");
        return next;
      },
    });
    const calls = new LlmCallRepository(db);
    const gateway = new GuardedModelAccess(buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [{ name: "deepseek", providerType: "deepseek", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [deepseek], enabled: true }],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }), new LlmCallLedger(calls, new SpendCap({ ledger: calls, caps: { deploymentUsd: 1e6, perProjectUsd: 1e6 } })), recordingLogger());
    const repo = new DevSessionRepository(db);
    const store: SessionStore = {
      insert: (sid, tid, brief, version) => repo.insert(sid, tid, brief, version, "test-trace"),
      complete: (sid, attempt, end) => repo.complete(sid, attempt, end),
      fail: (sid, end, attempt) => repo.fail(sid, end, attempt),
    };
    const brief = createAgentBrief(
      {
        taskId: attemptTaskId,
        goal: "Write a.txt and b.txt",
        intent: "Two files",
        visionVersion: 1,
        assumptions: [],
        projectEnvironment: { kind: "to-define" },
        context: "An empty workspace.",
        deliverables: ["a.txt", "b.txt"],
      },
      "run-report.test",
    );
    const cellImage: AttemptCellImage = {
      kind: "base-cell",
      image: `base@sha256:${"0".repeat(64)}`,
      digest: `sha256:${"0".repeat(64)}`,
    };
    const model = gateway.resolveModel("Strong", "agent-runner");

    const attemptSession = createSessionId();
    await withSessionLifecycle(store, { sessionId: attemptSession, taskId: attemptTaskId, brief, environmentVersion: null }, async (slot) => {
      const outcome = await runAttempt(
        {
          projectId,
          taskId: parseWorkItemId(attemptTaskId, "test"),
          role: { id: "worker", name: "Worker" },
          toolProfile: "run-and-dispute-checks",
          charter: { identity: "You are a coding agent.", duties: null },
          model,
          cellImage,
          brief,
          limits: { maxTurns: 5, perCommandTimeoutSeconds: 30 },
        },
        {
          llm: gateway,
          cell: memoryCell(),
          clock: { now: () => Date.now() },
          records: { append: async () => {} },
          signal: new AbortController().signal,
          environment: null,
          checks: null,
          taskChecks: null,
        },
      );
      slot.attempt = toSessionAttempt(outcome, model, cellImage);
      return { status: "blocked", detail: "scripted run: nothing is merged", outcome: null, sessionId: attemptSession, attempt: 1 };
    });
    // A session that ended before the model (stale checks, work already on main) records no attempt.
    const idleSession = createSessionId();
    await withSessionLifecycle(store, { sessionId: idleSession, taskId: idleTaskId, brief: { ...brief, taskId: idleTaskId }, environmentVersion: null }, async () => ({
      status: "failed",
      detail: "scripted run: ended before the model",
      outcome: null,
      sessionId: idleSession,
      attempt: 1,
    }));
    // A close as already delivered completes with no attempt; the report quotes its own end record.
    const deliveredSession = createSessionId();
    const deliveredDetail = `task already delivered on main at ${"a".repeat(40)}: its checks revision 1 and every suite pass there; nothing merged`;
    await withSessionLifecycle(store, { sessionId: deliveredSession, taskId: idleTaskId, brief: { ...brief, taskId: idleTaskId }, environmentVersion: null }, async () => ({
      status: "completed",
      delivered: { kind: "already-delivered", mainCommit: "a".repeat(40) },
      detail: deliveredDetail,
      outcome: null,
      sessionId: deliveredSession,
      attempt: 1,
    }));

    // NULL attempt columns are not "no model call": a session still open, a crash orphan the
    // reconciler closed (on the task with calls, as a crashed dispatch would leave it) and a row
    // from before the attempt columns existed all read NULL, and the report must say which.
    const openSession = createSessionId();
    await repo.insert(openSession, idleTaskId, brief, null, "test-trace");
    const orphanSession = createSessionId();
    await repo.insert(orphanSession, attemptTaskId, brief, null, "test-trace");
    await repo.fail(orphanSession, { outcome: "abandoned", detail: "test orphan", resolvedBy: "startup-reconciler" }, null);
    const oldSession = createSessionId();
    await repo.insert(oldSession, idleTaskId, brief, null, "test-trace");
    await repo.fail(oldSession, { outcome: "failed", detail: "a row from before the attempt columns" }, null);
    await db.execute(sql`UPDATE dev_sessions SET created_at = '2000-01-01T00:00:00Z' WHERE id = ${oldSession}`);

    const evidence = await readRunEvidence(db, projectId);

    const sessions = evidence.tasks.flatMap((t) => t.sessions);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([attemptSession, idleSession, deliveredSession, openSession, orphanSession, oldSession].sort());
    expect(Object.fromEntries(sessions.map((s) => [s.sessionId, s.attempt.kind]))).toEqual({
      [attemptSession]: "recorded",
      [idleSession]: "unrecorded",
      [deliveredSession]: "completed-without-attempt",
      [openSession]: "open",
      [orphanSession]: "reconciled",
      [oldSession]: "predates-attempt-columns",
    });
    for (const s of sessions) {
      if (s.attempt.kind !== "recorded") continue;
      expect(s.attempt.attempt.terminal).toBe("finished:done");
      expect(s.attempt.attempt.turns).toBe(3);
      expect(s.attempt.attempt.promptDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(s.attempt.attempt.model).toBe("deepseek-scripted");
      // The environment is explicit: a base-cell attempt names it, an environment attempt its version.
      expect(s.attempt.attempt.cell === "base-cell" ? s.environmentVersion === null : /^[0-9a-f]{64}$/.test(s.environmentVersion ?? "")).toBe(true);
    }

    const rows = z.array(LlmCallRowSchema).parse(
      (await db.execute(sql`
        SELECT cost_usd::float8 AS "costUsd", estimated_cost_usd::float8 AS "estimatedCostUsd"
        FROM llm_calls WHERE project_id = ${projectId}`)).rows,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      if (row.costUsd === null) expect(row.estimatedCostUsd).toBeGreaterThan(0);
      else expect(row.costUsd).toBeGreaterThan(0);
    }
    expect(rows.filter((r) => r.costUsd === null)).toHaveLength(1);

    const [totals] = evidence.calls;
    expect(evidence.calls).toHaveLength(1);
    expect(totals).toMatchObject({ taskId: attemptTaskId, provider: "deepseek", calls: 3, measuredCalls: 2, zeroCostCalls: 0, cacheCountedCalls: 2, inputTokens: 4000, cacheReadTokens: 3000 });

    const report = formatRunReport(evidence);
    expect(report.zeroCostCalls).toBe(0);
    expect(report.text).toContain("deepseek: cache-hit share 75.0% (3000 cache-read of 4000 input tokens over 2 call(s); 1 call(s) without both counts excluded)");
    expect(report.text).toContain("cost measured on 2/3");
    expect(report.text).not.toMatch(/no model call|before any model call/);
    const line = (sid: string) => report.text.split("\n").find((l) => l.includes(sid)) ?? "";
    expect(line(idleSession)).toMatch(/\(Failed, .*\): no attempt recorded; it ended \(failed\) without an attempt outcome/);
    expect(line(openSession)).toMatch(/\(Preparing, .*\): no attempt recorded; the session is not terminal/);
    expect(line(orphanSession)).toContain("no attempt recorded; closed by startup-reconciler as a crash orphan");
    expect(line(oldSession)).toContain("no attempt recorded; the session predates the attempt columns");
    expect(line(deliveredSession)).toContain(`(Completed, `);
    expect(line(deliveredSession)).toContain(`no attempt; it completed without one, and its end record reads: ${deliveredDetail}`);
    expect(line(deliveredSession)).not.toMatch(/threw|before the model/);
    const recorded = sessions.find((s) => s.sessionId === attemptSession)?.attempt;
    expect(line(attemptSession)).toContain(
      `terminal finished:done, 3 turn(s), model deepseek/deepseek-scripted, base cell, prompt digest ${recorded?.kind === "recorded" ? recorded.attempt.promptDigest : "MISSING"}`,
    );
    // Every agent call was admitted inside the recorded attempt's session: the orphan opened later on the same task
    // and the sessions without an attempt elsewhere leave them tied.
    expect(evidence.tasks.find((t) => t.taskId === attemptTaskId)?.calls.map((c) => c.agentTurn)).toEqual([true, true, true]);
    expect(report.text).not.toContain("UNTIED:");
    expect(report.text).toContain("6 dev session(s), 1 with a recorded attempt, 5 without; 0 task(s) UNTIED");

    // An agent call admitted before every session of its task matches no attempt.
    await db.execute(sql`
      INSERT INTO llm_calls (id, project_id, task_id, call_site, provider, model, estimated_cost_usd, state, created_at)
      VALUES (${randomUUID()}, ${projectId}, ${idleTaskId}, 'agent-runner', 'deepseek', 'deepseek-scripted', 0.001, 'unmeasured_after_crash', '1999-01-01T00:00:00Z')`);
    const untied = formatRunReport(await readRunEvidence(db, projectId)).text;
    expect(untied).toContain("UNTIED: 1 of 1 agent call(s) on this task fall in no session with a recorded attempt (admitted at 1999-01-01T00:00:00.000Z)");
    expect(untied).toContain("1 task(s) UNTIED");
    await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId} AND created_at = '1999-01-01T00:00:00Z'`);
  });

  test("a call admitted and never recorded is told apart from a recorded call whose cost is unknown", async () => {
    const [, idleTaskId] = taskIds;
    if (idleTaskId === undefined) throw new Error("tasks not created");
    for (const state of ["pending", "unmeasured_after_crash"]) {
      await db.execute(sql`
        INSERT INTO llm_calls (id, project_id, task_id, call_site, provider, model, estimated_cost_usd, state)
        VALUES (${randomUUID()}, ${projectId}, ${idleTaskId}, 'attempt', 'deepseek', 'deepseek-scripted', 0.5, ${state})`);
    }
    const evidence = await readRunEvidence(db, projectId);
    expect(evidence.calls.find((c) => c.taskId === idleTaskId)).toMatchObject({ calls: 2, measuredCalls: 0, pendingCalls: 1, lostCalls: 1 });
    // The run's totals hold the earlier test's recorded call with no measured cost as well.
    expect(formatRunReport(evidence).text).toContain(
      "1 admitted and not yet recorded, 1 admitted by a process that ended before recording them, 1 recorded with no cost measured)",
    );
  });
});

// The body main() prints, read from this project end to end: every suite review judgement and claim
// through their readers. A body that left either reader out would print "none recorded" here.
describe("runReport, the body run-report prints", () => {
  async function completedTask(title: string): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${projectId})`);
    return id;
  }

  test("prints each suite review judgement, and each claim with its basis and the item it leaves unverified", async () => {
    const check = await completedTask("Checks of Durable put");
    const judged = parseWorkItemId(await completedTask("Review with a finding"), "test review task");
    const claimed = parseWorkItemId(await completedTask("Review that routed nothing"), "test review task");
    const finding = { checkTasks: [check], kind: "undecided-item" as const, item: "S8", problem: "no check reads the value back", evidence: "sh put.sh" };
    const first = { provider: "p", model: "m" };
    const judgements = new SuiteReviewJudgementRepository(db);
    await judgements.record({
      projectId,
      reviewTaskId: judged,
      judgements: [
        {
          checkTaskId: check,
          check: null,
          outcome: "advisory",
          basis: "second-opinion-disagreed",
          first: finding,
          second: [],
          firstModel: first,
          secondReview: { first, second: first, strength: "same-model" },
          passedOver: [],
          secondFailure: null,
          undecided: null,
        },
      ],
      claim: null,
    });
    await judgements.record({
      projectId,
      reviewTaskId: claimed,
      judgements: [],
      claim: {
        basis: "second-review-failed",
        covered: [check],
        firstModel: first,
        secondReview: null,
        passedOver: [],
        second: [],
        secondFailure: "no second opinion answered",
        unconfirmed: [{ checkTaskId: check, itemId: "S9", itemText: "put survives a power loss" }],
      },
    });

    const { text } = await runReport(db, projectId, { hidden: null, pick: null });

    expect(text).toContain(`run-report: project ${NAME} (${projectId})`);
    expect(text.split("\n").slice(1, 3)).toEqual(["tender pick: not recorded (run-report was given no --run)", "verdicts: Ashara gave no acceptance verdict (status active) | hidden suite: not run"]);
    expect(text).toContain(`Suite review judgements (1):\n  review ${judged}, its undecided-item finding of task ${check}: advisory (second-opinion-disagreed); second review same-model (first p/m, second p/m)`);
    expect(text).toContain(
      `Suite review claims (1):\n  review ${claimed}, covering check task(s) ${check}: second-review-failed (unconfirmed: the second opinion failed at every strength); second opinion: none (first p/m): no second opinion answered`,
    );
    expect(text).toContain(`    unverified S9 of task ${check} "put survives a power loss": no second opinion answered: no second opinion answered`);
  });
});
