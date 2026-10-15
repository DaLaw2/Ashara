import { randomUUID } from "crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "./connection.js";
import { EventStoreRepository } from "./repositories/event-store.js";
import { ConfigRepository } from "./repositories/config.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import {
  domainEvents,
  modelConfigs,
  providerConfigs,
  workItems,
} from "./schema/index.js";

// ---------------------------------------------------------------------------
// One insert -> read round trip per repository, against real Postgres
// (DB-specific mechanics -- SQL types, jsonb, defaults, FK wiring -- that a
// mocked Database can't verify). Business-rule and state-machine coverage
// lives in unit tests closer to the domain (e.g. planning/domain).
// ---------------------------------------------------------------------------

let db: Database;

const createdWorkItemIds: string[] = [];
const createdEventIds: string[] = [];
const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];

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
  for (const modelId of createdModelIds) {
    await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${modelId}`);
  }
  for (const name of createdProviderNames) {
    await db.execute(sql`DELETE FROM provider_configs WHERE name = ${name}`);
  }
  for (const id of createdEventIds) {
    await db.execute(sql`DELETE FROM domain_events WHERE event_id = ${id}`);
  }
  // Reverse creation order so children are gone before parents.
  for (const id of [...createdWorkItemIds].reverse()) {
    await db.execute(sql`DELETE FROM work_items WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM projects WHERE id = ${testProjectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
}

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
// 6. Two projects on one database (migration 051, ADR-074 d92 a)
// ---------------------------------------------------------------------------

describe("two projects", () => {
  const projectTasks = new Map<ProjectId, string>();
  let otherProjectId: ProjectId;

  beforeAll(async () => {
    otherProjectId = (await new ProjectRepository(db).create(`db-intg-other-${randomUUID().slice(0, 8)}`, testClientId)).id;
    for (const projectId of [testProjectId, otherProjectId]) {
      const taskId = randomUUID();
      await db.insert(workItems).values({ id: taskId, level: "Task", status: "Pending", title: "Scoped Task", projectId });
      createdWorkItemIds.push(taskId);
      projectTasks.set(projectId, taskId);
    }
  });

  afterAll(async () => {
    const otherTask = projectTasks.get(otherProjectId);
    if (otherTask !== undefined) await db.execute(sql`DELETE FROM work_items WHERE id = ${otherTask}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${otherProjectId}`);
  });

  function taskOf(projectId: ProjectId): string {
    const taskId = projectTasks.get(projectId);
    if (taskId === undefined) throw new Error(`test setup: no task for project ${projectId}`);
    return taskId;
  }

  test("a dependency edge across two projects is refused", async () => {
    await expect(
      db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${taskOf(testProjectId)}, ${taskOf(otherProjectId)})`),
    ).rejects.toThrow();
  });
});
