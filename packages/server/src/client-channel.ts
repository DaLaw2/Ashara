import { z } from "zod";
import type { ClientMessageRepository, CreatedTender } from "@ashara/engagement";
import type { ClientRepository, ProjectRepository } from "@ashara/db";
import {
  ClientPostSchema,
  TenderSchema,
  parseClientMessage,
  replyTargetProblem,
} from "@ashara/engagement";
import { describeErrorChain, parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";

// The client channel's handlers (K1), shared by the operator's bearer API and the
// web client's session API (ADR-076) so both speak through one validation path.
// Inbound only: no handler writes an outbound message; the Liaison writes those
// server-side. Every inbound insert NOTIFYs the loop (migration 016).

export interface ClientChannelDeps {
  readonly projectRepo: ProjectRepository;
  readonly clientMessageRepo: ClientMessageRepository;
  readonly clientRepo: ClientRepository;
  /** A tender: the project row, owned by `clientId`, and its inbound 'tender' message in one transaction (K1). */
  readonly createTender: (clientId: string, projectName: string, body: string) => Promise<CreatedTender>;
}

/**
 * Who is asking. The operator (bearer token) reaches every project and names the
 * client a tender is for; a client (web session) reaches only its own projects,
 * and another client's project is indistinguishable from one that does not exist.
 */
export type ChannelCaller =
  | { readonly kind: "operator" }
  | { readonly kind: "client"; readonly clientId: string };

/** A handler's verdict, rendered as JSON by whichever route called it. */
interface ChannelResponse {
  readonly status: 200 | 201 | 400 | 404 | 409;
  readonly body: unknown;
}

/** The request body as read by the route: parsed JSON, or why it could not be. */
type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export async function readJsonBody(read: () => Promise<unknown>): Promise<JsonBody> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, reason: describeErrorChain(e) };
  }
}

/**
 * The parser's detail goes to the server log only: it can echo fragments of the
 * request back, and the caller learns nothing from it it did not send.
 */
export function notJson(operation: string, json: { readonly reason: string }): ChannelResponse {
  console.warn(`[client-channel] ${operation}: request body is not JSON: ${json.reason}`);
  return { status: 400, body: { error: "request body is not valid JSON" } };
}

const ProjectIdParamSchema = z.uuid();

// `since` is an instant; one without an offset would be read in the server's zone.
const MessagesQuerySchema = z.strictObject({
  since: z.iso.datetime({ offset: true }).optional(),
});

/** The operator's tender names the client it is for; a client's tender is its own. */
const OperatorTenderSchema = TenderSchema.extend({ clientId: z.uuid() });

function projectNotFound(projectId: string): ChannelResponse {
  return { status: 404, body: { error: `project not found: ${projectId}` } };
}

/** Whether `caller` may see this project. Absent and not-yours answer the same. */
async function visibleProject(deps: ClientChannelDeps, caller: ChannelCaller, projectId: ProjectId): Promise<boolean> {
  const project = await deps.projectRepo.get(projectId);
  if (project === null) return false;
  return caller.kind === "operator" || project.clientId === caller.clientId;
}

async function tenderOwner(
  deps: ClientChannelDeps,
  caller: ChannelCaller,
  value: unknown,
): Promise<
  | { readonly ok: true; readonly clientId: string; readonly projectName: string; readonly body: string }
  | { readonly ok: false; readonly response: ChannelResponse }
> {
  if (caller.kind === "client") {
    const parsed = TenderSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, response: { status: 400, body: { error: "invalid tender", issues: parsed.error.issues } } };
    }
    return { ok: true, clientId: caller.clientId, ...parsed.data };
  }
  const parsed = OperatorTenderSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, response: { status: 400, body: { error: "invalid tender", issues: parsed.error.issues } } };
  }
  if ((await deps.clientRepo.get(parsed.data.clientId)) === null) {
    return { ok: false, response: { status: 404, body: { error: `client not found: ${parsed.data.clientId}` } } };
  }
  return { ok: true, ...parsed.data };
}

export async function submitTender(
  deps: ClientChannelDeps,
  caller: ChannelCaller,
  json: JsonBody,
): Promise<ChannelResponse> {
  if (!json.ok) return notJson("submit tender", json);
  const owner = await tenderOwner(deps, caller, json.value);
  if (!owner.ok) return owner.response;
  const created = await deps.createTender(owner.clientId, owner.projectName, owner.body);
  return {
    status: 201,
    body: { projectId: created.project.id, message: parseClientMessage(created.message) },
  };
}

export async function postClientMessage(
  deps: ClientChannelDeps,
  caller: ChannelCaller,
  projectIdParam: string,
  json: JsonBody,
): Promise<ChannelResponse> {
  const idParsed = ProjectIdParamSchema.safeParse(projectIdParam);
  if (!idParsed.success) {
    return { status: 400, body: { error: "projectId must be a UUID", issues: idParsed.error.issues } };
  }
  const projectId = parseProjectId(idParsed.data, "projectId route param");

  if (!json.ok) return notJson("post client message", json);
  const parsed = ClientPostSchema.safeParse(json.value);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid client message", issues: parsed.error.issues } };
  }
  const post = parsed.data;

  if (!(await visibleProject(deps, caller, projectId))) return projectNotFound(projectId);

  let inReplyTo: string | null = null;
  if (post.kind === "answer") {
    const target = await deps.clientMessageRepo.findById(post.inReplyTo);
    const problem = replyTargetProblem(projectId, target ? parseClientMessage(target) : null);
    if (problem !== null) return { status: 400, body: { error: problem } };
    const earlier = await deps.clientMessageRepo.findAnswerTo(post.inReplyTo);
    if (earlier !== null) {
      return {
        status: 409,
        body: { error: `question ${post.inReplyTo} is already answered by message ${earlier.id}` },
      };
    }
    inReplyTo = post.inReplyTo;
  }

  const row = await deps.clientMessageRepo.insertInbound({
    projectId,
    kind: post.kind,
    body: post.body,
    inReplyTo,
  });
  return { status: 201, body: parseClientMessage(row) };
}

export async function listClientMessages(
  deps: ClientChannelDeps,
  caller: ChannelCaller,
  projectIdParam: string,
  rawQuery: Record<string, string>,
): Promise<ChannelResponse> {
  const idParsed = ProjectIdParamSchema.safeParse(projectIdParam);
  if (!idParsed.success) {
    return { status: 400, body: { error: "projectId must be a UUID", issues: idParsed.error.issues } };
  }
  const projectId = parseProjectId(idParsed.data, "projectId route param");
  const query = MessagesQuerySchema.safeParse(rawQuery);
  if (!query.success) {
    return { status: 400, body: { error: "invalid query", issues: query.error.issues } };
  }

  if (!(await visibleProject(deps, caller, projectId))) return projectNotFound(projectId);

  const since = query.data.since === undefined ? undefined : new Date(query.data.since);
  const rows = await deps.clientMessageRepo.listByProject(projectId, since);
  return { status: 200, body: rows.map((row) => parseClientMessage(row)) };
}
