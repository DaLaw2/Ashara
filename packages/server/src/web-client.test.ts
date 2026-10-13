// The web client (ADR-076): login, session, CSRF and page headers against the
// composed app, then a recorded headless-browser session against a live port.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ClientMessageRepository,
  ClientSessionRepository,
  ConfigRepository,
  createDb,
  createProjectWithTender,
  createProjectWithVision,
  DEFAULT_DATABASE_URL,
  DevSessionRepository,
  EventStoreRepository,
  ProjectRepository,
  SecretRepository,
  VisionRepository,
  WorkItemRepository,
} from "@ashara/db";
import { generateKeyFileContent, loadMasterKey, SecretStore } from "@ashara/security";
import { parseProjectId } from "@ashara/shared";
import type { Database } from "../../db/src/connection.js";
import { buildApp } from "./app.js";
import type { AppDeps } from "./routes.js";
import type { SecretReader } from "./secrets.js";
import { CLIENT_SESSION_COOKIE, loadWebClientAssets } from "./web-client.js";
import type { WebClientDeps } from "./web-client.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const API_TOKEN = `web-client-test-${randomUUID()}`;
const ACCESS_CODE = randomBytes(24).toString("hex");
const FAILURE_DELAY_MS = 150;
const TTL_SECONDS = 3600;
const CLIENT_HEADER = { "X-Ashara-Client": "1" };

let db: Database;
let keyDir: string;
let secretStore: SecretStore;
let accessCodeSecretName: string;
let app: Hono;
const createdProjectIds: string[] = [];
const issuedTokens: string[] = [];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class NotTested extends Error {
  constructor(what: string) {
    super(`web client test: ${what} is not part of this suite`);
    this.name = "NotTested";
  }
}

function appDeps(): AppDeps {
  return {
    workItemRepo: new WorkItemRepository(db),
    eventStore: new EventStoreRepository(db),
    devSessionRepo: new DevSessionRepository(db),
    visionRepo: new VisionRepository(db),
    projectRepo: new ProjectRepository(db),
    createProject: (name, vision) => createProjectWithVision(db, name, vision),
    clientMessageRepo: new ClientMessageRepository(db),
    createTender: async (projectName, body) => {
      const created = await createProjectWithTender(db, projectName, body);
      createdProjectIds.push(created.project.id);
      return created;
    },
    configRepo: new ConfigRepository(db),
    secretStore,
    runner: { wake: () => {} },
    createBulkPlan: () => Promise.reject(new NotTested("bulk planning")),
  };
}

function webClientDeps(overrides: Partial<WebClientDeps> = {}): WebClientDeps {
  const base = appDeps();
  return {
    projectRepo: base.projectRepo,
    clientMessageRepo: base.clientMessageRepo,
    createTender: base.createTender,
    secrets: secretStore,
    accessCodeSecretName,
    sessionRepo: new ClientSessionRepository(db),
    sessionTtlSeconds: TTL_SECONDS,
    loginFailureDelayMs: FAILURE_DELAY_MS,
    assets: loadWebClientAssets(),
    ...overrides,
  };
}

function build(overrides: Partial<WebClientDeps> = {}): Hono {
  return buildApp(API_TOKEN, appDeps(), webClientDeps(overrides));
}

async function login(target: Hono, url = "http://localhost/client/login"): Promise<Response> {
  return target.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ code: ACCESS_CODE }),
  });
}

function sessionToken(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${CLIENT_SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (match === null) throw new Error(`no ${CLIENT_SESSION_COOKIE} cookie in: ${cookie}`);
  issuedTokens.push(match[1]);
  return match[1];
}

async function loggedIn(target: Hono = app): Promise<string> {
  const response = await login(target);
  expect(response.status).toBe(204);
  return sessionToken(response);
}

function withSession(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `${CLIENT_SESSION_COOKIE}=${token}`, ...extra };
}

