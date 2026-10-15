import { randomUUID } from "crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "./connection.js";
import { WorkItemRepository } from "./repositories/work-item.js";
import { DevSessionRepository } from "./repositories/dev-session.js";
import { EventStoreRepository } from "./repositories/event-store.js";
import { ConfigRepository } from "./repositories/config.js";
import { KnowledgeRepository } from "./repositories/knowledge.js";
import { FailedApproachRepository } from "./repositories/failed-approach.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import {
  devSessions,
  domainEvents,
  knowledgeEntries,
  failedApproaches,
  modelConfigs,
  providerConfigs,
} from "./schema/index.js";

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
const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];
const createdKnowledgeIds: string[] = [];
const createdFailedApproachTaskIds: string[] = [];

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

// Every work item and vision needs a project (migration 014); this suite owns one.
let testProjectId: ProjectId;
let testClientId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const nonce = randomUUID().slice(0, 8);
  testClientId = (await new ClientRepository(db).create(`db-intg-${nonce}`)).id;
  testProjectId = (await new ProjectRepository(db).create(`db-intg-${nonce}`, testClientId)).id;
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
  for (const modelId of createdModelIds) {
    await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${modelId}`);
  }
  for (const name of createdProviderNames) {
    await db.execute(sql`DELETE FROM provider_configs WHERE name = ${name}`);
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
  await db.execute(sql`DELETE FROM projects WHERE id = ${testProjectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
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
      projectId: testProjectId,
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
      projectId: testProjectId,
    });
    createdWorkItemIds.push(taskId);
  });

  test("insert creates a session and it can be read back", async () => {
    const brief = { instructions: "do something" };
    const environmentVersion = "e".repeat(64);
    await repo.insert(sessionId, taskId, brief, environmentVersion);
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
    expect(row.environmentVersion).toBe(environmentVersion);
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
      baseUrl: "http://localhost:11434/v1",
    });
    const providers = await repo.listProviderConfigs();
    const provider = providers.find((p) => p.name === testProviderName);
    expect(provider?.providerType).toBe("openai-compatible");
    expect(provider?.baseUrl).toBe("http://localhost:11434/v1");
    expect(provider).not.toHaveProperty("apiKey");

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
      projectId: testProjectId,
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Completed",
      parentId: epicId,
      title: "Knowledge Test Task",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(taskId);
  });

  test("storeKnowledgeFinding inserts a finding and it can be read back", async () => {
    await repo.storeKnowledgeFinding(
      testProjectId,
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
// 7. FailedApproachRepository
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
      projectId: testProjectId,
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Pending",
      parentId: epicId,
      title: "FailedApproach Test Task",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(taskId);
  });

  test("record inserts a failed approach and it can be read back", async () => {
    await repo.record(
      testProjectId,
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
    expect(row.projectId).toBe(testProjectId);
  });
});

// ---------------------------------------------------------------------------
// 8. Two projects on one database (migration 051, ADR-074 d92 a)
// ---------------------------------------------------------------------------

describe("project-scoped knowledge", () => {
  const projectTasks = new Map<ProjectId, string>();
  let otherProjectId: ProjectId;

  beforeAll(async () => {
    otherProjectId = (await new ProjectRepository(db).create(`db-intg-other-${randomUUID().slice(0, 8)}`, testClientId)).id;
    const wiRepo = new WorkItemRepository(db);
    for (const projectId of [testProjectId, otherProjectId]) {
      const taskId = randomUUID();
      await wiRepo.create({ id: taskId, level: "Task", status: "Pending", title: "Scoped Task", projectId });
      createdWorkItemIds.push(taskId);
      projectTasks.set(projectId, taskId);
    }
  });

  afterAll(async () => {
    for (const projectId of projectTasks.keys()) {
      await db.execute(sql`DELETE FROM knowledge_entries WHERE project_id = ${projectId}`);
      await db.execute(sql`DELETE FROM failed_approaches WHERE project_id = ${projectId}`);
    }
    const otherTask = projectTasks.get(otherProjectId);
    if (otherTask !== undefined) await db.execute(sql`DELETE FROM work_items WHERE id = ${otherTask}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${otherProjectId}`);
  });

  function taskOf(projectId: ProjectId): string {
    const taskId = projectTasks.get(projectId);
    if (taskId === undefined) throw new Error(`test setup: no task for project ${projectId}`);
    return taskId;
  }

  test("each project's read returns only its own findings and failed approaches", async () => {
    const knowledge = new KnowledgeRepository(db);
    const approaches = new FailedApproachRepository(db);
    for (const projectId of projectTasks.keys()) {
      const taskId = taskOf(projectId);
      await knowledge.storeKnowledgeFinding(projectId, taskId, null, `finding of ${projectId}`, "shared words", []);
      await approaches.record(projectId, taskId, null, `approach of ${projectId}`, "d", "shared words", "l", "a");
    }

    for (const projectId of projectTasks.keys()) {
      const findings = await knowledge.recentFindingsScoped(projectId, null, "shared words", 50);
      expect(findings.map((f) => f.title)).toEqual([`finding of ${projectId}`]);
      const failed = await approaches.failedApproachesScoped(projectId, null, "shared words", 50);
      expect(failed.map((f) => f.title)).toEqual([`approach of ${projectId}`]);
    }
  });

  test("a dependency edge across two projects is refused", async () => {
    await expect(
      db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${taskOf(testProjectId)}, ${taskOf(otherProjectId)})`),
    ).rejects.toThrow();
  });
});
