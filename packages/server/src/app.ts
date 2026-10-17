import { Hono } from "hono";
import type { ErrorHandler, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeErrorChain } from "@ashara/shared";
import type { Logger } from "@ashara/shared";
import { bearerAuth } from "./middleware.js";
import { createRoutes } from "./routes.js";
import type { AppDeps } from "./routes.js";
import { createWebClientRoutes } from "./web-client.js";
import type { WebClientDeps } from "./web-client.js";

/**
 * The server's HTTP surface. The web client's routes are registered before the
 * bearer middleware and answer every request they match, so a browser reaches
 * them with its session cookie alone; every other route still requires
 * the operator's bearer token, and a bearer token opens no /client/api route. Every request, refused
 * ones included, runs in its own log trace (requestTrace).
 */
export function buildApp(apiToken: string, appDeps: AppDeps, webClientDeps: WebClientDeps, logger: Logger): Hono {
  const app = new Hono();
  app.use("*", requestTrace(logger));
  app.route("/", createWebClientRoutes(webClientDeps));
  app.use("*", bearerAuth(apiToken));
  app.route("/", createRoutes(appDeps));
  app.onError(internalError);
  return app;
}

/** The response header naming the trace a request ran in: a caller quotes it, an operator finds the request's records by it. */
const TRACE_HEADER = "x-ashara-trace";

/** Each request in a new trace, named on its response, whatever answered it. */
function requestTrace(logger: Logger): MiddlewareHandler {
  return (c, next) =>
    logger.scope({ trace: "new" }, async () => {
      const trace = logger.trace();
      await next();
      c.res.headers.set(TRACE_HEADER, trace);
    });
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
