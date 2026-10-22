import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const compared = vi.hoisted(() => ({ lengths: [] as Array<[number, number]> }));

vi.mock("node:crypto", async (importActual) => {
  const actual = await importActual<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      compared.lengths.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { bearerAuth } = await import("./bearer-auth.js");

const TOKEN = "test-token-0123456789";

function app(): Hono {
  const hono = new Hono();
  hono.use("*", bearerAuth(TOKEN));
  hono.get("/health", (c) => c.text("ok"));
  hono.get("/api/x", (c) => c.text("in"));
  return hono;
}

async function status(authorization: string | undefined, path = "/api/x"): Promise<number> {
  const headers: Record<string, string> = authorization === undefined ? {} : { Authorization: authorization };
  return (await app().request(path, { headers })).status;
}

beforeEach(() => {
  compared.lengths = [];
});

describe("bearerAuth", () => {
  test("admits the exact token and refuses a missing, shorter, longer or different one", async () => {
    expect(await status(`Bearer ${TOKEN}`)).toBe(200);
    expect(await status(undefined)).toBe(401);
    expect(await status(`Bearer ${TOKEN.slice(0, -1)}`)).toBe(401);
    expect(await status(`Bearer ${TOKEN}x`)).toBe(401);
    expect(await status(`Bearer ${TOKEN.replace("0", "1")}`)).toBe(401);
    expect(await status(undefined, "/health")).toBe(200);
  });

  test("a token of the wrong length still runs the constant-time comparison, on fixed-length digests", async () => {
    expect(await status("Bearer x")).toBe(401);
    expect(compared.lengths).toEqual([[32, 32]]);
  });
});
