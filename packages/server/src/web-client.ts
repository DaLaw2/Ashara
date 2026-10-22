import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createClientSessionRoutes } from "@ashara/security";
import type { ClientLoginDeps, ClientSessionEnv } from "@ashara/security";
import { listClientMessages, postClientMessage, readJsonBody, submitTender } from "./client-channel.js";
import type { ChannelCaller, ClientChannelDeps } from "./client-channel.js";

// The web client: one static page, one plain script and one stylesheet,
// served by this process with no build step, plus a session-authenticated copy of
// the client channel under /client/api. Login, the session and the login throttle
// are Security's (createClientSessionRoutes); this module composes them.

/**
 * Required on every state-changing /client request. A cross-site form cannot set
 * a custom header, and a cross-site fetch that sets one needs a CORS preflight this
 * server never grants, so the header is CSRF defence independent of SameSite.
 */
const CLIENT_REQUEST_HEADER = "X-Ashara-Client";

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

interface WebClientAssets {
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

export interface WebClientDeps extends ClientChannelDeps, ClientLoginDeps {
  readonly assets: WebClientAssets;
}

function sessionClientId(c: Context<ClientSessionEnv>): string {
  const clientId = c.get("clientId");
  if (typeof clientId !== "string" || clientId === "") throw new ClientSessionMissing(c.req.path);
  return clientId;
}

function sessionCaller(c: Context<ClientSessionEnv>): ChannelCaller {
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

export function createWebClientRoutes(deps: WebClientDeps): Hono<ClientSessionEnv> {
  const app = new Hono<ClientSessionEnv>();

  // "/client/*" also matches "/client" itself.
  app.use("/client/*", securityHeaders);
  app.use("/client/*", requireClientHeader);

  app.route("/", createClientSessionRoutes(deps));

  app.get("/", (c) => c.redirect("/client"));
  app.get("/client", (c) => c.html(deps.assets.html));
  app.get("/client/app.js", (c) =>
    c.body(deps.assets.script, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );
  app.get("/client/app.css", (c) =>
    c.body(deps.assets.stylesheet, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );

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
