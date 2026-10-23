import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ClientChanges, ClientMessageRepository, TenderIntake, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import type { ClientChangeStore, IntakeStore } from "@ashara/engagement";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import {
  FirstPlanner,
  PlanningService,
  ProjectHaltRepository,
  Replanner,
  WorkItemRowRepository,
  adaptWorkItemRepo,
  createFirstPlanStore,
  createReplanStore,
  failWorkItem,
  recoverFailedItem,
  replanWorkItem,
  startWorkItem,
} from "@ashara/delivery";
import type { FirstPlanStore, ReplanStore } from "@ashara/delivery";
import { parseWorkItemId, type ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createClientChangeStore } from "@ashara/server/client-change-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { createRoutes } from "@ashara/server/routes";
import { DevSessionRepository } from "@ashara/workplace";
import { citingItemsToCheck } from "../simulator/stand-ins/planner.js";
import { itemsToCheck } from "../simulator/stand-ins/recognised-wording.js";

// A client's correction holds and replaces only the work citing a guarantee it changes: with two
// tasks citing G1 and G2, a correction amending G2 lets the G1 task dispatch before the revision,
// supersedes the open G2 task for a new one citing the amended G2, and keeps a merged G2 task
// Completed beside the new one. Real Postgres; every model call is a MockLanguageModelV4 answering
// by what its prompt asks. Every row belongs to a project this suite creates under a unique name.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `correction-test-${randomUUID().slice(0, 8)}`;
const TENDER = "A key store. Clients put and get keys. A deleted key is gone.";
const AMENDED_G2 = "A deleted key is gone, and getting it prints that it was deleted.";

let db: ReturnType<typeof createDb>;
let gateway: GuardedModelAccess;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    thinkingOffCapabilityLevel: capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [], priceTiers: [], datedPrices: [],
  };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    usage: {
      inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: 200, reasoning: undefined },
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
  };
}

const guarantee = (id: string, statement: string, quote: string, at: string) => ({
  id,
  statement,
  observable: { interface: [at], observation: "output" },
  refutedBy: [`The product does not hold that ${statement}`],
  source: { kind: "tender", quote },
});

const INTAKE = {
  summary: "A key store.",
  interface: [
    { id: "I1", text: "kv put KEY VALUE; kv get KEY", source: { kind: "tender", quote: "Clients put and get keys." } },
    { id: "I2", text: "kv delete KEY", source: { kind: "tender", quote: "A deleted key is gone." } },
  ],
  guarantees: [
    guarantee("G1", "A get returns the value of the last put of its key.", "Clients put and get keys.", "I1"),
    guarantee("G2", "A deleted key is gone.", "A deleted key is gone.", "I2"),
  ],
  assumptions: [],
  questions: [],
  exclusions: [],
};

const ROSTER = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the client.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines how the store is built and tested.", capabilities: ["write-environment"] },
    { name: "Implementer", responsibility: "Builds the store.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the checks the store must pass.", capabilities: ["author-checks"] },
  ],
};

const task = (ref: string, title: string, cites: string) => ({
  ref,
  title,
  description: title,
  dependsOn: [],
  goal: title,
  endState: `${title}, end to end`,
  scope: `the ${ref} part of the store`,
  deliverables: [{ text: title, sources: [cites] }],
  acceptance: [{ text: `a client sees: ${title}`, sources: [cites] }],
  capability: "Medium",
  capabilityReason: "graded for the test",
});

const FIRST_TASKS = { tasks: [task("t1", "Put and get keys", "G1"), task("t2", "Delete keys", "G2")] };
const REVISED_TASKS = { tasks: [task("t1", "Tell a deleted key's get it was deleted", "G2")] };

/** The client's correction of G2, as the Liaison's reading of their message returns it. */
const AMEND_G2 = {
  ops: [
    {
      op: "amend-guarantee",
      id: "G2",
      statement: AMENDED_G2,
      interface: ["I2"],
      observation: "output",
      // Every refuting observation G2 had, and one more: it widens, so no confirmation is asked.
      refutedBy: ["The product does not hold that A deleted key is gone.", "a get after a delete prints no word of the deletion"],
      direction: "widens",
    },
  ],
  confirms: [],
};

