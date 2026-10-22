import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ClientLoginFailureRepository, ClientRepository, ClientSessionRepository, LoginAttemptCaps } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";
import { MIN_CLIENT_ACCESS_CODE_LENGTH, clientAccessCodeSecretName } from "./secret-name.js";
import { sourceNetwork } from "./source-network.js";

// A client's login, its session and the login throttle. The browser never holds the
// server's API token: a client logs in with its name and its own access code from the
// secret store, and gets a random session token in an HttpOnly cookie, stored
// server-side only as its hash and bound to that one client.

/** @testseam The cookie a client's session token travels in; the integration web-client.test.ts reads and sends it by name. */
export const CLIENT_SESSION_COOKIE = "ashara_client";

/** Ended sessions are kept this long after they end, then deleted at the next login. */
const ENDED_SESSION_RETENTION_SECONDS = 24 * 60 * 60;

const LoginSchema = z.strictObject({
  client: z.string().min(1).max(200),
  code: z.string().min(1).max(1024),
});

/**
 * Unknown name, known name with no usable stored code, and wrong code all answer
 * 401 with this one body at the same moment, so the answer reveals neither which
 * names exist nor which have a code configured.
 */
const LOGIN_REJECTED = { error: "client name or access code rejected" };

/**
 * Compared against when there is no stored code, so every failed login does the
 * same comparison work. Random per process: no presented code can be known to match it.
 */
const NO_STORED_CODE = randomBytes(32).toString("hex");

/**
 * The Node adapter's bindings carry the request's socket. Only the socket's own
 * remote address is used: X-Forwarded-For and similar headers are written by the
 * caller and are not trusted, because no trusted-proxy configuration exists. A
 * deployment behind a proxy would see every client as the proxy's address and
 * needs such a configuration first.
 */
const NodeBindingsSchema = z.object({
  incoming: z.object({ socket: z.object({ remoteAddress: z.string().min(1) }) }),
});

/** The subset of the secret store a login reads a client's access code through. */
interface AccessCodeReader {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string>;
}

export interface ClientLoginDeps {
  readonly clientRepo: ClientRepository;
  readonly secrets: AccessCodeReader;
  readonly sessionRepo: ClientSessionRepository;
  readonly loginFailureRepo: ClientLoginFailureRepository;
  /** Attempts each scope admits per window before login answers 429. */
  readonly loginThrottle: LoginAttemptCaps;
  readonly sessionTtlSeconds: number;
  /** Every failed login answers this long after the request arrived, whatever made it fail. */
  readonly loginFailureDelayMs: number;
}

/** A request past the session guard carries the id of the client its session is bound to. */
export type ClientSessionEnv = { Variables: { clientId: string } };

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

/** The socket's remote address, or null when the request did not arrive over a Node socket. */
function sourceAddress(c: Context<ClientSessionEnv>): string | null {
  const bindings: unknown = c.env;
  const parsed = NodeBindingsSchema.safeParse(bindings);
  return parsed.success ? parsed.data.incoming.socket.remoteAddress : null;
}

/**
 * The stored code for this client, or why login cannot run: absent, or too short
 * to carry the entropy a login needs. The browser gets the same 401 as for a
 * wrong code; the operator's instruction goes to the server log.
 */
async function storedAccessCode(
  deps: ClientLoginDeps,
  client: { readonly id: string; readonly name: string },
): Promise<{ readonly ok: true; readonly code: string } | { readonly ok: false }> {
  const secretName = clientAccessCodeSecretName(client.id);
  const fix =
    `The operator stores one with \`read -rs C && printf '%s' "$C" | npx tsx scripts/client.ts set-code "${client.name}"\` ` +
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

/**
 * The session guard on /client/api/*, and /client/login and /client/logout. The
 * parser's detail of a body that is not JSON goes to the server log only: it can
 * echo fragments of the request back.
 */
export function createClientSessionRoutes(deps: ClientLoginDeps): Hono<ClientSessionEnv> {
  const app = new Hono<ClientSessionEnv>();
  const { windowSeconds } = deps.loginThrottle;

  app.use("/client/api/*", async (c, next) => {
    const token = getCookie(c, CLIENT_SESSION_COOKIE);
    const session = token === undefined ? null : await deps.sessionRepo.findActive(hashToken(token));
    if (session === null) {
      return c.json({ error: "no valid client session; log in at /client" }, 401);
    }
    c.set("clientId", session.clientId);
    return next();
  });

  app.post("/client/login", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch (e) {
      console.warn(`[web-client] client login: request body is not JSON: ${describeErrorChain(e)}`);
      return c.json({ error: "request body is not valid JSON" }, 400);
    }
    const parsed = LoginSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid login", issues: parsed.error.issues }, 400);
    }
    const { client: clientName, code } = parsed.data;
    const arrivedAt = Date.now();

    const remoteAddress = sourceAddress(c);
    const source = remoteAddress === null ? null : sourceNetwork(remoteAddress);
    if (source === null) {
      console.error(
        `[web-client] login refused for client name "${clientName}": ` +
          (remoteAddress === null
            ? "the request carries no socket remote address"
            : `the socket remote address "${remoteAddress}" is not an IP address`) +
          ", so the throttle cannot be applied",
      );
      return c.json({ error: "client login is temporarily unavailable" }, 503);
    }

    // Reserved before the code is compared, atomically with the count, so a burst
    // of parallel guesses gets at most the cap evaluated. Keyed by the name as
    // presented, so an unknown name is throttled exactly like a known one and the
    // 429 reveals nothing about which names exist. Every cap is per source, so a
    // 429 closes login only for the source that earned it.
    const reservation = await deps.loginFailureRepo.reserve(clientName, source, deps.loginThrottle);
    if (reservation.kind === "throttled") {
      console.warn(
        `[web-client] login throttled for client name "${clientName}" from ${source}: ${reservation.count} ` +
          `attempts per ${reservation.scope} within ${windowSeconds}s (limit ${reservation.limit})`,
      );
      c.header("Retry-After", String(windowSeconds));
      return c.json({ error: "too many failed logins; try again later" }, 429);
    }

    const client = await deps.clientRepo.findByName(clientName);
    const stored = client === null ? null : await storedAccessCode(deps, client);
    const expected = stored?.ok === true ? stored.code : null;
    const compared = codeMatches(code, expected ?? NO_STORED_CODE);
    if (client === null || expected === null || !compared) {
      const reason =
        client === null ? "no such client" : expected === null ? "no usable stored access code" : "wrong access code";
      console.warn(
        `[web-client] login failed for client name "${clientName}" from ${source}: ${reason} ` +
          `(${reservation.nameAndSourceCount} from this address within ${windowSeconds}s, ` +
          `limit ${deps.loginThrottle.perNameAndSource})`,
      );
      // Answered at a fixed moment after arrival, so the secret-store work a known
      // name costs does not show in the timing.
      await delay(Math.max(0, arrivedAt + deps.loginFailureDelayMs - Date.now()));
      return c.json(LOGIN_REJECTED, 401);
    }

    await deps.loginFailureRepo.clearNameAndSource(clientName, source);
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

  return app;
}
