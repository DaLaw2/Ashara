import { z } from "zod";
import type { ClientMessageRepository, CreatedTender, ProjectRepository } from "@ashara/db";
import {
  ClientPostSchema,
  TenderSchema,
  parseClientMessage,
  replyTargetProblem,
} from "@ashara/engagement";
import { parseProjectId } from "@ashara/shared";

// The client channel's handlers (K1), shared by the operator's bearer API and the
// web client's session API (ADR-076) so both speak through one validation path.
// Inbound only: no handler writes an outbound message; the Liaison writes those
// server-side. Every inbound insert NOTIFYs the loop (migration 016).

export interface ClientChannelDeps {
  readonly projectRepo: ProjectRepository;
  readonly clientMessageRepo: ClientMessageRepository;
  /** A tender: the project row and its inbound 'tender' message in one transaction (K1). */
  readonly createTender: (projectName: string, body: string) => Promise<CreatedTender>;
}

/** A handler's verdict, rendered as JSON by whichever route called it. */
export interface ChannelResponse {
  readonly status: 200 | 201 | 400 | 404;
  readonly body: unknown;
}

/** The request body as read by the route: parsed JSON, or why it could not be. */
export type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export async function readJsonBody(read: () => Promise<unknown>): Promise<JsonBody> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const ProjectIdParamSchema = z.uuid();

// `since` is an instant; one without an offset would be read in the server's zone.
const MessagesQuerySchema = z.strictObject({
  since: z.iso.datetime({ offset: true }).optional(),
});

function notJson(json: { readonly reason: string }): ChannelResponse {
  return { status: 400, body: { error: `request body is not JSON: ${json.reason}` } };
}

export async function submitTender(deps: ClientChannelDeps, json: JsonBody): Promise<ChannelResponse> {
  if (!json.ok) return notJson(json);
  const parsed = TenderSchema.safeParse(json.value);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid tender", issues: parsed.error.issues } };
  }
  const created = await deps.createTender(parsed.data.projectName, parsed.data.body);
  return {
    status: 201,
    body: { projectId: created.project.id, message: parseClientMessage(created.message) },
  };
}

export async function postClientMessage(
  deps: ClientChannelDeps,
  projectIdParam: string,
  json: JsonBody,
): Promise<ChannelResponse> {
  const idParsed = ProjectIdParamSchema.safeParse(projectIdParam);
  if (!idParsed.success) {
    return { status: 400, body: { error: "projectId must be a UUID", issues: idParsed.error.issues } };
  }
  const projectId = parseProjectId(idParsed.data);

  if (!json.ok) return notJson(json);
  const parsed = ClientPostSchema.safeParse(json.value);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid client message", issues: parsed.error.issues } };
  }
  const post = parsed.data;

  if (!(await deps.projectRepo.get(projectId))) {
    return { status: 404, body: { error: `project not found: ${projectId}` } };
  }

  let inReplyTo: string | null = null;
  if (post.kind === "answer") {
    const target = await deps.clientMessageRepo.findById(post.inReplyTo);
    const problem = replyTargetProblem(projectId, target ? parseClientMessage(target) : null);
    if (problem !== null) return { status: 400, body: { error: problem } };
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
  projectIdParam: string,
  rawQuery: Record<string, string>,
): Promise<ChannelResponse> {
  const idParsed = ProjectIdParamSchema.safeParse(projectIdParam);
  if (!idParsed.success) {
    return { status: 400, body: { error: "projectId must be a UUID", issues: idParsed.error.issues } };
  }
  const projectId = parseProjectId(idParsed.data);
  const query = MessagesQuerySchema.safeParse(rawQuery);
  if (!query.success) {
    return { status: 400, body: { error: "invalid query", issues: query.error.issues } };
  }

  if (!(await deps.projectRepo.get(projectId))) {
    return { status: 404, body: { error: `project not found: ${projectId}` } };
  }

  const since = query.data.since === undefined ? undefined : new Date(query.data.since);
  const rows = await deps.clientMessageRepo.listByProject(projectId, since);
  return { status: 200, body: rows.map((row) => parseClientMessage(row)) };
}