/** The client's correction of interface entry I2 alone, which only G2 is observed at. */
const AMEND_I2 = { ops: [{ op: "amend-interface", id: "I2", text: "kv delete KEY; kv deleted KEY", direction: "neutral" }], confirms: [] };

/** The client's new exclusion, which no task cites and every guarantee is planned beside. */
const ADD_EXCLUSION = { ops: [{ op: "add-exclusion", text: "No key expires by itself.", direction: "narrows" }], confirms: [] };

/** The client's new guarantee observed at I2, and a correction of I2 itself: the new guarantee is observed at I2 only in the version written. */
const ADD_AT_I2 = {
  ops: [
    {
      op: "add-guarantee",
      statement: "Deleting a key that is not there says so.",
      interface: ["I2"],
      observation: "output",
      refutedBy: ["a delete of a missing key prints nothing"],
      direction: "widens",
    },
    { op: "amend-interface", id: "I2", text: "kv delete KEY, which names a missing KEY", direction: "neutral" },
  ],
  confirms: [],
};

type Reading = typeof AMEND_G2 | typeof AMEND_I2 | typeof ADD_EXCLUSION | typeof ADD_AT_I2 | { readonly ops: readonly object[]; readonly confirms: readonly string[] };

/** One model for every call, answering each by what its prompt asks; returns it to read the prompts sent. */
function pipelineModel(reading: Reading = AMEND_G2): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      if (prompt.includes("The client sent a message changing what they want built")) return jsonResult({ correction: reading });
      if (prompt.includes("needs the project environment changed")) return jsonResult({ environmentChange: false, reason: "Only what a get prints changes." });
      if (prompt.includes("changed what is built after work began")) return jsonResult(citingItemsToCheck(REVISED_TASKS, prompt));
      return jsonResult(citingItemsToCheck(FIRST_TASKS, prompt));
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.string(),
  status: z.string(),
  origin: z.string().nullable(),
  reason: z.unknown(),
  sources: z.array(z.object({ id: z.string(), text: z.string() }).loose()).nullable(),
});

async function itemsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT id, title, level, status, task_spec->>'origin' AS origin, blocked_reason AS reason, task_spec->'sources' AS sources
    FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(ItemSchema).parse(result.rows);
}

/** Starts a task as dispatch does: the task and every Pending ancestor, its Epic, go InProgress. */
async function startTask(id: string): Promise<void> {
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const item = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (item === null) throw new Error(`task ${id} not found`);
  startWorkItem(item);
  await PlanningService.saveWorkItem(repo, item, "Pending");
  await PlanningService.activateAncestors(repo, item.parentId);
}

async function completeTask(id: string): Promise<void> {
  await startTask(id);
  await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(id, "test"), "passed");
}

/** The tasks the dispatch gate admits now, of this suite's projects, as the core loop gates them. */
async function dispatchable(): Promise<string[]> {
  const projects = new ProjectHaltRepository(db);
  const gated = await PlanningService.gate(
    adaptWorkItemRepo(new WorkItemRowRepository(db)),
    { listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)), block: (id, cause) => projects.block(id, cause) },
    { publish: async () => {} },
    memoryStepContainment(() => true),
    recordingLogger(),
  );
  return gated.available.map((item) => item.id);
}

/**
 * A key store planned from G1 and G2 and told to the client: Sprint 0, the layout, the check tasks and
 * the review are done, so the tasks citing G1 and G2 are each ready to dispatch; or, with
 * `reviewDone` false, all but the review, which every goal task waits on.
 */
