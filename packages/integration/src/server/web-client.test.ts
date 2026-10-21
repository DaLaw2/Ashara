// The web client: login, throttling, session, client scoping, CSRF and
// page headers against the composed app, then a recorded headless-browser session
// against a live port.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientLoginFailureRepository, ClientRepository, ClientSessionRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { SecretRepository } from "@ashara/security";
import { DevSessionRepository } from "@ashara/workplace";
import { ClientStops, ClientMessageRepository, createProjectWithTender, VisionRepository } from "@ashara/engagement";
import { clientAccessCodeSecretName, createKeyFile, loadMasterKey, SecretStore } from "@ashara/security";
import { memoryStepContainment, parseProjectId, recordingLogger } from "@ashara/shared";
import { buildApp } from "@ashara/server/app";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import type { AppDeps } from "@ashara/server/routes";
import type { SecretReader } from "@ashara/server/secrets";
import { CLIENT_SESSION_COOKIE, loadWebClientAssets } from "@ashara/server/web-client";
import type { WebClientDeps } from "@ashara/server/web-client";
import { ProjectHaltRepository, WorkItemRowRepository } from "@ashara/delivery";
import type { Database } from "../simulator/database.js";
import { sweepTerminalsOf } from "./terminal-sweeps.js";

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);
const API_TOKEN = `web-client-test-${randomUUID()}`;
const FAILURE_DELAY_MS = 150;
const TTL_SECONDS = 3600;
const THROTTLE = { windowSeconds: 15 * 60, perNameAndSource: 5, perSource: 20 };
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const CLIENT_HEADER = { "X-Ashara-Client": "1" };
const JSON_HEADERS = { "Content-Type": "application/json", ...CLIENT_HEADER };

interface TestClient {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

let db: Database;
let keyDir: string;
let keyFile: string;
let secretStore: SecretStore;
let app: Hono;
/** Client A: the default for every test that does not name one. */
let alice: TestClient;
/** Client B: must never see A's projects. */
let bob: TestClient;
/** A client used only by the throttling test, so its failures disturb nothing else. */
let throttled: TestClient;
const ourClientIds: string[] = [];
const ourClientNames: string[] = [];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function appDeps(): AppDeps {
  return {
    workItemRepo: new WorkItemRowRepository(db),
    eventStore: new EventStoreRepository(db),
    devSessionRepo: new DevSessionRepository(db),
    visionRepo: new VisionRepository(db),
    projectRepo: new ProjectHaltRepository(db),
    clientMessageRepo: new ClientMessageRepository(db),
    clientRepo: new ClientRepository(db),
    createTender: (clientId, projectName, body) => createProjectWithTender(db, clientId, projectName, body),
  };
}

function webClientDeps(overrides: Partial<WebClientDeps> = {}): WebClientDeps {
  const base = appDeps();
  return {
    projectRepo: base.projectRepo,
    clientMessageRepo: base.clientMessageRepo,
    clientRepo: base.clientRepo,
    createTender: base.createTender,
    secrets: secretStore,
    sessionRepo: new ClientSessionRepository(db),
    loginFailureRepo: new ClientLoginFailureRepository(db),
    loginThrottle: THROTTLE,
    sessionTtlSeconds: TTL_SECONDS,
    loginFailureDelayMs: FAILURE_DELAY_MS,
    assets: loadWebClientAssets(),
    ...overrides,
  };
}

function build(overrides: Partial<WebClientDeps> = {}): Hono {
  return buildApp(API_TOKEN, appDeps(), webClientDeps(overrides), recordingLogger());
}

async function newClient(label: string, storeCode = true): Promise<TestClient> {
  const name = `web-client-test-${NONCE}-${label}`;
  const row = await new ClientRepository(db).create(name);
  ourClientIds.push(row.id);
  ourClientNames.push(name);
  const code = randomBytes(24).toString("hex");
  if (storeCode) await secretStore.put(clientAccessCodeSecretName(row.id), code);
  return { id: row.id, name, code };
}

/** A documentation-range IPv6 address in a fresh /64, so tests that do not name one never share a throttle source. */
function freshAddress(): string {
  const [a, b, c] = randomBytes(6).toString("hex").match(/.{4}/g) ?? [];
  return `2001:db8:${a}:${b}:${c}::1`;
}

/** The Node adapter's bindings as a request over a socket from `address` carries them. */
function fromAddress(address: string): { incoming: { socket: { remoteAddress: string } } } {
  return { incoming: { socket: { remoteAddress: address } } };
}

async function attempt(
  target: Hono,
  client: string,
  code: string,
  options: { readonly url?: string; readonly address?: string } = {},
): Promise<Response> {
  return target.request(
    options.url ?? "http://localhost/client/login",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ client, code }) },
    fromAddress(options.address ?? freshAddress()),
  );
}

