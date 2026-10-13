// Server integration tests — boot Hono app, hit every endpoint, verify format

import { randomUUID } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type pg from "pg";
import {
  createDb,
  DEFAULT_DATABASE_URL,
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ProjectRepository,
  ConfigRepository,
  SecretRepository,
  createProjectWithVision,
  ClientMessageRepository,
  ClientRepository,
  createProjectWithTender,
} from "@ashara/db";
import { SecretStore, generateKeyFileContent, loadMasterKey, providerApiKeySecretName } from "@ashara/security";
import { RUN_SCOPE_AD_HOC, parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import type { Database } from "../../db/src/connection.js";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const API_TOKEN = `test-token-${randomUUID().slice(0, 8)}`;

let db: Database;
let pool: pg.Pool;
let app: Hono;
let keyDir: string;

const createdWorkItemIds: string[] = [];
const createdVisionIds: string[] = [];
const createdProjectIds: string[] = [];
const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];
const createdSecretNames: string[] = [];
let suiteClientId: string;
let keyedProviderName: string;
let keylessProviderName: string;

/** A project owned by this suite; its rows are removed in afterAll. */
async function newProject(): Promise<ProjectId> {
  const project = await new ProjectRepository(db).create(`server-intg-${randomUUID().slice(0, 8)}`, suiteClientId);
  createdProjectIds.push(project.id);
  return project.id;
}

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

  const workItemRepo = new WorkItemRepository(db);
  const eventStore = new EventStoreRepository(db);
  const devSessionRepo = new DevSessionRepository(db);
  const visionRepo = new VisionRepository(db);
  const configRepo = new ConfigRepository(db);
  const runner: AppDeps["runner"] = { wake: () => {} };
  suiteClientId = (await new ClientRepository(db).create(`server-intg-${randomUUID()}`)).id;

  // A throwaway master key in a temp file: never the owner's key, never the
  // owner's secrets. Only names derived from this suite's unique providers are written.
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-server-intg-key-"));
  const keyFile = path.join(keyDir, "secret.key");
  fs.writeFileSync(keyFile, generateKeyFileContent().content, { mode: 0o600 });
  const secretStore = new SecretStore(new SecretRepository(db), loadMasterKey(keyFile));

  const deps: AppDeps = {
    workItemRepo,
    eventStore,
    devSessionRepo,
    visionRepo,
    projectRepo: new ProjectRepository(db),
    createProject: async (clientId, name, vision) => {
      const created = await createProjectWithVision(db, clientId, name, vision);
      createdProjectIds.push(created.project.id);
      createdVisionIds.push(created.vision.id);
      return created;
    },
    clientMessageRepo: new ClientMessageRepository(db),
    clientRepo: new ClientRepository(db),
    createTender: async (clientId, projectName, body) => {
      const created = await createProjectWithTender(db, clientId, projectName, body);
      createdProjectIds.push(created.project.id);
      return created;
    },
    configRepo,
    secretStore,
    runner,
  };

  const honoApp = new Hono();
  honoApp.use("*", bearerAuth(API_TOKEN));
  honoApp.route("/", createRoutes(deps));
  app = honoApp;

  const testProviderName = `intg-provider-${randomUUID().slice(0, 8)}`;
  keyedProviderName = testProviderName;
  keylessProviderName = `intg-provider-${randomUUID().slice(0, 8)}`;
  for (const name of [keyedProviderName, keylessProviderName]) {
    createdProviderNames.push(name);
    await pool.query(
      "INSERT INTO provider_configs (name, provider_type, base_url) VALUES ($1, $2, $3)",
      [name, "openai-compatible", "http://localhost:11434/v1"],
    );
  }
  const keyedSecret = providerApiKeySecretName(keyedProviderName);
  createdSecretNames.push(keyedSecret);
  await secretStore.put(keyedSecret, "throwaway-intg-value");

  const testModelId = `intg-model-${randomUUID().slice(0, 8)}`;
  createdModelIds.push(testModelId);
  await pool.query(
    "INSERT INTO model_configs (model_id, provider_name, api_model_id, capability, input_cost_per_1m, output_cost_per_1m, max_context_tokens, supports_caching) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [testModelId, testProviderName, "test-model-v1", "Strong", 1.0, 5.0, 128000, false],
  );
});