async function readyProject(reviewDone = true): Promise<{ readonly projectId: ProjectId; readonly g1: string; readonly g2: string; readonly review: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  const projectId = created.project.id;
  ourProjects.add(projectId);
  pipelineModel();
  const intakeStore = createIntakeStore(db);
  const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
  expect((await new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const rosterStore = createRosterStore(db);
  const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
  expect((await new RosterDerivation({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const planStore = createFirstPlanStore(db);
  const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
  expect((await new FirstPlanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment: memoryStepContainment(() => true), llm: gateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
  await db.execute(sql`
    INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
    VALUES (${projectId}, 'outbound', 'report', 'The plan.', 'first-plan')`);

  const items = await itemsOf(projectId);
  for (const done of items.filter((i) => i.level === "Task" && i.origin !== "decomposition" && (reviewDone || i.origin !== "review"))) await completeTask(done.id);
  const review = items.find((i) => i.origin === "review");
  if (review === undefined) throw new Error("the first plan has no review task");
  const citing = (key: string) => {
    const found = items.find((i) => i.origin === "decomposition" && i.sources?.some((s) => s.id === key) === true);
    if (found === undefined) throw new Error(`the first plan has no task citing ${key}`);
    return found.id;
  };
  return { projectId, g1: citing("G1"), g2: citing("G2"), review: review.id };
}

/** The client's change, read by the Liaison the cycle it arrives as `reading`: by default, amending G2. */
async function amendG2(projectId: ProjectId, reading: Reading = AMEND_G2): Promise<string> {
  const change = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body: "Getting a deleted key should say it was deleted.", inReplyTo: null });
  pipelineModel(reading);
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  const narrowed: ClientChangeStore = { ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) };
  const outcomes = await new ClientChanges({ shutdownSignal: new AbortController().signal, llm: gateway, store: narrowed, containment: memoryStepContainment(() => true) }).runPending();
  expect(outcomes).toMatchObject([{ kind: "recorded", changeId: change.id, revision: { status: "applied", visionVersion: 2 } }]);
  return change.id;
}

function replanner(): Replanner {
  const store = createReplanStore(db, recordingLogger());
  const narrowed: ReplanStore = { ...store, projectsAwaitingReplan: ours(() => store.projectsAwaitingReplan()) };
  return new Replanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment: memoryStepContainment(() => true), llm: gateway, store: narrowed });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = new GuardedModelAccess(
    buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          {
            name: "deepseek",
            providerType: "deepseek",
            apiKey: "test-key",
            baseUrl: "https://stub.invalid/v1",
            models: [model("correction-strong", "Strong"), model("correction-frontier", "Frontier")],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }),
    new LlmCallLedger(new LlmCallRepository(db), new SpendCap({ ledger: new LlmCallRepository(db), caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } })),
    recordingLogger(),
  );
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a client's correction holds and replaces only the work citing what it changes", () => {
  test("the G1 task dispatches before the revision; the G2 task is held, then superseded by a new task citing the amended G2", async () => {
    const { projectId, g1, g2 } = await readyProject();
    expect((await dispatchable()).sort()).toEqual([g1, g2].sort());

    const changeId = await amendG2(projectId);

    // Before any revision: the task citing G1 alone is still dispatched, the one citing G2 is not.
    expect(await dispatchable()).toEqual([g1]);
    await startTask(g1);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({
      status: "Blocked",
      reason: { source: "correction_pending", visionVersion: 2, affected: ["G2"] },
    });

    // The revision waits for no task outside what the correction touches: the G1 task is in progress.
    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "client-change" }]);
    const revisionPrompt = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("changed what is built after work began"));
    expect(revisionPrompt).toContain(AMENDED_G2);

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === g1)).toMatchObject({ status: "InProgress" });
    expect(after.find((i) => i.id === g2)).toMatchObject({ status: "Abandoned", reason: { source: "superseded", planRevision: 2, requestedBy: changeId } });
    const added = after.filter((i) => i.origin === "decomposition" && i.id !== g1 && i.id !== g2);
    expect(added.map((i) => i.title)).toEqual(["Tell a deleted key's get it was deleted"]);
    expect(added[0]?.sources).toEqual([expect.objectContaining({ id: "G2", text: AMENDED_G2 })]);
    // Nothing citing G1 alone was replaced.
    expect(after.filter((i) => i.status === "Abandoned" && i.sources?.every((s) => s.id === "G1") === true)).toEqual([]);
    const released = await db.execute(sql`SELECT plan_revision_id IS NOT NULL AS released FROM correction_holds WHERE project_id = ${projectId}`);
    expect(released.rows).toEqual([{ released: true }]);
  });

  test("a merged G2 task stays Completed, and the amended G2 gets a new task beside it", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await completeTask(g2);
    // Its stored check decided G2 as it read then: the amended G2 is not decided by it.
    const checkTask = (await itemsOf(projectId)).find((i) => i.origin === "check" && i.sources?.some((s) => s.id === "G2") === true);
    if (checkTask === undefined) throw new Error("the first plan has no check task for G2");
    await db.execute(sql`
      INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
      VALUES (${projectId}, ${g2}, ${checkTask.id}, 1, 'deleted key is gone', 'true', '[]'::jsonb, ${"e".repeat(64)}, '["G2"]'::jsonb)`);

    await amendG2(projectId);
    expect(await dispatchable()).toEqual([g1]);
    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === g2)).toMatchObject({ status: "Completed" });
    expect(after.find((i) => i.id === g1)).toMatchObject({ status: "Pending", reason: null });
    const added = after.filter((i) => i.origin === "decomposition" && i.id !== g1 && i.id !== g2);
    expect(added).toMatchObject([{ status: "Pending", sources: [expect.objectContaining({ id: "G2", text: AMENDED_G2 })] }]);
  });
});

