import { randomUUID } from "crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "./connection.js";
import { WorkItemRepository } from "./repositories/work-item.js";
import { DevSessionRepository } from "./repositories/dev-session.js";
import { EventStoreRepository } from "./repositories/event-store.js";
import { VisionRepository } from "./repositories/vision.js";
import { ConfigRepository } from "./repositories/config.js";
import { KnowledgeRepository } from "./repositories/knowledge.js";
import { CostRepository } from "./repositories/cost.js";
import { FailedApproachRepository } from "./repositories/failed-approach.js";
import {
  devSessions,
  domainEvents,
  knowledgeEntries,
  taskCostHistory,
  failedApproaches,
  modelConfigs,
  providerConfigs,
  systemSettings,
  visionDocuments,
} from "./schema.js";

// ---------------------------------------------------------------------------
// One insert -> read round trip per repository, against real Postgres
// (DB-specific mechanics -- SQL types, jsonb, defaults, FK wiring -- that a
// mocked Database can't verify). Business-rule and state-machine coverage
// lives in unit tests closer to the domain (e.g. planning/domain).
// ---------------------------------------------------------------------------

let db: Database;

const createdWorkItemIds: string[] = [];
const createdDevSessionIds: string[] = [];
const createdEventIds: string[] = [];
const createdVisionIds: string[] = [];
const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];
const createdSettingKeys: string[] = [];
const createdKnowledgeIds: string[] = [];
const createdCostIds: string[] = [];
const createdFailedApproachTaskIds: string[] = [];

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await cleanupAll();
  const pool = db.$client;
  if (pool && typeof pool.end === "function") {
    await pool.end();
  }
});

async function cleanupAll() {
  for (const taskId of createdFailedApproachTaskIds) {
    await db.execute(sql`DELETE FROM failed_approaches WHERE task_id = ${taskId}`);
  }
  for (const id of createdKnowledgeIds) {
    await db.execute(sql`DELETE FROM knowledge_entries WHERE id = ${id}`);
  }
  for (const id of createdCostIds) {
    await db.execute(sql`DELETE FROM task_cost_history WHERE id = ${id}`);
  }
  for (const key of createdSettingKeys) {
    await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`);
  }
  for (const modelId of createdModelIds) {
    await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${modelId}`);
  }
  for (const name of createdProviderNames) {
    await db.execute(sql`DELETE FROM provider_configs WHERE name = ${name}`);
  }
  for (const id of createdVisionIds) {
    await db.execute(sql`DELETE FROM vision_documents WHERE id = ${id}`);
  }
  for (const id of createdEventIds) {
    await db.execute(sql`DELETE FROM domain_events WHERE event_id = ${id}`);
  }
  for (const id of createdDevSessionIds) {
    await db.execute(sql`DELETE FROM dev_sessions WHERE id = ${id}`);
  }
  // Reverse creation order so children are gone before parents.
  for (const id of [...createdWorkItemIds].reverse()) {
    await db.execute(sql`DELETE FROM work_items WHERE id = ${id}`);
  }
}

// ---------------------------------------------------------------------------
// 1. WorkItemRepository
// ---------------------------------------------------------------------------

describe("WorkItemRepository", () => {
  let repo: WorkItemRepository;
  const epicId = randomUUID();

  beforeAll(() => {
    repo = new WorkItemRepository(db);
  });

  test("create inserts a work item and findById reads it back", async () => {
    const item = {
      id: epicId,
      level: "Epic",
      status: "Pending",
      parentId: null,
      title: "Integration Test Epic",
      description: "Epic for integration testing",
      taskSpec: { type: "test" },
      northStar: "Verify all repos work",
      successCriteria: ["tests pass"],
      blockedReason: null,
      runScope: "test-run",
    };
    createdWorkItemIds.push(epicId);

    const created = await repo.create(item);
    expect(created.id).toBe(epicId);
    expect(created.title).toBe("Integration Test Epic");
    expect(created.taskSpec).toEqual({ type: "test" });

    const row = await repo.findById(epicId);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(epicId);
    expect(row!.title).toBe("Integration Test Epic");
    expect(row!.status).toBe("Pending");
  });
});

// ---------------------------------------------------------------------------
// 2. DevSessionRepository
// ---------------------------------------------------------------------------