afterAll(async () => {
  for (const name of createdSecretNames) {
    await pool.query("DELETE FROM secrets WHERE name = $1", [name]);
  }
  fs.rmSync(keyDir, { recursive: true, force: true });
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
  for (const id of createdProjectIds) {
    // Replies first: in_reply_to references another row of the same table.
    await pool.query("DELETE FROM client_messages WHERE project_id = $1 AND in_reply_to IS NOT NULL", [id]);
    await pool.query("DELETE FROM client_messages WHERE project_id = $1", [id]);
    await pool.query("DELETE FROM project_contracts WHERE project_id = $1", [id]);
    await pool.query("DELETE FROM projects WHERE id = $1", [id]);
  }
  await pool.query("DELETE FROM clients WHERE id = $1", [suiteClientId]);
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
      projectId: await newProject(),
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
// 4. Config
// ===========================================================================

describe("Config", () => {
  test("GET /config/providers reports hasKey from the secret store and never a key", async () => {
    const res = await req("GET", "/config/providers");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("throwaway-intg-value");
    const rows = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(text));
    for (const row of rows) {
      expect(row).not.toHaveProperty("apiKey");
      expect(row).not.toHaveProperty("api_key");
      expect(typeof row["hasKey"]).toBe("boolean");
    }
    expect(rows.find((r) => r["name"] === keyedProviderName)).toMatchObject({
      providerType: "openai-compatible",
      hasKey: true,
    });
    expect(rows.find((r) => r["name"] === keylessProviderName)).toMatchObject({ hasKey: false });
    expect(rows[0]?.["provider_type"]).toBeUndefined();
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
  const tender = (visionText: string) => ({
    clientId: suiteClientId,
    projectName: `intg-${randomUUID().slice(0, 8)}`,
    visionText,
    summary: "Test summary",
    inferences: { test: true },
    scopeBoundaries: ["scope-a"],
    confirmedDirections: [],
    userAnswers: [],
    openQuestions: ["open?"],
  });
  const CreatedSchema = z.object({
    projectId: z.string().uuid(),
    vision: z.object({ id: z.string(), projectId: z.string(), version: z.number(), visionText: z.string() }),
  });

  test("POST /vision creates a project and its vision v1, read back by project id", async () => {
    const res = await req("POST", "/vision", tender("Integration test vision"));
    expect(res.status).toBe(201);
    const body = CreatedSchema.parse(await res.json());
    expect(body.vision.projectId).toBe(body.projectId);
    expect(body.vision.version).toBe(1);

    const read = await req("GET", `/projects/${body.projectId}/vision`);
    expect(read.status).toBe(200);
    const vision = CreatedSchema.shape.vision.parse(await read.json());
    expect(vision.id).toBe(body.vision.id);
    expect(vision.visionText).toBe("Integration test vision");
  });

  test("each tender is its own project at version 1", async () => {
    const a = CreatedSchema.parse(await (await req("POST", "/vision", tender("vision A"))).json());
    const b = CreatedSchema.parse(await (await req("POST", "/vision", tender("vision B"))).json());
    expect(a.projectId).not.toBe(b.projectId);
    expect([a.vision.version, b.vision.version]).toEqual([1, 1]);
    const readA = CreatedSchema.shape.vision.parse(await (await req("GET", `/projects/${a.projectId}/vision`)).json());
    expect(readA.visionText).toBe("vision A");
  });

  test("POST /vision without a projectName is refused", async () => {
    const { projectName: _omitted, ...withoutName } = tender("nameless");
    const res = await req("POST", "/vision", withoutName);
    expect(res.status).toBe(400);
  });

  test("POST /vision names its client: none is 400, an unknown one is 404", async () => {
    const { clientId: _omitted, ...withoutClient } = tender("clientless");
    expect((await req("POST", "/vision", withoutClient)).status).toBe(400);
    expect((await req("POST", "/vision", { ...tender("unknown client"), clientId: randomUUID() })).status).toBe(404);
  });

  test("GET /projects/:id/vision is 404 for a project with no vision and 400 for a non-UUID", async () => {
    expect((await req("GET", `/projects/${randomUUID()}/vision`)).status).toBe(404);
    expect((await req("GET", "/projects/not-a-uuid/vision")).status).toBe(400);
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

  test("a wrong token of the same length and of another length both return 401", async () => {
    const sameLength = API_TOKEN.slice(0, -1) + (API_TOKEN.endsWith("x") ? "y" : "x");
    for (const token of [sameLength, `${API_TOKEN}-longer`]) {
      const res = await req("GET", "/work-items", undefined, {
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
    }
  });
});

// ===========================================================================
// 8b. Client channel (K1)
// ===========================================================================

describe("Client channel", () => {
  const MessageSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    direction: z.enum(["inbound", "outbound"]),
    kind: z.string(),
    body: z.string(),
    inReplyTo: z.string().nullable(),
    consumedAt: z.string().nullable(),
    createdAt: z.string(),
  });
  const TenderResponseSchema = z.object({ projectId: z.string(), message: MessageSchema });

  let projectId: string;

  async function rowCount(id: string): Promise<number> {
    const result = await pool.query("SELECT count(*)::int AS n FROM client_messages WHERE project_id = $1", [id]);
    return z.object({ n: z.number() }).parse(result.rows[0]).n;
  }

  beforeAll(async () => {
    const res = await req("POST", "/tenders", {
      clientId: suiteClientId,
      projectName: `server-intg-tender-${randomUUID().slice(0, 8)}`,
      body: "Build a ledger for a bakery.",
    });
    expect(res.status).toBe(201);
    const tender = TenderResponseSchema.parse(await res.json());
    projectId = tender.projectId;
    expect(tender.message).toMatchObject({ projectId, direction: "inbound", kind: "tender" });
  });

  test("POST /tenders creates the project row, owned by the named client, and its tender message together", async () => {
    const project = await pool.query("SELECT client_id FROM projects WHERE id = $1", [projectId]);
    expect(project.rows).toEqual([{ client_id: suiteClientId }]);
    const rows = await pool.query("SELECT direction, kind, body FROM client_messages WHERE project_id = $1", [projectId]);
    expect(rows.rows).toEqual([{ direction: "inbound", kind: "tender", body: "Build a ledger for a bakery." }]);
  });

  test("POST /tenders requires a clientId and 404s an unknown one; no project is created", async () => {
    const projectName = `server-intg-tender-refused-${randomUUID().slice(0, 8)}`;
    expect((await req("POST", "/tenders", { projectName, body: "x" })).status).toBe(400);
    expect((await req("POST", "/tenders", { clientId: randomUUID(), projectName, body: "x" })).status).toBe(404);
    const rows = await pool.query("SELECT id FROM projects WHERE name = $1", [projectName]);
    expect(rows.rowCount).toBe(0);
  });

  test("a body that is not JSON is 400 with a generic error; the parser detail stays in the log", async () => {
    const res = await app.request(`/projects/${projectId}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "request body is not valid JSON" });
  });

  test("an inbound post persists a typed row and returns 201", async () => {
    const res = await req("POST", `/projects/${projectId}/messages`, { kind: "change", body: "Add VAT." });
    expect(res.status).toBe(201);
    const message = MessageSchema.parse(await res.json());
    const stored = await pool.query(
      "SELECT project_id, direction, kind, body, in_reply_to FROM client_messages WHERE id = $1",
      [message.id],
    );
    expect(stored.rows).toEqual([
      { project_id: projectId, direction: "inbound", kind: "change", body: "Add VAT.", in_reply_to: null },
    ]);
  });

  test("an outbound kind, a tender, an empty body or an unknown field is rejected with 400", async () => {
    const before = await rowCount(projectId);
    for (const body of [
      { kind: "question", body: "What colour?" },
      { kind: "report", body: "Done." },
      { kind: "tender", body: "Another project." },
      { kind: "change", body: "" },
      { kind: "change", body: "x", direction: "outbound" },
    ]) {
      const res = await req("POST", `/projects/${projectId}/messages`, body);
      expect(res.status).toBe(400);
    }
    expect(await rowCount(projectId)).toBe(before);
  });

  test("an unauthenticated or wrong-token POST returns 401 and writes nothing", async () => {
    const before = await rowCount(projectId);
    for (const headers of [
      noAuthHeaders(),
      { Authorization: `Bearer wrong-${API_TOKEN}`, "Content-Type": "application/json" },
    ]) {
      const res = await req("POST", `/projects/${projectId}/messages`, { kind: "stop", body: "Stop." }, headers);
      expect(res.status).toBe(401);
    }
    expect(await rowCount(projectId)).toBe(before);
  });

  test("a post to an unknown project returns 404", async () => {
    const res = await req("POST", `/projects/${randomUUID()}/messages`, { kind: "stop", body: "Stop." });
    expect(res.status).toBe(404);
  });

  test("an answer must reply to a question of the same project", async () => {
    const question = await new ClientMessageRepository(db).insertOutbound({
      projectId: parseProjectId(projectId),
      kind: "question",
      body: "Which currency?",
      inReplyTo: null,
    });

    const answered = await req("POST", `/projects/${projectId}/messages`, {
      kind: "answer",
      body: "EUR.",
      inReplyTo: question.id,
    });
    expect(answered.status).toBe(201);
    expect(MessageSchema.parse(await answered.json()).inReplyTo).toBe(question.id);

    const tenderRow = await pool.query(
      "SELECT id FROM client_messages WHERE project_id = $1 AND kind = 'tender'",
      [projectId],
    );
    const tenderId = z.object({ id: z.string() }).parse(tenderRow.rows[0]).id;
    for (const inReplyTo of [tenderId, randomUUID()]) {
      const res = await req("POST", `/projects/${projectId}/messages`, { kind: "answer", body: "x", inReplyTo });
      expect(res.status).toBe(400);
    }
    const missing = await req("POST", `/projects/${projectId}/messages`, { kind: "answer", body: "x" });
    expect(missing.status).toBe(400);

    const again = await req("POST", `/projects/${projectId}/messages`, {
      kind: "answer",
      body: "USD.",
      inReplyTo: question.id,
    });
    expect(again.status).toBe(409);
  });

  test("GET lists both directions oldest first, and ?since= keeps only later rows", async () => {
    const res = await req("GET", `/projects/${projectId}/messages`);
    expect(res.status).toBe(200);
    const messages = z.array(MessageSchema).parse(await res.json());
    expect(messages.map((m) => `${m.direction}:${m.kind}`)).toEqual([
      "inbound:tender",
      "inbound:change",
      "outbound:question",
      "inbound:answer",
    ]);

    const since = encodeURIComponent(messages[1].createdAt);
    const later = await req("GET", `/projects/${projectId}/messages?since=${since}`);
    expect(later.status).toBe(200);
    const laterKinds = z.array(MessageSchema).parse(await later.json()).map((m) => m.kind);
    expect(laterKinds).toEqual(["question", "answer"]);

    const bad = await req("GET", `/projects/${projectId}/messages?since=yesterday`);
    expect(bad.status).toBe(400);
  });

  test("a GET of an unknown project returns 404", async () => {
    const res = await req("GET", `/projects/${randomUUID()}/messages`);
    expect(res.status).toBe(404);
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