/**
 * Returns a task in progress to Pending as a requeue writes it (an orphan the startup reconciler
 * finds, a refused model call): its attempt ended with no verdict, so nothing else about it changes.
 */
async function requeue(id: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE work_items SET status = 'Pending', updated_at = now() WHERE id = ${id} AND status = 'InProgress' RETURNING id`);
  expect(result.rows).toHaveLength(1);
}

/** Fails a task's attempt in progress and returns it to Pending for its next attempt, as the failure router's retry does. */
async function failAndRetry(id: string): Promise<void> {
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const item = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (item === null) throw new Error(`task ${id} not found`);
  failWorkItem(item, { source: "task_failed", reason: "its checks did not pass" }, { kind: "retryable", ground: "work" });
  await PlanningService.saveWorkItem(repo, item, "InProgress");
  replanWorkItem(item, null);
  await PlanningService.saveWorkItem(repo, item, "Failed");
}

describe("a correction holds every task citing what it changes, whatever the task's status", () => {
  test("a citing task in progress when the correction lands is held once requeued, and the revision waits for it while it runs", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await startTask(g2);
    await amendG2(projectId);
    // The revision waits for the citing task in progress, and for nothing else.
    pipelineModel();
    expect(await replanner().runPending()).toEqual([]);

    await requeue(g2);
    expect(await dispatchable()).toEqual([g1]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({
      status: "Blocked",
      reason: { source: "correction_pending", visionVersion: 2, affected: ["G2"] },
    });
    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Abandoned", reason: { source: "superseded", planRevision: 2 } });
  });

  test("a citing task whose attempt fails after the correction lands is held when it is retried", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await startTask(g2);
    await amendG2(projectId);
    await failAndRetry(g2);

    expect(await dispatchable()).toEqual([g1]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Blocked", reason: { source: "correction_pending" } });
  });

  // A held task in progress finishes its attempt and merges: its merge is not taken as meeting the
  // corrected guarantee, since the revision waits for it and then plans the amended G2 again beside it.
  test("a citing task in progress merges, and the amended guarantee still gets a task of its own", async () => {
    const { projectId, g2 } = await readyProject();
    await startTask(g2);
    await amendG2(projectId);
    pipelineModel();
    expect(await replanner().runPending()).toEqual([]);
    await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(g2, "test"), "passed");

    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);
    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === g2)).toMatchObject({ status: "Completed" });
    const added = after.filter((i) => i.origin === "decomposition" && i.status === "Pending" && i.sources?.some((s) => s.id === "G2") === true);
    expect(added).toMatchObject([{ sources: [expect.objectContaining({ id: "G2", text: AMENDED_G2 })] }]);
  });
});

describe("a correction of an interface entry or an exclusion reaches the tasks planned on it", () => {
  test("amending the interface entry G2 is observed at holds the task citing G2, and only it", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await amendG2(projectId, AMEND_I2);
    const holds = await db.execute(sql`SELECT affected FROM correction_holds WHERE project_id = ${projectId}`);
    expect(holds.rows).toEqual([{ affected: ["G2"] }]);
    expect(await dispatchable()).toEqual([g1]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Blocked", reason: { source: "correction_pending", affected: ["G2"] } });
  });

  test("a new exclusion holds every task citing a guarantee: no record says which one it bounds", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await amendG2(projectId, ADD_EXCLUSION);
    const holds = await db.execute(sql`SELECT affected FROM correction_holds WHERE project_id = ${projectId}`);
    expect(holds.rows).toEqual([{ affected: ["G1", "G2"] }]);
    expect(await dispatchable()).toEqual([]);
    const after = await itemsOf(projectId);
    for (const id of [g1, g2]) expect(after.find((i) => i.id === id)).toMatchObject({ status: "Blocked", reason: { source: "correction_pending" } });
  });
});

/** Stores a check of `taskId` deciding G2 as its check task wrote it before any correction. */
async function storeG2Check(projectId: ProjectId, taskId: string): Promise<void> {
  const checkTask = (await itemsOf(projectId)).find((i) => i.origin === "check" && i.sources?.some((s) => s.id === "G2") === true);
  if (checkTask === undefined) throw new Error("the first plan has no check task for G2");
  await db.execute(sql`
    INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
    VALUES (${projectId}, ${taskId}, ${checkTask.id}, 1, 'deleted key is gone', 'true', '[]'::jsonb, ${"e".repeat(64)}, '["G2"]'::jsonb)`);
}

/** The open tasks the revision added citing G2. */
async function newG2Tasks(projectId: ProjectId, g2: string) {
  return (await itemsOf(projectId)).filter((i) => i.origin === "decomposition" && i.id !== g2 && i.status === "Pending" && i.sources?.some((s) => s.id === "G2") === true);
}

// G2's statement is unchanged by an interface correction: a check stored against the old interface
// still names G2 as its text reads, and is not taken as deciding G2 under the corrected interface.
describe("work on a guarantee whose interface entry a correction changed is planned again", () => {
  test("a citing task in progress merges with checks deciding G2, and G2 still gets a task against the corrected interface", async () => {
    const { projectId, g2 } = await readyProject();
    await startTask(g2);
    await amendG2(projectId, AMEND_I2);
    pipelineModel();
    expect(await replanner().runPending()).toEqual([]);
    await storeG2Check(projectId, g2);
    await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(g2, "test"), "passed");

    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);
    const revisionPrompt = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("changed what is built after work began"));
    expect(revisionPrompt).toContain("kv deleted KEY");
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Completed" });
    expect(await newG2Tasks(projectId, g2)).toHaveLength(1);
  });

  test("a citing task merged before the correction stays Completed, and G2 gets a task against the corrected interface", async () => {
    const { projectId, g2 } = await readyProject();
    await completeTask(g2);
    await storeG2Check(projectId, g2);
    await amendG2(projectId, AMEND_I2);

    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Completed" });
    expect(await newG2Tasks(projectId, g2)).toHaveLength(1);
  });
});

describe("a correction before the review completes", () => {
  test("replaces the review and the task citing G2, and keeps the G1 task, waiting on the revision's own review", async () => {
    const { projectId, g1, g2, review } = await readyProject(false);
    await amendG2(projectId);
    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === g2)).toMatchObject({ status: "Abandoned", reason: { source: "superseded" } });
    expect(after.find((i) => i.id === review)).toMatchObject({ status: "Abandoned", reason: { source: "superseded" } });
    expect(after.find((i) => i.id === g1)).toMatchObject({ status: "Pending", reason: null });
    // G1 is planned once: the revision plans only the amended G2.
    expect(after.filter((i) => i.origin === "decomposition" && i.status !== "Abandoned" && i.sources?.some((s) => s.id === "G1") === true).map((i) => i.id)).toEqual([g1]);
    const reviews = after.filter((i) => i.origin === "review" && i.status === "Pending");
    expect(reviews).toHaveLength(1);
    const waits = await db.execute(sql`SELECT to_id AS "to" FROM dependencies WHERE from_id = ${g1}`);
    const waitedOn = z.array(z.object({ to: z.string() })).parse(waits.rows).map((row) => row.to);
    expect(waitedOn).toContain(reviews[0]?.id);
    expect(waitedOn).not.toContain(review);
  });
});

describe("no path outside the correction gate starts or replaces a task the correction holds", () => {
  test("an operator's start of a held task back at Pending is refused with 409 and leaves it Pending", async () => {
    const { projectId, g2 } = await readyProject();
    await startTask(g2);
    await amendG2(projectId);
    await requeue(g2);

    const app = new Hono();
    app.route(
      "/",
      createRoutes({
        workItemRepo: new WorkItemRowRepository(db),
        eventStore: new EventStoreRepository(db),
        devSessionRepo: new DevSessionRepository(db),
        visionRepo: new VisionRepository(db),
        projectRepo: new ProjectHaltRepository(db),
        clientMessageRepo: new ClientMessageRepository(db),
        clientRepo: new ClientRepository(db),
        createTender: async () => {
          throw new Error("no tender is sent in this test");
        },
      }),
    );
    const res = await app.request(`/work-items/${g2}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "InProgress" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ heldBy: { visionVersion: 2, affected: ["G2"] } });
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Pending" });
  });

  test("a task merged on main with its record unwritten (merge_unrecorded) is kept, and the amended G2 gets a new task", async () => {
    const { projectId, g2 } = await readyProject();
    await startTask(g2);
    const unrecorded = { source: "merge_unrecorded", mergeCommit: "a".repeat(40), mergeKind: "merged", reason: "the merge record could not be written" };
    const parked = await db.execute(sql`
      UPDATE work_items SET status = 'Blocked', updated_at = now(), blocked_reason = ${JSON.stringify(unrecorded)}::jsonb
      WHERE id = ${g2} AND status = 'InProgress' RETURNING id`);
    expect(parked.rows).toHaveLength(1);
    await amendG2(projectId);

    pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2 }]);
    expect((await itemsOf(projectId)).find((i) => i.id === g2)).toMatchObject({ status: "Blocked", reason: { source: "merge_unrecorded" } });
    expect(await newG2Tasks(projectId, g2)).toMatchObject([{ sources: [expect.objectContaining({ id: "G2", text: AMENDED_G2 })] }]);
  });

  test("the impact note names every key the correction holds, a guarantee observed at a corrected entry only in the version written included", async () => {
    const { projectId } = await readyProject();
    const changeId = await amendG2(projectId, ADD_AT_I2);
    const holds = z.array(z.object({ affected: z.array(z.string()) })).parse((await db.execute(sql`SELECT affected FROM correction_holds WHERE project_id = ${projectId}`)).rows);
    expect(holds).toHaveLength(1);
    const held = holds[0]?.affected ?? [];
    expect(held.length).toBeGreaterThan(1);

    const notes = z.array(z.object({ body: z.string() })).parse((await db.execute(sql`SELECT body FROM client_messages WHERE in_reply_to = ${changeId} AND direction = 'outbound'`)).rows);
    expect(notes).toHaveLength(1);
    const named = /^Affected: (.+)\. Work citing/m.exec(notes[0]?.body ?? "")?.[1]?.split(/, | and /) ?? [];
    expect([...named].sort()).toEqual([...held].sort());
  });
});

