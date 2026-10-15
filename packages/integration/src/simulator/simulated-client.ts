import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";

/**
 * The simulated client, as a browser on the web client (ADR-076) is one: it logs in with its name
 * and access code, keeps the session cookie the server sets, and sends its tender, its stop and
 * its answers to the server's client routes, in process through the composed app's own request
 * handler. It never writes a client message itself, so every seed drives Engagement's client
 * channel through the routes, their validation and their authentication included.
 */

/** What the client needs of a composed instance's HTTP surface (Hono's `app.request`). */
export interface ClientRoutes {
  request(input: string, init: RequestInit, env: SocketBindings): Response | Promise<Response>;
}

/** The Node adapter's bindings the login reads its throttle's source from (server web-client.ts). */
interface SocketBindings {
  readonly incoming: { readonly socket: { readonly remoteAddress: string } };
}

const ORIGIN = "http://localhost";
const LOOPBACK: SocketBindings = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
/** The header the web client's own script sends on every state-changing request (its CSRF defence). */
const CLIENT_HEADER = { "X-Ashara-Client": "1" } as const;

const ProjectListSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));
const TenderCreatedSchema = z.object({ projectId: z.uuid() });
const MessageListSchema = z.array(
  z.object({
    id: z.string(),
    direction: z.enum(["inbound", "outbound"]),
    kind: z.string(),
    body: z.string(),
    inReplyTo: z.string().nullable(),
  }),
);
type ListedMessage = z.infer<typeof MessageListSchema>[number];

/** One request's answer: what it returned, or the status it failed with. */
export type ClientReply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly detail: string };

/** A route answered a well-formed request of the client with a body outside the channel's language. */
class ClientReplyUnreadable extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${route} answered ${status} with a body the client cannot read: ${detail}`, options);
    this.name = "ClientReplyUnreadable";
  }
}

/** The session cookie as a browser echoes it: the `name=value` pair of the Set-Cookie header. */
function cookiePair(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  if (header === null) return null;
  const pair = header.split(";")[0]?.trim() ?? "";
  return pair.includes("=") ? pair : null;
}

export class SimulatedClient {
  private cookie: string | null = null;

  constructor(
    readonly name: string,
    private readonly code: string,
  ) {}

  /** Posts a tender for a new project; its id when the server created it. */
  async tender(app: ClientRoutes, projectName: string, body: string): Promise<ClientReply<string>> {
    return this.call(app, "POST", "/client/api/tenders", { projectName, body }, 201, (value) => TenderCreatedSchema.parse(value).projectId);
  }

  /** The projects this client owns, as the server lists them. */
  async projects(app: ClientRoutes): Promise<ClientReply<ReadonlyArray<{ readonly id: string; readonly name: string }>>> {
    return this.call(app, "GET", "/client/api/projects", null, 200, (value) => ProjectListSchema.parse(value));
  }

  /** One project's messages, both ways, in the server's order. */
  async messages(app: ClientRoutes, projectId: string): Promise<ClientReply<readonly ListedMessage[]>> {
    return this.call(app, "GET", `/client/api/projects/${projectId}/messages`, null, 200, (value) => MessageListSchema.parse(value));
  }

  /** Posts a stop or an answer on one project. */
  async post(app: ClientRoutes, projectId: string, message: { readonly kind: "stop"; readonly body: string } | { readonly kind: "answer"; readonly body: string; readonly inReplyTo: string }): Promise<ClientReply<null>> {
    return this.call(app, "POST", `/client/api/projects/${projectId}/messages`, message, 201, () => null);
  }

  private async login(app: ClientRoutes): Promise<ClientReply<null>> {
    const response = await app.request(
      `${ORIGIN}/client/login`,
      { method: "POST", headers: { "Content-Type": "application/json", ...CLIENT_HEADER }, body: JSON.stringify({ client: this.name, code: this.code }) },
      LOOPBACK,
    );
    if (response.status !== 204) return { ok: false, status: response.status, detail: `login: ${await response.text()}` };
    const pair = cookiePair(response);
    if (pair === null) throw new ClientReplyUnreadable("POST /client/login", response.status, "no session cookie was set");
    this.cookie = pair;
    return { ok: true, value: null };
  }

  /**
   * One request, logged in first when the client holds no session; a 401 drops the session, so the
   * next request logs in again. A failure is returned, not thrown: the run decides what the client
   * does next. A success whose body the client cannot read throws: the route broke its language.
   */
  private async call<T>(app: ClientRoutes, method: "GET" | "POST", path: string, body: unknown, expected: number, read: (value: unknown) => T): Promise<ClientReply<T>> {
    if (this.cookie === null) {
      const login = await this.login(app);
      if (!login.ok) return login;
    }
    const headers: Record<string, string> = { Cookie: this.cookie ?? "" };
    if (method === "POST") Object.assign(headers, { "Content-Type": "application/json" }, CLIENT_HEADER);
    const response = await app.request(`${ORIGIN}${path}`, body === null ? { method, headers } : { method, headers, body: JSON.stringify(body) }, LOOPBACK);
    const text = await response.text();
    if (response.status === 401) this.cookie = null;
    if (response.status !== expected) return { ok: false, status: response.status, detail: `${method} ${path}: ${text}` };
    try {
      return { ok: true, value: read(text === "" ? null : JSON.parse(text)) };
    } catch (err) {
      throw new ClientReplyUnreadable(`${method} ${path}`, response.status, describeErrorChain(err), { cause: err });
    }
  }
}
