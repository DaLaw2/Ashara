import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Constant-time for equal lengths; a length mismatch rejects without comparing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerAuth(apiToken: string): MiddlewareHandler {
  const expected = `Bearer ${apiToken}`;
  return async (c, next) => {
    if (c.req.path === "/health") return next();

    const auth = c.req.header("Authorization");
    if (auth === undefined || !tokenMatches(auth, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