/** The client's withdrawal of G2, which narrows the contract. */
const WITHDRAW_G2 = { ops: [{ op: "withdraw-guarantee", id: "G2", direction: "narrows" }], confirms: [] };

/** The client's confirmation of the change Ashara held as P1, asking nothing else. */
const CONFIRM_P1 = { ops: [], confirms: ["P1"] };

/** Parks a task in progress as a merge whose record could not be written: its work is on main, its status Blocked. */
async function parkUnrecorded(id: string): Promise<void> {
  await startTask(id);
  const unrecorded = { source: "merge_unrecorded", mergeCommit: "a".repeat(40), mergeKind: "merged", reason: "the merge record could not be written" };
  const parked = await db.execute(sql`
    UPDATE work_items SET status = 'Blocked', updated_at = now(), blocked_reason = ${JSON.stringify(unrecorded)}::jsonb
    WHERE id = ${id} AND status = 'InProgress' RETURNING id`);
  expect(parked.rows).toHaveLength(1);
}

/** Stores a check of the task's check task that decides `key`, as the check author's merged suite records it. */
async function storeCheckDeciding(projectId: ProjectId, taskId: string, key: string): Promise<void> {
  const checkTask = (await itemsOf(projectId)).find((i) => i.origin === "check" && i.sources?.some((s) => s.id === key) === true);
  if (checkTask === undefined) throw new Error(`the first plan has no check task for ${key}`);
  await db.execute(sql`
    INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
    VALUES (${projectId}, ${taskId}, ${checkTask.id}, 1, ${`${key} holds`}, 'true', '[]'::jsonb, ${"e".repeat(64)}, ${JSON.stringify([key])}::jsonb)`);
}