async function postTender(token: string, projectName: string, body: string): Promise<string> {
  const response = await app.request("/client/api/tenders", {
    method: "POST",
    headers: withSession(token, { "Content-Type": "application/json", ...CLIENT_HEADER }),
    body: JSON.stringify({ projectName, body }),
  });
  expect(response.status).toBe(201);
  const created = z.object({ projectId: z.uuid() }).parse(await response.json());
  return parseProjectId(created.projectId);
}

function memoryReader(entries: Record<string, string>): SecretReader {
  return {
    has: async (name) => name in entries,
    get: async (name) => {
      const value = entries[name];
      if (value === undefined) throw new Error(`test reader: ${name} absent`);
      return value;
    },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  // A throwaway master key and a secret name only this run owns: the owner's
  // client/access_code, if one is stored, is never read or overwritten.
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-web-client-key-"));
  const keyFile = path.join(keyDir, "secret.key");
  fs.writeFileSync(keyFile, generateKeyFileContent().content, { mode: 0o600 });
  secretStore = new SecretStore(new SecretRepository(db), loadMasterKey(keyFile));
  accessCodeSecretName = `test-web-client/${randomUUID()}/access_code`;
  await secretStore.put(accessCodeSecretName, ACCESS_CODE);
  app = build();
});

afterAll(async () => {
  const pool = db.$client;
  await pool.query("DELETE FROM secrets WHERE name = $1", [accessCodeSecretName]);
  fs.rmSync(keyDir, { recursive: true, force: true });
  await pool.query("DELETE FROM client_sessions WHERE token_hash = ANY($1)", [issuedTokens.map(sha256Hex)]);
  for (const id of createdProjectIds) {
    // Replies first: in_reply_to references another row of the same table.
    await pool.query("DELETE FROM client_messages WHERE project_id = $1 AND in_reply_to IS NOT NULL", [id]);
    await pool.query("DELETE FROM client_messages WHERE project_id = $1", [id]);
    await pool.query("DELETE FROM projects WHERE id = $1", [id]);
  }
  await pool.end();
});