function login(target: Hono, who: TestClient = alice, options?: { url?: string; address?: string }): Promise<Response> {
  return attempt(target, who.name, who.code, options);
}

/** Runs an operator script from the repository root with this suite's key file; never throws on exit status. */
function runScript(args: readonly string[], input = ""): { status: number | null; output: string } {
  const result = spawnSync("npx", ["tsx", ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL, ASHARA_SECRET_KEY_FILE: keyFile },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function sessionCount(clientId: string): Promise<number> {
  const rows = await db.$client.query("SELECT count(*)::int AS n FROM client_sessions WHERE client_id = $1", [clientId]);
  return z.object({ n: z.number() }).parse(rows.rows[0]).n;
}

function sessionToken(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${CLIENT_SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (match === null) throw new Error(`no ${CLIENT_SESSION_COOKIE} cookie in: ${cookie}`);
  return match[1];
}

async function loggedIn(who: TestClient = alice, target: Hono = app): Promise<string> {
  const response = await login(target, who);
  expect(response.status).toBe(204);
  return sessionToken(response);
}

function withSession(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `${CLIENT_SESSION_COOKIE}=${token}`, ...extra };
}

async function postTender(token: string, projectName: string, body: string): Promise<string> {
  const response = await app.request("/client/api/tenders", {
    method: "POST",
    headers: withSession(token, JSON_HEADERS),
    body: JSON.stringify({ projectName, body }),
  });
  expect(response.status).toBe(201);
  const created = z.object({ projectId: z.uuid() }).parse(await response.json());
  return parseProjectId(created.projectId, "test");
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
  // A throwaway master key; every secret written is named by a client id this run created.
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-web-client-key-"));
  keyFile = path.join(keyDir, "secret.key");
  createKeyFile(keyFile);
  secretStore = new SecretStore(new SecretRepository(db), loadMasterKey(keyFile));
  alice = await newClient("alice");
  bob = await newClient("bob");
  throttled = await newClient("throttled");
  app = build();
});

afterAll(async () => {
  const pool = db.$client;
  const ours = "SELECT id FROM projects WHERE client_id = ANY($1)";
  await pool.query(`DELETE FROM vision_documents WHERE project_id IN (${ours})`, [ourClientIds]);
  // Replies first: in_reply_to references another row of the same table.
  await pool.query(`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${ours})`, [
    ourClientIds,
  ]);
  await pool.query(`DELETE FROM client_messages WHERE project_id IN (${ours})`, [ourClientIds]);
  await pool.query("DELETE FROM projects WHERE client_id = ANY($1)", [ourClientIds]);
  await pool.query("DELETE FROM client_sessions WHERE client_id = ANY($1)", [ourClientIds]);
  await pool.query("DELETE FROM secrets WHERE name = ANY($1)", [ourClientIds.map(clientAccessCodeSecretName)]);
  await pool.query("DELETE FROM client_login_failures WHERE client_name LIKE $1", [`web-client-test-${NONCE}-%`]);
  await pool.query("DELETE FROM clients WHERE id = ANY($1)", [ourClientIds]);
  fs.rmSync(keyDir, { recursive: true, force: true });
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
      expect(text).not.toContain(alice.code);
    }
  });
});

