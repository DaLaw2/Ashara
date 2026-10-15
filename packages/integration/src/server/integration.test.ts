// Server integration tests — boot Hono app, hit every endpoint, verify format

import { randomUUID } from "crypto";
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
  ProjectRepository,
  ClientRepository,
} from "@ashara/db";
import { VisionRepository, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import { parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { bearerAuth } from "@ashara/server/middleware";
import { createRoutes } from "@ashara/server/routes";
import type { AppDeps } from "@ashara/server/routes";
import type { Database } from "../simulator/database.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const API_TOKEN = `test-token-${randomUUID().slice(0, 8)}`;

let db: Database;
let pool: pg.Pool;
let app: Hono;

const createdWorkItemIds: string[] = [];
const createdVisionIds: string[] = [];
const createdProjectIds: string[] = [];
let suiteClientId: string;

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
  suiteClientId = (await new ClientRepository(db).create(`server-intg-${randomUUID()}`)).id;

  const deps: AppDeps = {
    workItemRepo,
    eventStore,
    devSessionRepo,
    visionRepo,
    projectRepo: new ProjectRepository(db),
    clientMessageRepo: new ClientMessageRepository(db),
    clientRepo: new ClientRepository(db),
    createTender: async (clientId, projectName, body) => {
      const created = await createProjectWithTender(db, clientId, projectName, body);
      createdProjectIds.push(created.project.id);
      return created;
    },
  };

  const honoApp = new Hono();
  honoApp.use("*", bearerAuth(API_TOKEN));
  honoApp.route("/", createRoutes(deps));
  app = honoApp;
});

afterAll(async () => {
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

  test("PATCH /work-items/:id/status on a malformed id returns 400 naming the id, before any read", async () => {
    const res = await req("PATCH", `/work-items/not-a-uuid/status`, { status: "InProgress" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not-a-uuid");
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

  /** A Task Blocked with `blockedReason`, in a project of this suite. */
  async function blockedTask(blockedReason: unknown): Promise<{ id: string; projectId: ProjectId }> {
    const id = randomUUID();
    const projectId = await newProject();
    await pool.query(
      `INSERT INTO work_items (id, level, status, title, blocked_reason, project_id)
       VALUES ($1, 'Task', 'Blocked', 'Blocked task', $2::jsonb, $3)`,
      [id, JSON.stringify(blockedReason), projectId],
    );
    createdWorkItemIds.push(id);
    return { id, projectId };
  }

  // Story s-loop-never-stop-m1 W6: no work item waits on a person, so nobody unblocks or blocks a task by hand.
  test.each([
    { source: "environment_change_needed", paths: ["environment/environment.toml"], reason: "edited" },
    { source: "merge_unrecorded", mergeCommit: "0123456789abcdef0123456789abcdef01234567", reason: "connection reset" },
    { source: "owner_unresolved", ownerRoleId: null, rosterRevision: 1, reason: "no owner" },
  ])("a Blocked task ($source) is not unblocked by hand: refused, and it stays Blocked", async (blockedReason) => {
    const task = await blockedTask(blockedReason);

    const res = await req("PATCH", `/work-items/${task.id}/status`, { status: "Pending", reason: { by: "operator-a", note: "x" } });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("the loop takes a Blocked task's exit by itself");
    expect(await statusOf(task.id)).toBe("Blocked");
  });

  test("a task is not blocked by hand", async () => {
    const id = randomUUID();
    const projectId = await newProject();
    await pool.query(
      `INSERT INTO work_items (id, level, status, title, project_id) VALUES ($1, 'Task', 'Pending', 'Pending task', $2)`,
      [id, projectId],
    );
    createdWorkItemIds.push(id);

    const res = await req("PATCH", `/work-items/${id}/status`, { status: "Blocked", reason: { note: "held" } });

    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe("Pending");
  });

  // ADR-075 §5: nothing outside Quality marks work passed.
  test("a task is not completed by hand: refused, and it stays InProgress", async () => {
    const id = randomUUID();
    const projectId = await newProject();
    await pool.query(
      `INSERT INTO work_items (id, level, status, title, project_id) VALUES ($1, 'Task', 'InProgress', 'Running task', $2)`,
      [id, projectId],
    );
    createdWorkItemIds.push(id);

    const res = await req("PATCH", `/work-items/${id}/status`, { status: "Completed" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Quality has verified its delivery");
    expect(await statusOf(id)).toBe("InProgress");
  });

  test("a body that is not JSON is a typed 400, not a 500", async () => {
    const res = await app.request(`/work-items/${createdId}/status`, {
      method: "PATCH",
      headers: authHeaders(),
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("request body is not valid JSON");
  });

  test.each([
    { body: { status: "Done" }, what: "an unknown status" },
    { body: { reason: { note: "x" } }, what: "no status" },
    { body: { status: "Failed", reason: "x" }, what: "a reason that is not an object" },
    { body: { status: "Failed", extra: 1 }, what: "an unknown field" },
  ])("a body with $what is a 400 naming the issues", async ({ body }) => {
    const res = await req("PATCH", `/work-items/${createdId}/status`, body);
    expect(res.status).toBe(400);
    const parsed = z.object({ error: z.string(), issues: z.array(z.unknown()).min(1) }).parse(await res.json());
    expect(parsed.error).toBe("invalid status patch body");
  });
});

// ===========================================================================
// 5. Vision
// ===========================================================================

describe("Vision", () => {
  const VisionSchema = z.object({ id: z.string(), projectId: z.string(), version: z.number(), visionText: z.string() });

  test("GET /projects/:id/vision returns the project's current vision", async () => {
    const projectId = await newProject();
    const created = await new VisionRepository(db).create(projectId, {
      visionText: "Integration test vision",
      summary: "Test summary",
    });
    createdVisionIds.push(created.id);

    const read = await req("GET", `/projects/${projectId}/vision`);
    expect(read.status).toBe(200);
    const vision = VisionSchema.parse(await read.json());
    expect(vision).toMatchObject({ id: created.id, projectId, version: 1, visionText: "Integration test vision" });
  });

  test("GET /projects/:id/vision is 404 for a project with no vision and 400 for a non-UUID", async () => {
    expect((await req("GET", `/projects/${randomUUID()}/vision`)).status).toBe(404);
    const malformed = await req("GET", "/projects/not-a-uuid/vision");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "projectId must be a UUID" });
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
    const res = await req("GET", `/projects/${randomUUID()}/work-items`, undefined, noAuthHeaders());
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
      const res = await req("GET", `/projects/${randomUUID()}/work-items`, undefined, {
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
      projectId: parseProjectId(projectId, "test"),
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
