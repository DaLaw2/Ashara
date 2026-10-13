import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ClientLoginFailureRepository, ClientSessionRepository } from "@ashara/db";
import { MIN_CLIENT_ACCESS_CODE_LENGTH, clientAccessCodeSecretName } from "@ashara/security";
import {
  listClientMessages,
  notJson,
  postClientMessage,
  readJsonBody,
  submitTender,
} from "./client-channel.js";
import type { ChannelCaller, ClientChannelDeps } from "./client-channel.js";
import type { SecretReader } from "./secrets.js";

// The web client (ADR-076): one static page, one plain script and one stylesheet,
// served by this process with no build step, plus a session-authenticated copy of
// the client channel under /client/api. The browser never holds the server's API
// token: a client logs in with its name and its own access code from the secret
// store, and gets a random session token in an HttpOnly cookie, stored server-side
// only as its hash and bound to that one client (migration 018).

/** @testseam web-client.test.ts reads and sends the session cookie by name */
export const CLIENT_SESSION_COOKIE = "ashara_client";

/**
 * Required on every state-changing /client request. A cross-site form cannot set
 * a custom header, and a cross-site fetch that sets one needs a CORS preflight this
 * server never grants, so the header is CSRF defence independent of SameSite.
 */
const CLIENT_REQUEST_HEADER = "X-Ashara-Client";

/** Ended sessions are kept this long after they end, then deleted at the next login. */
const ENDED_SESSION_RETENTION_SECONDS = 24 * 60 * 60;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const LoginSchema = z.strictObject({
  client: z.string().min(1).max(200),
  code: z.string().min(1).max(1024),
});

/** Unknown client and wrong code answer with this one body, after the same delay. */
const LOGIN_REJECTED = { error: "client name or access code rejected" };

export interface WebClientAssets {
  readonly html: string;
  readonly script: string;
  readonly stylesheet: string;
}

/** A web client asset file could not be read at startup. */
class WebClientAssetMissing extends Error {
  constructor(
    readonly path: string,
    options: ErrorOptions,
  ) {
    super(`web client asset could not be read: ${path}`, options);
    this.name = "WebClientAssetMissing";
  }
}

/** A /client/api handler ran without the client id the session middleware sets. */
class ClientSessionMissing extends Error {
  constructor(readonly path: string) {
    super(`web client route ${path} ran without a session client id; the session middleware did not run`);
    this.name = "ClientSessionMissing";
  }
}

function readAsset(dir: URL, name: string): string {
  const path = fileURLToPath(new URL(name, dir));
  try {
    return readFileSync(path, "utf8");
  } catch (err: unknown) {
    throw new WebClientAssetMissing(path, { cause: err });
  }
}

/** Read once at startup: a missing asset stops the server, not the first visitor. */
export function loadWebClientAssets(): WebClientAssets {
  const dir = new URL("../web/", import.meta.url);
  return {
    html: readAsset(dir, "index.html"),
    script: readAsset(dir, "app.js"),
    stylesheet: readAsset(dir, "app.css"),
  };
}

/** At `maxFailures` failed logins for one client name within `windowSeconds`, login answers 429. */
interface LoginThrottle {
  readonly maxFailures: number;
  readonly windowSeconds: number;
}

export interface WebClientDeps extends ClientChannelDeps {
  readonly secrets: SecretReader;
  readonly sessionRepo: ClientSessionRepository;
  readonly loginFailureRepo: ClientLoginFailureRepository;
  readonly loginThrottle: LoginThrottle;
  readonly sessionTtlSeconds: number;
  /** Every failed login waits this long before answering. */
  readonly loginFailureDelayMs: number;
  readonly assets: WebClientAssets;
}

type WebClientEnv = { Variables: { clientId: string } };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashToken(token: string): string {
  return sha256(token).toString("hex");
}

/** Digests have equal length, so the comparison leaks neither content nor length. */
function codeMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Loopback over plain http is the one case where the cookie omits Secure: WebKit
 * rejects a Secure cookie set by http://localhost (Chromium and Firefox accept it),
 * and loopback traffic never leaves the host. Every other request gets Secure, so a
 * deployment reached over http by a non-loopback name cannot log in at all.
 */
function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionClientId(c: Context<WebClientEnv>): string {
  const clientId = c.get("clientId");
  if (typeof clientId !== "string" || clientId === "") throw new ClientSessionMissing(c.req.path);
  return clientId;
}

function sessionCaller(c: Context<WebClientEnv>): ChannelCaller {
  return { kind: "client", clientId: sessionClientId(c) };
}

const requireClientHeader: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header(CLIENT_REQUEST_HEADER) !== "1") {
    return c.json(
      { error: `state-changing client requests must carry the header ${CLIENT_REQUEST_HEADER}: 1` },
      403,
    );
  }
  return next();
};

const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
};

/**
 * The stored code for this client, or why login cannot run: absent, or too short
 * to carry the entropy a login needs. The browser gets a generic 503; the
 * operator's instruction goes to the server log.
 */
