import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Digests have equal length, so the comparison leaks neither content nor length. */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
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
