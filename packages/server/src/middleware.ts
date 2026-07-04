import type { MiddlewareHandler } from "hono";

export function bearerAuth(apiToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/health") return next();
    if (c.req.path.startsWith("/graph/")) return next();

    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