describe("DevSessionRepository", () => {
  let repo: DevSessionRepository;
  const taskId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    repo = new DevSessionRepository(db);

    // DevSession requires a valid work_items FK.
    const wiRepo = new WorkItemRepository(db);
    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Pending",
      title: "Task for DevSession test",
      runScope: "test-run",
    });
    createdWorkItemIds.push(taskId);
  });

  test("insert creates a session and it can be read back", async () => {
    const brief = { instructions: "do something" };
    await repo.insert(sessionId, taskId, brief);
    createdDevSessionIds.push(sessionId);

    const [row] = await db
      .select()
      .from(devSessions)
      .where(sql`${devSessions.id} = ${sessionId}`)
      .limit(1);

    expect(row).toBeDefined();
    expect(row.id).toBe(sessionId);
    expect(row.taskId).toBe(taskId);
    expect(row.phase).toBe("Preparing");
    expect(row.brief).toEqual(brief);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// 3. EventStoreRepository
// ---------------------------------------------------------------------------

describe("EventStoreRepository", () => {
  let repo: EventStoreRepository;
  const eventId = randomUUID();

  beforeAll(() => {
    repo = new EventStoreRepository(db);
  });

  test("publish inserts an event and it can be read back", async () => {
    const event = {
      eventId,
      eventType: "TestEvent",
      timestamp: new Date(),
      sourceContext: "integration-test",
      correlationId: randomUUID(),
      payload: { key: "value", nested: { a: 1 } },
    };
    await repo.publish(event);
    createdEventIds.push(eventId);

    const [row] = await db
      .select()
      .from(domainEvents)
      .where(sql`${domainEvents.eventId} = ${eventId}`)
      .limit(1);

    expect(row).toBeDefined();
    expect(row.eventId).toBe(eventId);
    expect(row.eventType).toBe("TestEvent");
    expect(row.sourceContext).toBe("integration-test");
    expect(row.payload).toEqual({ key: "value", nested: { a: 1 } });
    expect(row.timestamp).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// 4. VisionRepository
// ---------------------------------------------------------------------------

describe("VisionRepository", () => {
  let repo: VisionRepository;

  beforeAll(() => {
    repo = new VisionRepository(db);
  });

  test("create inserts a vision document that reads back by id", async () => {
    const doc = {
      visionText: "Integration test vision text",
      summary: "Test summary",
      inferences: { key: "val" },
      scopeBoundaries: ["boundary1"],
      confirmedDirections: ["direction1"],
      userAnswers: [{ q: "question", a: "answer" }],
      openQuestions: ["what else?"],
      changeReason: "initial test creation",
    };

    const created = await repo.create(doc);
    createdVisionIds.push(created.id);

    expect(created.visionText).toBe("Integration test vision text");
    expect(typeof created.version).toBe("number");

    const [row] = await db.select().from(visionDocuments).where(eq(visionDocuments.id, created.id));
    expect(row).toBeDefined();
    expect(row!.summary).toBe("Test summary");
    expect(row!.inferences).toEqual({ key: "val" });
  });
});

// ---------------------------------------------------------------------------
// 5. ConfigRepository
// ---------------------------------------------------------------------------

describe("ConfigRepository", () => {
  let repo: ConfigRepository;
  const testProviderName = `test-provider-${randomUUID().slice(0, 8)}`;
  const testModelId = `test-model-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    repo = new ConfigRepository(db);
  });

  test("providers and model configs each round-trip through their table", async () => {
    createdProviderNames.push(testProviderName);
    await db.insert(providerConfigs).values({
      name: testProviderName,
      providerType: "openai-compatible",
      apiKey: "sk-test-key-12345",
      baseUrl: "http://localhost:11434/v1",
    });
    const providers = await repo.listProviderConfigs();
    const provider = providers.find((p) => p.name === testProviderName);
    expect(provider?.providerType).toBe("openai-compatible");
    expect(provider?.apiKey).toBe("sk-test-key-12345");

    createdModelIds.push(testModelId);
    await db.insert(modelConfigs).values({
      modelId: testModelId,
      providerName: testProviderName,
      capability: "Strong",
      inputCostPer1m: 3.0,
      outputCostPer1m: 0,
      maxContextTokens: 128000,
    });
    const models = await repo.listModelConfigs();
    const model = models.find((m) => m.modelId === testModelId);
    expect(model?.providerName).toBe(testProviderName);
    expect(model?.capability).toBe("Strong");
  });

  test("getSetting returns the value for an existing key", async () => {
    const key = `test-getsetting-${randomUUID().slice(0, 8)}`;
    createdSettingKeys.push(key);
    await db.insert(systemSettings).values({ key, value: "hello" });
    expect(await repo.getSetting(key)).toBe("hello");
  });

  test("getSetting returns null for a missing key", async () => {
    expect(await repo.getSetting("nonexistent-key-xyz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. KnowledgeRepository
// ---------------------------------------------------------------------------

describe("KnowledgeRepository", () => {
  let repo: KnowledgeRepository;
  const epicId = randomUUID();
  const taskId = randomUUID();

  beforeAll(async () => {
    repo = new KnowledgeRepository(db);

    const wiRepo = new WorkItemRepository(db);
    await wiRepo.create({
      id: epicId,
      level: "Epic",
      status: "Pending",
      title: "Knowledge Test Epic",
      runScope: "test-run",
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Completed",
      parentId: epicId,
      title: "Knowledge Test Task",
      runScope: "test-run",
    });
    createdWorkItemIds.push(taskId);
  });

  test("storeKnowledgeFinding inserts a finding and it can be read back", async () => {
    await repo.storeKnowledgeFinding(
      taskId,
      epicId,
      "Test Finding Title",
      "This is a test finding content for integration tests",
      ["test", "integration"],
    );

    const rows = await db
      .select()
      .from(knowledgeEntries)
      .where(sql`${knowledgeEntries.sourceTaskId} = ${taskId} AND ${knowledgeEntries.kind} = 'finding'`);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    createdKnowledgeIds.push(row.id);

    expect(row.title).toBe("Test Finding Title");
    expect(row.content).toBe("This is a test finding content for integration tests");
    expect(row.epicId).toBe(epicId);
    expect(row.sourceTaskId).toBe(taskId);
    expect(row.tags).toEqual(["test", "integration"]);
  });
});

// ---------------------------------------------------------------------------
// 7. CostRepository
// ---------------------------------------------------------------------------

describe("CostRepository", () => {
  let repo: CostRepository;
  const taskId = randomUUID();

  beforeAll(() => {
    // taskCostHistory.taskId has no FK constraint, so no work item is needed.
    repo = new CostRepository(db);
  });

  test("recordTaskCost inserts a cost record and it can be read back", async () => {
    await repo.recordTaskCost(taskId, "coding", 1500, 500, 0.0045, "test-model-id", true, 1);

    const rows = await db
      .select()
      .from(taskCostHistory)
      .where(sql`${taskCostHistory.taskId} = ${taskId}`);

    expect(rows.length).toBe(1);
    createdCostIds.push(rows[0].id);

    expect(rows[0].capability).toBe("coding");
    expect(rows[0].inputTokens).toBe(1500);
    expect(rows[0].outputTokens).toBe(500);
    expect(rows[0].actualCostUsd).toBe(0.0045);
    expect(rows[0].modelId).toBe("test-model-id");
    expect(rows[0].success).toBe(true);
    expect(rows[0].attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. FailedApproachRepository
// ---------------------------------------------------------------------------

describe("FailedApproachRepository", () => {
  let repo: FailedApproachRepository;
  const taskId = randomUUID();
  const epicId = randomUUID();

  beforeAll(async () => {
    repo = new FailedApproachRepository(db);

    const wiRepo = new WorkItemRepository(db);
    await wiRepo.create({
      id: epicId,
      level: "Epic",
      status: "Pending",
      title: "FailedApproach Test Epic",
      runScope: "test-run",
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Pending",
      parentId: epicId,
      title: "FailedApproach Test Task",
      runScope: "test-run",
    });
    createdWorkItemIds.push(taskId);
  });

  test("record inserts a failed approach and it can be read back", async () => {
    await repo.record(
      taskId,
      epicId,
      "Bad Architecture Choice",
      "Tried microservices for a single-user app",
      "Over-engineering, latency issues",
      "Keep it simple for solo projects",
      "architecture",
    );
    createdFailedApproachTaskIds.push(taskId);

    const rows = await db
      .select()
      .from(failedApproaches)
      .where(sql`${failedApproaches.taskId} = ${taskId}`);

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.epicId).toBe(epicId);
    expect(row.title).toBe("Bad Architecture Choice");
    expect(row.approachDescription).toBe("Tried microservices for a single-user app");
    expect(row.failureReason).toBe("Over-engineering, latency issues");
    expect(row.learned).toBe("Keep it simple for solo projects");
    expect(row.affectedArea).toBe("architecture");
  });
});
