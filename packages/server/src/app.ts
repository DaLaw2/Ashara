import { Hono } from "hono";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeErrorChain } from "@ashara/shared";
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
  app.onError(internalError);
  return app;
}

/**
 * An error no route answered. The full chain goes to the server log, with the request that
 * raised it; the caller gets a typed 500 naming the operation, never the chain, which can echo
 * stored rows or request fragments. An HTTPException keeps the response it carries.
 */
const internalError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const operation = `${c.req.method} ${c.req.path}`;
  console.error(
    `[server] unhandled error in ${operation} (${err.name}): ${describeErrorChain(err)}`,
    { operation, errorClass: err.name, stack: err.stack },
  );
  return c.json({ error: "internal server error", errorClass: "InternalServerError", operation }, 500);
};