async function storedAccessCode(
  deps: WebClientDeps,
  client: { readonly id: string; readonly name: string },
): Promise<{ readonly ok: true; readonly code: string } | { readonly ok: false }> {
  const secretName = clientAccessCodeSecretName(client.id);
  const fix =
    `The operator stores one with \`read -rs C && printf '%s' "$C" | npx tsx scripts/secret.ts put ${secretName}\` ` +
    `(at least ${MIN_CLIENT_ACCESS_CODE_LENGTH} characters).`;
  if (!(await deps.secrets.has(secretName))) {
    console.error(
      `[web-client] login refused for client "${client.name}" (${client.id}): the secret store has no "${secretName}". ${fix}`,
    );
    return { ok: false };
  }
  const code = await deps.secrets.get(secretName);
  if (code.length < MIN_CLIENT_ACCESS_CODE_LENGTH) {
    console.error(
      `[web-client] login refused for client "${client.name}" (${client.id}): the stored "${secretName}" is shorter ` +
        `than ${MIN_CLIENT_ACCESS_CODE_LENGTH} characters, too weak to guard a login. ${fix}`,
    );
    return { ok: false };
  }
  return { ok: true, code };
}

export function createWebClientRoutes(deps: WebClientDeps): Hono<WebClientEnv> {
  const app = new Hono<WebClientEnv>();
  const { maxFailures, windowSeconds } = deps.loginThrottle;

  // "/client/*" also matches "/client" itself.
  app.use("/client/*", securityHeaders);
  app.use("/client/*", requireClientHeader);

  app.use("/client/api/*", async (c, next) => {
    const token = getCookie(c, CLIENT_SESSION_COOKIE);
    const session = token === undefined ? null : await deps.sessionRepo.findActive(hashToken(token));
    if (session === null) {
      return c.json({ error: "no valid client session; log in at /client" }, 401);
    }
    c.set("clientId", session.clientId);
    return next();
  });

  app.get("/", (c) => c.redirect("/client"));
  app.get("/client", (c) => c.html(deps.assets.html));
  app.get("/client/app.js", (c) =>
    c.body(deps.assets.script, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );
  app.get("/client/app.css", (c) =>
    c.body(deps.assets.stylesheet, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );

  app.post("/client/login", async (c) => {
    const json = await readJsonBody(() => c.req.json());
    if (!json.ok) return c.json(notJson("client login", json).body, 400);
    const parsed = LoginSchema.safeParse(json.value);
    if (!parsed.success) {
      return c.json({ error: "invalid login", issues: parsed.error.issues }, 400);
    }
    const { client: clientName, code } = parsed.data;

    // Counted by the name as presented, so an unknown name is throttled exactly
    // like a known one and the 429 reveals nothing about which names exist.
    const recentFailures = await deps.loginFailureRepo.countWithin(clientName, windowSeconds);
    if (recentFailures >= maxFailures) {
      console.warn(
        `[web-client] login throttled for client name "${clientName}": ${recentFailures} failures ` +
          `within ${windowSeconds}s (limit ${maxFailures})`,
      );
      c.header("Retry-After", String(windowSeconds));
      return c.json({ error: "too many failed logins; try again later" }, 429);
    }

    const client = await deps.clientRepo.findByName(clientName);
    let expected: string | null = null;
    if (client !== null) {
      const stored = await storedAccessCode(deps, client);
      if (!stored.ok) return c.json({ error: "client login is temporarily unavailable" }, 503);
      expected = stored.code;
    }

    // An unknown client still pays for a comparison, so both rejections do the same work.
    const matched = codeMatches(code, expected ?? "") && expected !== null;
    if (client === null || !matched) {
      await deps.loginFailureRepo.record(clientName, windowSeconds);
      console.warn(
        `[web-client] login failed for client name "${clientName}": ` +
          `${client === null ? "no such client" : "wrong access code"} ` +
          `(${recentFailures + 1} within ${windowSeconds}s, limit ${maxFailures})`,
      );
      await delay(deps.loginFailureDelayMs);
      return c.json(LOGIN_REJECTED, 401);
    }

    await deps.loginFailureRepo.purge(clientName);
    await deps.sessionRepo.deleteEndedBefore(ENDED_SESSION_RETENTION_SECONDS);
    const token = randomBytes(32).toString("base64url");
    await deps.sessionRepo.create(hashToken(token), client.id, deps.sessionTtlSeconds);
    setCookie(c, CLIENT_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: deps.sessionTtlSeconds,
      secure: !isLoopbackHttp(new URL(c.req.url)),
    });
    return c.body(null, 204);
  });

  app.post("/client/logout", async (c) => {
    const token = getCookie(c, CLIENT_SESSION_COOKIE);
    if (token !== undefined) await deps.sessionRepo.revoke(hashToken(token));
    setCookie(c, CLIENT_SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 0,
      secure: !isLoopbackHttp(new URL(c.req.url)),
    });
    return c.body(null, 204);
  });

  app.post("/client/api/tenders", async (c) => {
    const result = await submitTender(deps, sessionCaller(c), await readJsonBody(() => c.req.json()));
    return c.json(result.body, result.status);
  });

  app.get("/client/api/projects", async (c) => {
    const projects = await deps.projectRepo.listByClient(sessionClientId(c));
    return c.json(projects.map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt })));
  });

  app.get("/client/api/projects/:projectId/messages", async (c) => {
    const result = await listClientMessages(deps, sessionCaller(c), c.req.param("projectId"), c.req.query());
    return c.json(result.body, result.status);
  });

  app.post("/client/api/projects/:projectId/messages", async (c) => {
    const json = await readJsonBody(() => c.req.json());
    const result = await postClientMessage(deps, sessionCaller(c), c.req.param("projectId"), json);
    return c.json(result.body, result.status);
  });

  return app;
}