/** Starts, fails and gives up a task as a dispatch's failure and the failure router's abandonment do, which opens a plan repair. */
async function giveUp(id: string): Promise<void> {
  await startTask(id);
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const item = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (item === null) throw new Error(`task ${id} not found`);
  failWorkItem(item, { source: "task_failed", reason: "its checks did not pass" }, { kind: "retryable", ground: "work" });
  await PlanningService.saveWorkItem(repo, item, "InProgress");
  const failure = { detail: "its checks kept failing", raw: {} };
  const decision = await recoverFailedItem(
    {
      logger: recordingLogger(),
      workItemRepo: repo,
      eventPublisher: { publish: async () => {} },
      failureRouter: { route: () => ({ action: "abandon", reason: "the task failed 3 time(s)", attempts: 3, failure }) },
    },
    item,
    failure,
    { kind: "retryable", ground: "work" },
  );
  expect(decision).toBe("abandon");
}

/** A model for a repair: the environment stands, and the planner plans only the first plan's tasks citing an item the prompt says is still to check. */
function repairModel(): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("environmentChange")) return jsonResult({ environmentChange: false, reason: "The work failed, not the environment." });
      const toCheck = itemsToCheck(prompt);
      const tasks = FIRST_TASKS.tasks.filter((t) => t.acceptance.some((line) => line.sources.some((source) => toCheck.includes(source))));
      return jsonResult(citingItemsToCheck({ tasks }, prompt));
    },
  });
  stub.model = mock;
  return mock;
}