describe("web client page", () => {
  test("is served with a strict CSP and nosniff, and carries no credential", async () => {
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/client");

    const page = await app.request("/client");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await page.text();
    expect(html).not.toMatch(/<script>|<script [^>]*>[^<]/);

    const script = await app.request("/client/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const js = await script.text();
    expect(js).not.toContain("innerHTML");
    expect(js).not.toContain("Authorization");
    for (const text of [html, js]) {
      expect(text).not.toContain(API_TOKEN);
      expect(text).not.toContain(ACCESS_CODE);
    }
  });
});

describe("client login", () => {
  test("the right code sets an HttpOnly SameSite=Strict session cookie; Secure off loopback http", async () => {
    const local = await login(app);
    expect(local.status).toBe(204);
    const cookie = local.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${TTL_SECONDS}`);
    expect(cookie).not.toContain("Secure");
    const token = sessionToken(local);
    const row = await db.$client.query("SELECT token_hash FROM client_sessions WHERE token_hash = $1", [
      sha256Hex(token),
    ]);
    expect(row.rowCount).toBe(1);

    const remote = await login(app, "https://ashara.example/client/login");
    expect(remote.status).toBe(204);
    expect(remote.headers.get("set-cookie")).toContain("Secure");
    sessionToken(remote);
  });

  test("a wrong code is 401 after the fixed delay and sets no cookie", async () => {
    const started = Date.now();
    const response = await app.request("/client/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
      body: JSON.stringify({ code: `${ACCESS_CODE}x` }),
    });
    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAILURE_DELAY_MS - 5);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("no access code in the store is 503 naming the secret and the command; never a default", async () => {
    const unconfigured = build({ secrets: memoryReader({}) });
    const response = await login(unconfigured);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: expect.stringContaining(`scripts/secret.ts put ${accessCodeSecretName}`) });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a stored code too short to resist guessing is 503, even when presented exactly", async () => {
    const weak = build({ secrets: memoryReader({ [accessCodeSecretName]: "short" }) });
    const response = await weak.request("/client/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
      body: JSON.stringify({ code: "short" }),
    });
    expect(response.status).toBe(503);
  });

  test("login without the client header is refused as a possible cross-site request", async () => {
    const response = await app.request("/client/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    expect(response.status).toBe(403);
  });
});

describe("client session", () => {
  test("the API rejects no cookie, a bearer token, and an unknown token; accepts a session", async () => {
    expect((await app.request("/client/api/projects")).status).toBe(401);
    const bearer = await app.request("/client/api/projects", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(bearer.status).toBe(401);
    const forged = await app.request("/client/api/projects", {
      headers: withSession(randomBytes(32).toString("base64url")),
    });
    expect(forged.status).toBe(401);

    const token = await loggedIn();
    expect((await app.request("/client/api/projects", { headers: withSession(token) })).status).toBe(200);
  });

  test("the operator API still requires the bearer token, and a session cookie does not open it", async () => {
    const token = await loggedIn();
    expect((await app.request("/config/models", { headers: withSession(token) })).status).toBe(401);
    const bearer = await app.request("/config/models", { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    expect(bearer.status).toBe(200);
  });

  test("a session survives a restart: a new app over the same database accepts it", async () => {
    const token = await loggedIn();
    const restarted = build();
    expect((await restarted.request("/client/api/projects", { headers: withSession(token) })).status).toBe(200);
  });

  test("logout revokes the session server-side", async () => {
    const token = await loggedIn();
    const out = await app.request("/client/logout", { method: "POST", headers: withSession(token, CLIENT_HEADER) });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("/client/api/projects", { headers: withSession(token) })).status).toBe(401);
    const row = await db.$client.query("SELECT revoked_at FROM client_sessions WHERE token_hash = $1", [
      sha256Hex(token),
    ]);
    expect(row.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  test("an expired session is rejected", async () => {
    const token = await loggedIn();
    await db.$client.query(
      "UPDATE client_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [sha256Hex(token)],
    );
    expect((await app.request("/client/api/projects", { headers: withSession(token) })).status).toBe(401);
  });

  test("a state-changing request without the client header is 403 and writes nothing", async () => {
    const token = await loggedIn();
    const projectName = `web-client-csrf-${randomUUID()}`;
    const response = await app.request("/client/api/tenders", {
      method: "POST",
      headers: withSession(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ projectName, body: "build it" }),
    });
    expect(response.status).toBe(403);
    const rows = await db.$client.query("SELECT id FROM projects WHERE name = $1", [projectName]);
    expect(rows.rowCount).toBe(0);
  });

  test("a client cannot post an outbound kind", async () => {
    const token = await loggedIn();
    const projectId = await postTender(token, `web-client-kinds-${randomUUID()}`, "build it");
    for (const kind of ["question", "report"]) {
      const response = await app.request(`/client/api/projects/${projectId}/messages`, {
        method: "POST",
        headers: withSession(token, { "Content-Type": "application/json", ...CLIENT_HEADER }),
        body: JSON.stringify({ kind, body: "spoofed" }),
      });
      expect(response.status).toBe(400);
    }
    const outbound = await db.$client.query(
      "SELECT id FROM client_messages WHERE project_id = $1 AND direction = 'outbound'",
      [projectId],
    );
    expect(outbound.rowCount).toBe(0);

    const listed = await app.request("/client/api/projects", { headers: withSession(token) });
    const projects: unknown = await listed.json();
    expect(projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectId })]));
  });
});

describe("recorded web-client session", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
        resolve(info.port),
      );
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("login, tender, a seeded question answered, stop; the inbound rows are in Postgres", async () => {
    const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-web-client-session-"));
    const transcript: string[] = [];
    const step = (text: string): void => {
      transcript.push(`${new Date().toISOString()} ${text}`);
    };
    const pageErrors: string[] = [];

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") pageErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(`${baseUrl}/`);
      await page.locator("#login-form").waitFor();
      step(`opened ${baseUrl}/, redirected to ${page.url()}; login form shown`);
      // The page probes for a session first; with no cookie yet that probe is a 401,
      // which the browser logs as a failed resource. Nothing else may be logged.
      const probeErrors = pageErrors.splice(0);
      expect(probeErrors.every((e) => e.includes("status of 401"))).toBe(true);
      step(`session probe before login: ${probeErrors.length} expected 401 console entry`);

      await page.fill("#login-code", ACCESS_CODE);
      await page.click("#login-form button[type=submit]");
      await page.locator("#workspace").waitFor();
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === CLIENT_SESSION_COOKIE);
      expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict" });
      if (session !== undefined) issuedTokens.push(session.value);
      expect(await page.evaluate(() => document.cookie)).toBe("");
      step("logged in with the access code; session cookie is HttpOnly, SameSite=Strict, invisible to page script");

      const projectName = `web-client-session-${randomUUID().slice(0, 8)}`;
      const tenderBody = "Build a command-line tool that counts words in a file.";
      await page.fill("#tender-name", projectName);
      await page.fill("#tender-body", tenderBody);
      await page.click("#tender-form button[type=submit]");
      await page.locator("#timeline li.kind-tender .msg-body", { hasText: tenderBody }).waitFor();
      step(`sent tender for project "${projectName}"; it appears in the timeline`);

      const projects = await new ProjectRepository(db).list();
      const project = projects.find((p) => p.name === projectName);
      if (project === undefined) throw new Error(`project ${projectName} not found after the tender`);

      // No production outbound writer exists until s-liaison-intake-m1; the test seeds one.
      // The markup in the body must arrive as text, never as an element.
      const questionBody = 'Which file encodings must it support? <img src="x" id="xss-probe">';
      const question = await new ClientMessageRepository(db).insertOutbound({
        projectId: project.id,
        kind: "question",
        body: questionBody,
        inReplyTo: null,
      });
      step(`seeded outbound question ${question.id} directly in Postgres`);

      const questionItem = page.locator(`#timeline li[data-message-id="${question.id}"]`);
      await questionItem.waitFor({ timeout: 15_000 });
      expect(await questionItem.locator(".msg-body").textContent()).toBe(questionBody);
      expect(await page.locator("#xss-probe").count()).toBe(0);
      step("the question appeared by polling; its markup rendered as text");

      const answerBody = "UTF-8 only.";
      await questionItem.locator("textarea").fill(answerBody);
      await questionItem.locator("button[type=submit]").click();
      await page.locator("#timeline li.kind-answer .msg-body", { hasText: answerBody }).waitFor();
      await questionItem.locator(".answered").waitFor();
      step("answered the question; the answer appears and the question shows as answered");

      await page.click("#stop-open");
      await page.locator("#stop-confirm").waitFor();
      const stopReason = "Budget moved to another project.";
      await page.fill("#stop-reason", stopReason);
      await page.click("#stop-confirm-button");
      await page.locator("#timeline li.kind-stop .msg-body", { hasText: stopReason }).waitFor();
      step("pressed Stop, confirmed in-page; the stop appears in the timeline");

      await page.screenshot({ path: path.join(recordDir, "session.png"), fullPage: true });

      const rows = await new ClientMessageRepository(db).listByProject(project.id);
      const summary = rows.map((r) => ({
        direction: r.direction,
        kind: r.kind,
        projectId: r.projectId,
        inReplyTo: r.inReplyTo,
      }));
      expect(summary).toEqual([
        { direction: "inbound", kind: "tender", projectId: project.id, inReplyTo: null },
        { direction: "outbound", kind: "question", projectId: project.id, inReplyTo: null },
        { direction: "inbound", kind: "answer", projectId: project.id, inReplyTo: question.id },
        { direction: "inbound", kind: "stop", projectId: project.id, inReplyTo: null },
      ]);
      step(`Postgres rows for project ${project.id}: ${JSON.stringify(summary)}`);

      expect(pageErrors).toEqual([]);
      step("no console error and no page error (a CSP violation would be a console error)");
    } finally {
      await browser.close();
      fs.writeFileSync(path.join(recordDir, "transcript.txt"), `${transcript.join("\n")}\n`);
      console.log(`web-client session recorded: ${recordDir} (transcript.txt, session.png)`);
    }
  });
});
