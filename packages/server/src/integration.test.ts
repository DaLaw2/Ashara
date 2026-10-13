// Server integration tests — boot Hono app, hit every endpoint, verify format

import { randomUUID } from "crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type pg from "pg";
import {
  createDb,
  DEFAULT_DATABASE_URL,
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ConfigRepository,
  withPlanningTransaction,
} from "@ashara/db";
import { initParser } from "@ashara/memory";
import type { ContinuousRunner } from "@ashara/orchestrator";
import { createBulkPlanWithContract } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { Database } from "../../db/src/connection.js";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

function makeCreateBulkPlan(dbHandle: Database): AppDeps["createBulkPlan"] {
  return (items, edges, knowledge) =>
    createBulkPlanWithContract(
      {
        withPlanningTransaction: (fn) =>
          withPlanningTransaction(dbHandle, ({ workItemRepo: w, contractRepo }) =>
            fn({ workItemRepo: adaptWorkItemRepo(w), contractRepo }),
          ),
        runScope: RUN_SCOPE_AD_HOC,
      },
      items,
      edges,
      knowledge,
    );
}

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const API_TOKEN = `test-token-${randomUUID().slice(0, 8)}`;

let db: Database;
let pool: pg.Pool;
let app: Hono;

const createdWorkItemIds: string[] = [];
const createdVisionIds: string[] = [];
const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function noAuthHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: headers ?? authHeaders(),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return app.request(path, opts);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  pool = db.$client;

  try {
    await initParser();
  } catch (e: unknown) {
    console.warn(`[integration.test] initParser failed (tree-sitter may not be available): ${e instanceof Error ? e.message : String(e)}`);
  }

  const workItemRepo = new WorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const configRepo = new ConfigRepository(db);
  const runner = { wake: () => {} } as unknown as ContinuousRunner;

  const deps: AppDeps = {
    workItemRepo,
    eventStore,
    devSessionRepo,
    visionRepo,
    configRepo,
    runner,
    createBulkPlan: makeCreateBulkPlan(db),
  };

  const honoApp = new Hono();
  honoApp.use("*", bearerAuth(API_TOKEN));
  honoApp.route("/", createRoutes(deps));
  app = honoApp;

  const testProviderName = `intg-provider-${randomUUID().slice(0, 8)}`;
  createdProviderNames.push(testProviderName);
  await pool.query(
    "INSERT INTO provider_configs (name, provider_type, api_key, base_url) VALUES ($1, $2, $3, $4)",
    [testProviderName, "openai-compatible", "sk-test-intg", "http://localhost:11434/v1"],
  );

  const testModelId = `intg-model-${randomUUID().slice(0, 8)}`;
  createdModelIds.push(testModelId);
  await configRepo.upsertModelConfig({
    modelId: testModelId,
    providerName: testProviderName,
    apiModelId: "test-model-v1",
    capability: "Strong",
    formatGroup: "native-fc",
    inputCostPer1m: 1.0,
    outputCostPer1m: 5.0,
    maxContextTokens: 128000,
    supportsCaching: false,
  });
});

afterAll(async () => {
  for (const modelId of createdModelIds) {
    await pool.query("DELETE FROM model_configs WHERE model_id = $1", [modelId]);
  }
  for (const name of createdProviderNames) {
    await pool.query("DELETE FROM provider_configs WHERE name = $1", [name]);
  }
  for (const id of createdVisionIds) {
    await pool.query("DELETE FROM vision_documents WHERE id = $1", [id]);
  }
  for (const id of [...createdWorkItemIds].reverse()) {
    await pool.query("DELETE FROM dev_sessions WHERE task_id = $1", [id]);
    await pool.query("DELETE FROM failed_approaches WHERE task_id = $1 OR epic_id = $1", [id]);
    await pool.query("DELETE FROM knowledge_entries WHERE source_task_id = $1", [id]);
    await pool.query("DELETE FROM dependencies WHERE from_id = $1 OR to_id = $1", [id]);
  }
  for (const id of [...createdWorkItemIds].reverse()) {
    await pool.query("DELETE FROM work_items WHERE id = $1", [id]);
  }
  await pool.end();
});