/** The client's change read as `reading`; returns its id and the outcome the Liaison records. */
async function sendChange(projectId: ProjectId, body: string, reading: Reading) {
  const change = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body, inReplyTo: null });
  pipelineModel(reading);
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  const narrowed: ClientChangeStore = { ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) };
  const outcomes = await new ClientChanges({ shutdownSignal: new AbortController().signal, llm: gateway, store: narrowed, containment: memoryStepContainment(() => true) }).runPending();
  const notes = z.array(z.object({ body: z.string() })).parse((await db.execute(sql`SELECT body FROM client_messages WHERE in_reply_to = ${change.id} AND direction = 'outbound'`)).rows);
  expect(notes).toHaveLength(1);
  return { changeId: change.id, outcomes, note: notes[0]?.body ?? "" };
}

// A task merged on main whose merge record could not be written (Blocked, merge_unrecorded) is merged
// work to every correction reader: a repair keeps it and does not plan its key again, and a correction
// withdrawing its guarantee is held for the client's confirmation as one withdrawing merged work.
describe("merged work with its record unwritten counts as merged everywhere a correction reads it", () => {
  test("a repair keeps it as done and plans no new task for the key its checks decide", async () => {
    const { projectId, g1, g2 } = await readyProject();
    await parkUnrecorded(g2);
    await storeCheckDeciding(projectId, g2, "G2");
    await giveUp(g1);

    const mock = repairModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const planning = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("Plan the work still to do again"));
    if (planning === undefined) throw new Error("the repair asked the planner nothing");
    expect(planning).toContain("Already done, and kept as it is");
    expect(planning).toContain("- Delete keys");
    expect(itemsToCheck(planning)).toContain("G1");
    expect(itemsToCheck(planning)).not.toContain("G2");

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === g2)).toMatchObject({ status: "Blocked", reason: { source: "merge_unrecorded" } });
    expect(await newG2Tasks(projectId, g2)).toEqual([]);
  });

  test("a withdrawal of its guarantee is pushed back, and the message confirming it names the key it affects", async () => {
    const { projectId, g2 } = await readyProject();
    await parkUnrecorded(g2);

    const withdrawn = await sendChange(projectId, "Drop the deleting.", WITHDRAW_G2);
    expect(withdrawn.outcomes).toMatchObject([
      { kind: "recorded", changeId: withdrawn.changeId, revision: { status: "proposed", direction: "narrows", pushback: { reasons: [{ kind: "merged-guarantee", guarantees: ["G2"] }] } } },
    ]);
    expect(withdrawn.note).toContain("Delete keys (merged)");
    expect(withdrawn.note).toContain("G2 is already delivered");

    const confirmed = await sendChange(projectId, "Yes, drop it.", CONFIRM_P1);
    expect(confirmed.outcomes).toMatchObject([{ kind: "recorded", changeId: confirmed.changeId, confirmed: [expect.any(String)] }]);
    expect(confirmed.note).toContain("You confirmed the change held as P1; it is now part of the contract as version 2. It affects G2.");
  });
});
