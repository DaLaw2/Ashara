import { Hono } from "hono";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";
import { createWebClientRoutes } from "./web-client.js";
import type { WebClientDeps } from "./web-client.js";

/**
 * The server's HTTP surface. The web client's routes are registered before the
 * bearer middleware and answer every request they match, so a browser reaches
 * them with its session cookie alone (ADR-076); every other route still requires
 * the operator's bearer token, and a bearer token opens no /client/api route.
 */
export function buildApp(apiToken: string, appDeps: AppDeps, webClientDeps: WebClientDeps): Hono {
  const app = new Hono();
  app.route("/", createWebClientRoutes(webClientDeps));
  app.use("*", bearerAuth(apiToken));
  app.route("/", createRoutes(appDeps));
  return app;
}