// ===========================================================================
// 1. Health
// ===========================================================================

describe("Health", () => {
  test("GET /health returns 200", async () => {
    const res = await req("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ===========================================================================
// 2. Work Items
// ===========================================================================

describe("Work Items", () => {
  let createdId: string;

  beforeAll(async () => {
    createdId = randomUUID();
    await new WorkItemRepository(db).create({
      id: createdId,
      level: "Epic",
      status: "Pending",
      parentId: null,
      title: `Intg Test Epic ${createdId.slice(0, 8)}`,
      description: null,
      taskSpec: null,
      northStar: null,
      runScope: RUN_SCOPE_AD_HOC,
    });
    createdWorkItemIds.push(createdId);
  });

  async function statusOf(id: string): Promise<unknown> {
    const row = await pool.query("SELECT status FROM work_items WHERE id = $1", [id]);
    return row.rows[0]?.status;
  }

  test("PATCH /work-items/:id/status on an unknown id returns 404", async () => {
    const res = await req("PATCH", `/work-items/${randomUUID()}/status`, { status: "InProgress" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("work item not found");
  });

  test("PATCH /work-items/:id/status transitions successfully", async () => {
    const res = await req("PATCH", `/work-items/${createdId}/status`, {
      status: "InProgress",
    });
    expect(res.status).toBe(200);
    expect(await statusOf(createdId)).toBe("InProgress");
  });

  test("PATCH /work-items/:id/status rejects invalid transition", async () => {
    const res = await req("PATCH", `/work-items/${createdId}/status`, {
      status: "Pending",
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 3. Work Items Bulk
// ===========================================================================

describe("Work Items Bulk", () => {
  // A deliberately non-JS graph: the defect this suite now pins let a Go vision
  // reach the agent with an empty contract, and "package.json" is what the
  // downstream readers substituted when nothing stated otherwise.
  const GO_KNOWLEDGE = {
    nodes: [
      { id: "lang-go", kind: "language", label: "Go" },
      { id: "entry-cli", kind: "entry_point", label: "cmd/jot/main.go", meta: { mountKind: "cli" } },
    ],
    edges: [{ from: "entry-cli", to: "lang-go", rel: "uses" }],
  };

  test("happy path: creates hierarchy + edges atomically", async () => {
    const nonce = randomUUID().slice(0, 8);
    const res = await req("POST", "/work-items/bulk", {
      items: [
        { tempId: "epic-1", level: "Epic", title: `bulk-epic-${nonce}` },
        { tempId: "story-1", level: "Story", title: `bulk-story-${nonce}`, parentId: "epic-1" },
        { tempId: "task-1", level: "Task", title: `bulk-task-1-${nonce}`, parentId: "story-1" },
        { tempId: "task-2", level: "Task", title: `bulk-task-2-${nonce}`, parentId: "story-1" },
      ],
      edges: [{ from: "task-2", to: "task-1" }],
      knowledge: GO_KNOWLEDGE,
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.created).toBe(4);
    const map = body.tempIdToId as Record<string, string>;
    for (const id of Object.values(map)) createdWorkItemIds.push(id);

    const storyRow = await pool.query("SELECT parent_id FROM work_items WHERE id = $1", [map["story-1"]]);
    expect(storyRow.rows[0]?.parent_id).toBe(map["epic-1"]);

    const deps = await pool.query(
      "SELECT 1 FROM dependencies WHERE from_id = $1 AND to_id = $2",
      [map["task-2"], map["task-1"]],
    );
    expect(deps.rowCount).toBe(1);
  });

  // The regression that motivated ADR-052. These items name no HTTP endpoint and
  // no module path — the normal case for a CLI — which used to return early from
  // deriveAndWriteContract and drop the graph on the floor. Asserting on the
  // PERSISTED contract, not on the response, because every layer in between was
  // individually green while the end-to-end result was an empty graph.
  test("the posted knowledge graph reaches the persisted contract", async () => {
    const nonce = randomUUID().slice(0, 8);
    const res = await req("POST", "/work-items/bulk", {
      items: [
        { tempId: "epic-1", level: "Epic", title: `bulk-kg-epic-${nonce}` },
        { tempId: "task-1", level: "Task", title: `bulk-kg-task-${nonce}`, parentId: "epic-1" },
      ],
      edges: [],
      knowledge: GO_KNOWLEDGE,
    });
    expect(res.status).toBe(201);

    const map = (await res.json()).tempIdToId as Record<string, string>;
    for (const id of Object.values(map)) createdWorkItemIds.push(id);

    const contract = await pool.query(
      "SELECT contract FROM project_contracts WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
      [map["epic-1"]],
    );
    expect(contract.rowCount).toBe(1);
    const knowledge = contract.rows[0].contract.knowledge;
    expect(knowledge.nodes.map((n: { label: string }) => n.label)).toContain("Go");
  });

  test("a batch with no knowledge graph is refused", async () => {
    const nonce = randomUUID().slice(0, 8);
    const res = await req("POST", "/work-items/bulk", {
      items: [{ tempId: "epic-1", level: "Epic", title: `bulk-nokg-epic-${nonce}` }],
      edges: [],
    });
    expect(res.status).toBe(400);

    const survivors = await pool.query(
      "SELECT count(*)::int AS n FROM work_items WHERE title LIKE $1",
      [`bulk-nokg-%-${nonce}`],
    );
    expect(survivors.rows[0].n).toBe(0);
  });

  test("unresolved edge rolls the whole batch back", async () => {
    const nonce = randomUUID().slice(0, 8);
    const res = await req("POST", "/work-items/bulk", {
      items: [
        { tempId: "epic-1", level: "Epic", title: `bulk-rb-epic-${nonce}` },
        { tempId: "task-1", level: "Task", title: `bulk-rb-task-${nonce}`, parentId: "epic-1" },
      ],
      edges: [{ from: "task-1", to: "ghost" }],
      knowledge: GO_KNOWLEDGE,
    });
    expect(res.status).toBe(400);

    const survivors = await pool.query(
      "SELECT count(*)::int AS n FROM work_items WHERE title LIKE $1",
      [`bulk-rb-%-${nonce}`],
    );
    expect(survivors.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 4. Config
// ===========================================================================

describe("Config", () => {
  test("GET /config/providers returns camelCase array with apiKey from DB", async () => {
    const res = await req("GET", "/config/providers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0]).toHaveProperty("providerType");
    expect(body[0]).toHaveProperty("apiKey");
    expect(body[0].provider_type).toBeUndefined();
  });

  test("GET /config/models returns camelCase array", async () => {
    const res = await req("GET", "/config/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0]).toHaveProperty("modelId");
    expect(body[0].model_id).toBeUndefined();
  });
});

// ===========================================================================
// 5. Vision
// ===========================================================================

describe("Vision", () => {
  test("POST /vision returns 201", async () => {
    const res = await req("POST", "/vision", {
      visionText: "Integration test vision",
      summary: "Test summary",
      inferences: { test: true },
      scopeBoundaries: ["scope-a"],
      confirmedDirections: [],
      userAnswers: [],
      openQuestions: ["open?"],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    createdVisionIds.push(body.id);
  });
});

// ===========================================================================
// 6. Events
// ===========================================================================

describe("Events", () => {
  test("GET /events returns array", async () => {
    const res = await req("GET", "/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      expect(body[0]).toHaveProperty("eventId");
      expect(body[0]).toHaveProperty("eventType");
    }
  });
});

// ===========================================================================
// 7. Graph
// ===========================================================================

// ===========================================================================
// 8. Auth middleware
// ===========================================================================

describe("Auth middleware", () => {
  test("request without Bearer token returns 401", async () => {
    const res = await req("GET", "/work-items", undefined, noAuthHeaders());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  test("/health without token returns 200 (skips auth)", async () => {
    const res = await req("GET", "/health", undefined, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ===========================================================================
// 9. Sessions
// ===========================================================================

describe("Sessions", () => {
  test("GET /sessions returns array", async () => {
    const res = await req("GET", "/sessions");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
