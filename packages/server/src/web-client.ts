import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ClientSessionRepository } from "@ashara/db";
import {
  listClientMessages,
  postClientMessage,
  readJsonBody,
  submitTender,
} from "./client-channel.js";
import type { ClientChannelDeps } from "./client-channel.js";
import type { SecretReader } from "./secrets.js";

// The web client (ADR-076): one static page, one plain script and one stylesheet,
// served by this process with no build step, plus a session-authenticated copy of
// the client channel under /client/api. The browser never holds the server's API
// token: a client logs in with the access code from the secret store and gets a
// random session token in an HttpOnly cookie, stored server-side only as its hash.

export const CLIENT_SESSION_COOKIE = "ashara_client";

/**
 * Required on every state-changing /client request. A cross-site form cannot set
 * a custom header, and a cross-site fetch that sets one needs a CORS preflight this
 * server never grants, so the header is CSRF defence independent of SameSite.
 */
export const CLIENT_REQUEST_HEADER = "X-Ashara-Client";

/**
 * Below this length the fixed failure delay is no defence: the code itself must
 * carry the entropy. Login refuses to run against a shorter stored code.
 */
const MIN_ACCESS_CODE_LENGTH = 20;

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

const LoginSchema = z.strictObject({ code: z.string().min(1) });

export interface WebClientAssets {
  readonly html: string;
  readonly script: string;
  readonly stylesheet: string;
}

/** A web client asset file could not be read at startup. */
export class WebClientAssetMissing extends Error {
  constructor(
    readonly path: string,
    options: ErrorOptions,
  ) {
    super(`web client asset could not be read: ${path}`, options);
    this.name = "WebClientAssetMissing";
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

export interface WebClientDeps extends ClientChannelDeps {
  readonly secrets: SecretReader;
  /** Production passes CLIENT_ACCESS_CODE_SECRET_NAME; a test passes a name it owns. */
  readonly accessCodeSecretName: string;
  readonly sessionRepo: ClientSessionRepository;
  readonly sessionTtlSeconds: number;
  /** Every failed login waits this long before answering (M1's only brute-force brake). */
  readonly loginFailureDelayMs: number;
  readonly assets: WebClientAssets;
}

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

export function createWebClientRoutes(deps: WebClientDeps): Hono {
  const app = new Hono();

  // "/client/*" also matches "/client" itself.
  app.use("/client/*", securityHeaders);
  app.use("/client/*", requireClientHeader);

  app.use("/client/api/*", async (c, next) => {
    const token = getCookie(c, CLIENT_SESSION_COOKIE);
    if (token === undefined || (await deps.sessionRepo.findActive(hashToken(token))) === null) {
      return c.json({ error: "no valid client session; log in at /client" }, 401);
    }
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
    if (!json.ok) return c.json({ error: `request body is not JSON: ${json.reason}` }, 400);
    const parsed = LoginSchema.safeParse(json.value);
    if (!parsed.success) {
      return c.json({ error: "invalid login", issues: parsed.error.issues }, 400);
    }

    const name = deps.accessCodeSecretName;
    if (!(await deps.secrets.has(name))) {
      return c.json(
        {
          error:
            `client login is not configured: the secret store has no "${name}". The operator sets it with ` +
            `\`read -rs C && printf '%s' "$C" | npx tsx scripts/secret.ts put ${name}\`.`,
        },
        503,
      );
    }
    const expected = await deps.secrets.get(name);
    if (expected.length < MIN_ACCESS_CODE_LENGTH) {
      return c.json(
        {
          error:
            `client login is refused: the stored "${name}" is shorter than ${MIN_ACCESS_CODE_LENGTH} ` +
            "characters, too weak for a login whose only brake is a fixed failure delay. " +
            `The operator replaces it with \`npx tsx scripts/secret.ts put ${name}\`.`,
        },
        503,
      );
    }

    if (!codeMatches(parsed.data.code, expected)) {
      await delay(deps.loginFailureDelayMs);
      return c.json({ error: "access code rejected" }, 401);
    }

    const token = randomBytes(32).toString("base64url");
    await deps.sessionRepo.create(hashToken(token), deps.sessionTtlSeconds);
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
    const result = await submitTender(deps, await readJsonBody(() => c.req.json()));
    return c.json(result.body, result.status);
  });

  app.get("/client/api/projects", async (c) => {
    const projects = await deps.projectRepo.list();
    return c.json(projects.map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt })));
  });

  app.get("/client/api/projects/:projectId/messages", async (c) => {
    const result = await listClientMessages(deps, c.req.param("projectId"), c.req.query());
    return c.json(result.body, result.status);
  });

  app.post("/client/api/projects/:projectId/messages", async (c) => {
    const json = await readJsonBody(() => c.req.json());
    const result = await postClientMessage(deps, c.req.param("projectId"), json);
    return c.json(result.body, result.status);
  });

  return app;
}
