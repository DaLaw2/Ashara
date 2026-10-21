import { z } from "zod";
import { REPORT_SUBJECTS } from "./report-subjects.js";

// The client channel's language. The client
// says tender, answer, change, stop; the Liaison says question, report. The same
// pairing is a CHECK on client_messages.

const MessageBodySchema = z.string().min(1);
const MessageIdSchema = z.uuid();

/**
 * What a client may post to an existing project. A tender is absent on purpose:
 * it starts a project (`TenderSchema`). Outbound kinds are absent on purpose:
 * only the Liaison writes them, server-side.
 */
export const ClientPostSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), body: MessageBodySchema, inReplyTo: MessageIdSchema }),
  z.strictObject({ kind: z.literal("change"), body: MessageBodySchema }),
  z.strictObject({ kind: z.literal("stop"), body: MessageBodySchema }),
]);

/** A tender: the client's first message, which creates the project it names. */
export const TenderSchema = z.strictObject({
  projectName: z.string().min(1),
  body: MessageBodySchema,
});

const recordFields = {
  id: MessageIdSchema,
  projectId: z.uuid(),
  body: MessageBodySchema,
  inReplyTo: MessageIdSchema.nullable(),
  createdAt: z.date(),
};

const ClientMessageSchema = z.discriminatedUnion("direction", [
  z.object({
    ...recordFields,
    direction: z.literal("inbound"),
    kind: z.enum(["tender", "answer", "change", "stop"]),
    consumedAt: z.date().nullable(),
    // Only the Liaison's reports are on a subject.
    reportsOn: z.null(),
  }),
  z.object({
    ...recordFields,
    direction: z.literal("outbound"),
    kind: z.enum(["question", "report"]),
    // Only inbound messages are consumed.
    consumedAt: z.null(),
    reportsOn: z.enum(REPORT_SUBJECTS).nullable(),
  }),
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** A client_messages row read back from storage did not match the channel's language. */
class InvalidClientMessageRecord extends Error {
  constructor(
    readonly record: unknown,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(
      `client message record does not match the client channel language: ${JSON.stringify(issues)}`,
    );
    this.name = "InvalidClientMessageRecord";
  }
}

export function parseClientMessage(record: unknown): ClientMessage {
  const parsed = ClientMessageSchema.safeParse(record);
  if (!parsed.success) throw new InvalidClientMessageRecord(record, parsed.error.issues);
  return parsed.data;
}

/**
 * Why `target` cannot be what an answer in `projectId` replies to, or null when
 * it can: an answer answers a question the Liaison asked in the same project.
 */
export function replyTargetProblem(projectId: string, target: ClientMessage | null): string | null {
  if (target === null) return "inReplyTo names no message";
  if (target.projectId !== projectId) return "inReplyTo names a message of another project";
  if (target.direction !== "outbound" || target.kind !== "question") {
    return `inReplyTo names a ${target.direction} '${target.kind}', not a question`;
  }
  return null;
}