describe("client login", () => {
  test("the right name and code set an HttpOnly SameSite=Strict session bound to that client", async () => {
    const local = await login(app);
    expect(local.status).toBe(204);
    const cookie = local.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${TTL_SECONDS}`);
    expect(cookie).not.toContain("Secure");
    const token = sessionToken(local);
    const row = await db.$client.query("SELECT client_id FROM client_sessions WHERE token_hash = $1", [
      sha256Hex(token),
    ]);
    expect(row.rows).toEqual([{ client_id: alice.id }]);

    const remote = await login(app, alice, { url: "https://ashara.example/client/login" });
    expect(remote.status).toBe(204);
    expect(remote.headers.get("set-cookie")).toContain("Secure");
  });

  test("unknown name, known name without a code, a too-short stored code and a wrong code answer identically", async () => {
    const codeless = await newClient("codeless", false);
    const weak = build({
      secrets: memoryReader({ [clientAccessCodeSecretName(alice.id)]: "short", [clientAccessCodeSecretName(bob.id)]: bob.code }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers: { status: number; body: unknown; elapsed: number; cookie: string | null }[] = [];
    try {
      for (const [target, client, code] of [
        [app, alice.name, `${alice.code}x`],
        [app, `web-client-test-${NONCE}-nobody`, alice.code],
        [app, codeless.name, codeless.code],
        [weak, alice.name, "short"],
        [app, alice.name, bob.code],
      ] as const) {
        const started = Date.now();
        const response = await attempt(target, client, code);
        answers.push({
          status: response.status,
          body: await response.json(),
          elapsed: Date.now() - started,
          cookie: response.headers.get("set-cookie"),
        });
      }
      // The operator still learns why the codeless client cannot log in, from the log only.
      const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain(`scripts/client.ts set-code "${codeless.name}"`);
      expect(JSON.stringify(answers)).not.toContain(codeless.id);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: "client name or access code rejected" });
      expect(answer.elapsed).toBeGreaterThanOrEqual(FAILURE_DELAY_MS - 5);
      expect(answer.cookie).toBeNull();
    }
    // A success clears this address's failures for the name; other addresses' stay counted.
    const from = freshAddress();
    expect((await attempt(app, alice.name, "wrong-code-from-a-known-address", { address: from })).status).toBe(401);
    expect((await login(app, alice, { address: from })).status).toBe(204);
    const left = await db.$client.query(
      "SELECT count(*)::int AS n FROM client_login_failures WHERE client_name = $1 AND source_address = $2",
      [alice.name, from],
    );
    expect(left.rows).toEqual([{ n: 0 }]);
  });

  test("5 failures from one address close login there with 429, across an app re-create, until the window passes", async () => {
    const from = freshAddress();
    for (let i = 0; i < THROTTLE.perNameAndSource; i++) {
      expect((await attempt(app, throttled.name, `wrong-${i}`, { address: from })).status).toBe(401);
    }
    const blocked = await login(app, throttled, { address: from });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();

    // A restart keeps the throttle: a new app over the same database still refuses.
    const restarted = build();
    expect((await login(restarted, throttled, { address: from })).status).toBe(429);

    // Once the failures fall out of the window, the right code works again.
    await db.$client.query(
      "UPDATE client_login_failures SET failed_at = now() - make_interval(secs => $2) WHERE client_name = $1",
      [throttled.name, THROTTLE.windowSeconds + 60],
    );
    expect((await login(restarted, throttled, { address: from })).status).toBe(204);
  });

  test("a burst of 40 parallel wrong codes gets exactly the cap evaluated; another address still logs in", async () => {
    const target = await newClient("burst");
    const attacker = freshAddress();
    const statuses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => attempt(app, target.name, `burst-wrong-${i}`, { address: attacker })),
    ).then((responses) => responses.map((r) => r.status));
    expect(statuses.filter((s) => s === 401)).toHaveLength(THROTTLE.perNameAndSource);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40 - THROTTLE.perNameAndSource);

    // The attacker's address stays closed, even to the right code; the client's own address is open.
    expect((await login(app, target, { address: attacker })).status).toBe(429);
    expect((await login(app, target, { address: freshAddress() })).status).toBe(204);
    const counted = await db.$client.query("SELECT count(*)::int AS n FROM client_login_failures WHERE client_name = $1", [
      target.name,
    ]);
    expect(counted.rows).toEqual([{ n: THROTTLE.perNameAndSource }]);
  });

  test("no number of other sources closes a client out; one /64 counts as one source", async () => {
    const tight = build({ loginThrottle: { ...THROTTLE, perNameAndSource: 2, perSource: 3 } });
    const target = await newClient("lockout");
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Many sources, each up to its cap, against one name and against made-up names.
      const statuses = await Promise.all(
        Array.from({ length: 20 }, async (_, s) => {
          const from = freshAddress();
          return [
            (await attempt(tight, target.name, `spread-${s}-a`, { address: from })).status,
            (await attempt(tight, target.name, `spread-${s}-b`, { address: from })).status,
            (await attempt(tight, `web-client-test-${NONCE}-walk-${s}`, "x", { address: from })).status,
            (await attempt(tight, target.name, `spread-${s}-c`, { address: from })).status,
          ];
        }),
      );
      // Each source reached its own caps: two failures for the name, three in all.
      expect(statuses.every((s) => s.join() === "401,401,401,429")).toBe(true);
      expect((await login(tight, target)).status).toBe(204);
      expect((await login(tight, bob)).status).toBe(204);

      // Varying the interface identifier inside one /64 buys no new attempts.
      const host = freshAddress().replace(/::1$/, "");
      for (let i = 0; i < 3; i++) {
        const address = `${host}::${(i + 2).toString(16)}`;
        expect((await attempt(tight, `web-client-test-${NONCE}-walk-v6-${i}`, "x", { address })).status).toBe(401);
      }
      expect((await login(tight, bob, { address: `${host}::ffff` })).status).toBe(429);
    } finally {
      warns.mockRestore();
    }
  });

  test("a request with no socket address is refused before any attempt is counted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request("http://localhost/client/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ client: alice.name, code: alice.code }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  test("setting a new code deletes the client's sessions; revoke-sessions deletes them alone", async () => {
    const rotated = await newClient("rotated");
    const first = await loggedIn(rotated);
    const second = await loggedIn(rotated);
    expect(await sessionCount(rotated.id)).toBe(2);

    const newCode = randomBytes(24).toString("hex");
    const setCode = runScript(["scripts/client.ts", "set-code", rotated.name], newCode);
    expect(setCode.output).toContain("deleted 2 session(s)");
    expect(setCode.status).toBe(0);
    expect(await sessionCount(rotated.id)).toBe(0);
    for (const token of [first, second]) {
      expect((await app.request("/client/api/projects", { headers: withSession(token) })).status).toBe(401);
    }
    expect((await login(app, rotated)).status).toBe(401);
    const third = await loggedIn({ ...rotated, code: newCode });

    const revoke = runScript(["scripts/client.ts", "revoke-sessions", rotated.name]);
    expect(revoke.output).toContain("Deleted 1 session(s)");
    expect(revoke.status).toBe(0);
    expect((await app.request("/client/api/projects", { headers: withSession(third) })).status).toBe(401);

    // The generic secret tool refuses a client access code, so no code changes with its sessions left alive.
    const bypass = runScript(["scripts/secret.ts", "put", clientAccessCodeSecretName(rotated.id)], "x".repeat(40));
    expect(bypass.status).toBe(1);
    expect(bypass.output).toContain("scripts/client.ts set-code");
    const fourth = await loggedIn({ ...rotated, code: newCode });

    // Removing the code ends its sessions too, and login is then refused like a wrong code.
    const removed = runScript(["scripts/client.ts", "remove-code", rotated.name]);
    expect(removed.output).toContain("deleted 1 session(s)");
    expect(removed.status).toBe(0);
    expect((await app.request("/client/api/projects", { headers: withSession(fourth) })).status).toBe(401);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await login(app, { ...rotated, code: newCode })).status).toBe(401);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  test("a login body that is not JSON is 400 with a generic error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await app.request("/client/login", { method: "POST", headers: JSON_HEADERS, body: "{code" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "request body is not valid JSON" });
    } finally {
      warn.mockRestore();
    }
  });

  test("login without the client header is refused as a possible cross-site request", async () => {
    const response = await app.request("/client/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: alice.name, code: alice.code }),
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
    const workItems = `/projects/${randomUUID()}/work-items`;
    expect((await app.request(workItems, { headers: withSession(token) })).status).toBe(401);
    const bearer = await app.request(workItems, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
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

  test("an expired session is rejected, and a login deletes sessions ended over a day ago", async () => {
    const token = await loggedIn();
    await db.$client.query(
      "UPDATE client_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [sha256Hex(token)],
    );
    expect((await app.request("/client/api/projects", { headers: withSession(token) })).status).toBe(401);

    await db.$client.query(
      "UPDATE client_sessions SET created_at = now() - interval '3 days', expires_at = now() - interval '2 days' WHERE token_hash = $1",
      [sha256Hex(token)],
    );
    await loggedIn();
    const gone = await db.$client.query("SELECT 1 FROM client_sessions WHERE token_hash = $1", [sha256Hex(token)]);
    expect(gone.rowCount).toBe(0);
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
        headers: withSession(token, JSON_HEADERS),
        body: JSON.stringify({ kind, body: "spoofed" }),
      });
      expect(response.status).toBe(400);
    }
    const outbound = await db.$client.query(
      "SELECT id FROM client_messages WHERE project_id = $1 AND direction = 'outbound'",
      [projectId],
    );
    expect(outbound.rowCount).toBe(0);
  });
});

describe("client scoping", () => {
  test("client B cannot list, read, answer or stop client A's project: 404 each, nothing written", async () => {
    const aliceToken = await loggedIn(alice);
    const bobToken = await loggedIn(bob);
    const aliceProject = await postTender(aliceToken, `web-client-scope-a-${randomUUID()}`, "A's project");
    const bobProject = await postTender(bobToken, `web-client-scope-b-${randomUUID()}`, "B's project");
    const owner = await db.$client.query("SELECT client_id FROM projects WHERE id = $1", [aliceProject]);
    expect(owner.rows).toEqual([{ client_id: alice.id }]);

    const question = await new ClientMessageRepository(db).insertOutbound({
      projectId: parseProjectId(aliceProject, "test"),
      kind: "question",
      body: "Which colour?",
      inReplyTo: null,
    });

    const listed = z
      .array(z.object({ id: z.string() }))
      .parse(await (await app.request("/client/api/projects", { headers: withSession(bobToken) })).json())
      .map((p) => p.id);
    expect(listed).toContain(bobProject);
    expect(listed).not.toContain(aliceProject);

    const unknown = await app.request(`/client/api/projects/${randomUUID()}/messages`, {
      headers: withSession(bobToken),
    });
    const read = await app.request(`/client/api/projects/${aliceProject}/messages`, {
      headers: withSession(bobToken),
    });
    expect(read.status).toBe(404);
    expect(unknown.status).toBe(404);

    for (const post of [
      { kind: "answer", body: "Red.", inReplyTo: question.id },
      { kind: "stop", body: "Stop it." },
      { kind: "change", body: "Change it." },
    ]) {
      const response = await app.request(`/client/api/projects/${aliceProject}/messages`, {
        method: "POST",
        headers: withSession(bobToken, JSON_HEADERS),
        body: JSON.stringify(post),
      });
      expect(response.status).toBe(404);
    }
    const inbound = await db.$client.query(
      "SELECT kind FROM client_messages WHERE project_id = $1 AND direction = 'inbound'",
      [aliceProject],
    );
    expect(inbound.rows).toEqual([{ kind: "tender" }]);

    // The owner still reaches it.
    const own = await app.request(`/client/api/projects/${aliceProject}/messages`, {
      headers: withSession(aliceToken),
    });
    expect(own.status).toBe(200);
  });

  test("a question answered once rejects a second answer with 409", async () => {
    const token = await loggedIn(alice);
    const projectId = await postTender(token, `web-client-answer-twice-${randomUUID()}`, "build it");
    const question = await new ClientMessageRepository(db).insertOutbound({
      projectId: parseProjectId(projectId, "test"),
      kind: "question",
      body: "Which encoding?",
      inReplyTo: null,
    });
    const answer = async (body: string): Promise<Response> =>
      app.request(`/client/api/projects/${projectId}/messages`, {
        method: "POST",
        headers: withSession(token, JSON_HEADERS),
        body: JSON.stringify({ kind: "answer", body, inReplyTo: question.id }),
      });
    expect((await answer("UTF-8.")).status).toBe(201);
    expect((await answer("Latin-1.")).status).toBe(409);
    const answers = await db.$client.query("SELECT body FROM client_messages WHERE in_reply_to = $1", [question.id]);
    expect(answers.rows).toEqual([{ body: "UTF-8." }]);
  });
});

class ListingRefused extends Error {
  constructor() {
    super("work item listing refused by the test repository: row 42 holds secret-detail");
    this.name = "ListingRefused";
  }
}

class RefusingWorkItemRepository extends WorkItemRowRepository {
  override async listByProject(): ReturnType<WorkItemRowRepository["listByProject"]> {
    throw new ListingRefused();
  }
}

describe("request trace", () => {
  test("every response, a page, a refusal and an unhandled error alike, names the new trace its request ran in", async () => {
    const logger = recordingLogger();
    const traced = buildApp(API_TOKEN, { ...appDeps(), workItemRepo: new RefusingWorkItemRepository(db) }, webClientDeps(), logger);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses: Response[] = [];
    try {
      responses.push(await traced.request("/client"));
      responses.push(await traced.request("/client/api/projects"));
      responses.push(await traced.request(`/projects/${randomUUID()}/work-items`, { headers: { Authorization: `Bearer ${API_TOKEN}` } }));
    } finally {
      logged.mockRestore();
    }
    expect(responses.map((response) => response.status)).toEqual([200, 401, 500]);
    const traces = responses.map((response) => response.headers.get("x-ashara-trace"));
    for (const trace of traces) expect(trace).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(traces).size).toBe(3);
    expect(traces).not.toContain(logger.trace());
  });
});

describe("unhandled route error", () => {
  test("is logged with its operation and chain, and answered with a typed 500 that carries no detail", async () => {
    const failing = buildApp(API_TOKEN, { ...appDeps(), workItemRepo: new RefusingWorkItemRepository(db) }, webClientDeps(), recordingLogger());
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const route = `/projects/${randomUUID()}/work-items`;
      const response = await failing.request(route, { headers: { Authorization: `Bearer ${API_TOKEN}` } });

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("secret-detail");
      expect(JSON.parse(text)).toEqual({ error: "internal server error", errorClass: "InternalServerError", operation: `GET ${route}` });
      const line = logged.mock.calls.map((call) => String(call[0])).find((first) => first.includes(`GET ${route}`));
      expect(line).toContain("ListingRefused");
      expect(line).toContain("secret-detail");
    } finally {
      logged.mockRestore();
    }
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

  test("login, tender, a seeded question answered, a report shown, stop; the rows are in Postgres", async () => {
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

      await page.fill("#login-client", alice.name);
      await page.fill("#login-code", alice.code);
      await page.click("#login-form button[type=submit]");
      await page.locator("#workspace").waitFor();
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === CLIENT_SESSION_COOKIE);
      expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict" });
      expect(await page.evaluate(() => document.cookie)).toBe("");
      step(
        `logged in as client "${alice.name}" with its access code; session cookie is HttpOnly, SameSite=Strict, ` +
          "invisible to page script",
      );

      const projectName = `web-client-session-${randomUUID().slice(0, 8)}`;
      const tenderBody = "Build a command-line tool that counts words in a file.";
      await page.fill("#tender-name", projectName);
      await page.fill("#tender-body", tenderBody);
      await page.click("#tender-form button[type=submit]");
      await page.locator("#timeline li.kind-tender .msg-body", { hasText: tenderBody }).waitFor();
      step(`sent tender for project "${projectName}"; it appears in the timeline`);

      const projects = await new ProjectHaltRepository(db).listByClient(alice.id);
      const project = projects.find((p) => p.name === projectName);
      if (project === undefined) throw new Error(`project ${projectName} not found after the tender`);

      // The production question writer is the Liaison's intake (recordTenderIntake), which
      // also writes an LLM-derived vision; the test inserts the question through the
      // repository that intake writes through. The report below goes through a
      // production writer. The markup in the body must arrive as text, never as an element.
      const questionBody = 'Which file encodings must it support? <img src="x" id="xss-probe">';
      const question = await new ClientMessageRepository(db).insertOutbound({
        projectId: project.id,
        kind: "question",
        body: questionBody,
        inReplyTo: null,
      });
      step(`seeded outbound question ${question.id} through ClientMessageRepository.insertOutbound`);

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

      // A report through the intake store the server composes (createIntakeStore), the
      // path the Liaison takes when it has read a tender: tender consumed, vision v1 written,
      // its contract draft posted.
      const intakeStore = createIntakeStore(db);
      const tender = (await intakeStore.openTenders()).find((t) => t.projectId === project.id);
      if (tender === undefined) throw new Error(`no open tender for project ${project.id}`);
      const reportBody = "This is the contract we are working to, drafted from your tender.";
      const quoted = (quote: string) => ({ kind: "tender" as const, quote });
      await intakeStore.recordIntake({
        tender,
        questions: [],
        contractDraft: reportBody,
        readingReport: null,
        reading: {
          first: { provider: "stub", model: "stub-model", grade: "Strong" },
          firstQuestions: 0,
          confirmation: {
            kind: "unconfirmed",
            passedOver: [
              { strength: "other-family", outcome: "unavailable", reason: "no other family in the test catalog" },
              { strength: "same-family-other-model", outcome: "unavailable", reason: "no other model in the test catalog" },
              { strength: "same-model", outcome: "unavailable", reason: "no second reading in the test" },
            ],
          },
        },
        vision: () => ({
          visionText: tenderBody,
          summary: "A word counter.",
          contract: {
            interface: [{ id: "I1", text: "wordcount FILE prints the count.", source: quoted("command-line tool") }],
            guarantees: [
              {
                id: "G1",
                statement: "It prints how many words the file holds.",
                observable: { interface: ["I1"], observation: "output" },
                refutedBy: ["It prints another count."],
                source: quoted("counts words in a file"),
              },
            ],
            exclusions: [],
          },
          inferences: [],
          openQuestions: [],
        }),
      });
      const reportItem = page.locator("#timeline li.kind-report", { hasText: reportBody });
      await reportItem.waitFor({ timeout: 15_000 });
      expect(await reportItem.locator(".msg-meta").textContent()).toContain("Report from Ashara");
      expect(await reportItem.locator(".msg-body").textContent()).toBe(reportBody);
      step(
        `posted an outbound contract draft through the intake store's recordIntake; it appeared by polling as ` +
          `"${(await reportItem.innerText()).replace(/\s+/g, " ")}"`,
      );

      await page.click("#stop-open");
      await page.locator("#stop-confirm").waitFor();
      const stopReason = "Budget moved to another project.";
      await page.fill("#stop-reason", stopReason);
      await page.click("#stop-confirm-button");
      await page.locator("#timeline li.kind-stop .msg-body", { hasText: stopReason }).waitFor();
      await page.locator("#project-state", { hasText: "Stop requested" }).waitFor();
      expect(await page.locator("#stop-open").isHidden()).toBe(true);
      step("pressed Stop, confirmed in-page; the stop appears in the timeline, shown as requested, Stop no longer offered");

      // The Liaison's production stop step, narrowed to this project so no other suite's stop is consumed.
      // The stop's report is posted after its terminal sweep, which the loop records between the two steps.
      const stopStore = createClientStopStore(db);
      const liaison = new ClientStops({
        ...stopStore,
        openStops: async () => (await stopStore.openStops()).filter((s) => s.projectId === project.id),
        dueStopReports: async () => (await stopStore.dueStopReports()).filter((due) => due.projectId === project.id),
      }, memoryStepContainment(() => true));
      expect(await liaison.runPending()).toMatchObject([{ kind: "stopped", reportDue: true, projectId: project.id }]);
      await sweepTerminalsOf(db, (id) => id === project.id);
      expect(await liaison.reportPending()).toMatchObject([{ kind: "posted", projectId: project.id }]);
      const stoppedState = page.locator('#project-state[data-status="stopped"]');
      await stoppedState.waitFor({ timeout: 15_000 });
      expect(await stoppedState.textContent()).toContain("Stopped at your request");
      expect(await page.locator("#stop-open").isHidden()).toBe(true);
      expect(await page.locator(`#projects button[data-project-id="${project.id}"]`).textContent()).toBe(
        `${projectName} (stopped)`,
      );
      const stopReportItem = page.locator("#timeline li.kind-report", { hasText: "stopped at your request" });
      await stopReportItem.waitFor({ timeout: 15_000 });
      expect(await stopReportItem.locator(".msg-body").textContent()).toContain("No merged work is on record for this project.");
      step(
        `the Liaison consumed the stop; the page shows "${await stoppedState.textContent()}", no Stop button, ` +
          `and the report "${(await stopReportItem.locator(".msg-body").innerText()).replace(/\s+/g, " ")}"`,
      );

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
        { direction: "outbound", kind: "report", projectId: project.id, inReplyTo: tender.id },
        { direction: "inbound", kind: "stop", projectId: project.id, inReplyTo: null },
        { direction: "outbound", kind: "report", projectId: project.id, inReplyTo: expect.any(String) },
      ]);
      expect((await new ProjectHaltRepository(db).get(project.id))?.status).toBe("stopped");
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
