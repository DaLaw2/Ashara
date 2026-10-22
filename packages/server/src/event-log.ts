import { z } from "zod";
import { CapabilityLevelSchema } from "@ashara/finance";
import type { LadderAttemptEvent } from "@ashara/finance";
import { AttemptEventNameSchema, ProjectEventNameSchema } from "@ashara/quality";
import type { ExecutionEventSink } from "@ashara/quality";
import type { Logger } from "@ashara/shared";

const count = z.number().int().nonnegative();

const ladderAttemptSchema = z.strictObject({
  event: z.literal("ladder_attempt"),
  site: z.string().min(1),
  attempt: z.number().int().positive(),
  capability: CapabilityLevelSchema,
  model: z.string().min(1).nullable(),
  outcome: z.enum(["valid", "invalid"]),
  errors: z.array(z.string()).optional(),
  rawExcerpt: z.string().optional(),
});

const cycleCompleteSchema = z.strictObject({
  event: z.literal("cycle_complete"),
  eligible: count,
  dispatched: count,
  lanes: z.number().int().positive(),
  tasksProcessed: count,
  completed: count,
  failed: count,
  refused: count,
  interrupted: count,
});

// Execution events carry their own fields beside a closed name. An attempt's event names its task
// and attempt; a project's names its project.
const eventField = z.union([z.json(), z.undefined()]);
const executionEventSchema = z.union([
  z.object({ event: AttemptEventNameSchema, taskId: z.string().min(1), attempt: count }).catchall(eventField),
  z.object({ event: ProjectEventNameSchema, projectId: z.string().min(1) }).catchall(eventField),
]);

/** An event's fields once its schema accepted it: every value JSON, an absent one dropped. */
const eventFieldsSchema = z.record(z.string(), z.json());

type EventLine =
  | ({ readonly event: "ladder_attempt" } & LadderAttemptEvent)
  | z.input<typeof cycleCompleteSchema>
  | Parameters<ExecutionEventSink["emit"]>[0];

function schemaFor(event: EventLine): z.ZodType {
  if (event.event === "ladder_attempt") return ladderAttemptSchema;
  if (event.event === "cycle_complete") return cycleCompleteSchema;
  return executionEventSchema;
}

/** The record's event name: the context whose vocabulary names the event, then the name in kebab case. */
function recordEventName(event: EventLine): `${string}.${string}` {
  const what = event.event.replaceAll("_", "-");
  if (event.event === "ladder_attempt") return `model-access.${what}`;
  if (event.event === "cycle_complete") return `delivery.${what}`;
  return `quality.${what}`;
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/** An event that does not match its schema: written, it would be a log line no reader can trust. */
class EventLineInvalid extends Error {
  constructor(
    readonly event: string,
    readonly issues: readonly string[],
  ) {
    super(`Event line "${event}" does not match its schema: ${issues.join("; ")}`);
    this.name = "EventLineInvalid";
  }
}

interface EventLog {
  emit(event: EventLine): void;
}

/**
 * The one writer of the loop's events: each event is validated against its schema, then logged at
 * info as one record named `<context>.<event-in-kebab-case>` holding the event's own fields, so a
 * simulated run's records carry the simulated time the logger's clock reads. An event's types
 * admit only JSON values; one the schema still refuses (a NaN count) is logged at error as
 * `server.event-refused` with its issues, and no event record is written. Emitting never throws: a
 * log line is never a reason for the dispatch path that emits it to stop.
 */
export function createEventLog(logger: Logger): EventLog {
  const refuse = (error: EventLineInvalid): void =>
    logger.error("server.event-refused", error.message, { event: error.event, issues: [...error.issues] }, error);
  return {
    emit(event) {
      const parsed = schemaFor(event).safeParse(event);
      if (!parsed.success) {
        refuse(new EventLineInvalid(event.event, issueLines(parsed.error)));
        return;
      }
      const present = Object.entries(event).filter(([key, value]) => key !== "event" && value !== undefined);
      const fields = eventFieldsSchema.safeParse(Object.fromEntries(present));
      if (!fields.success) {
        refuse(new EventLineInvalid(event.event, issueLines(fields.error)));
        return;
      }
      // eslint-disable-next-line ashara/log-event-name -- the writer of other contexts' events: recordEventName maps each closed, schema-validated event name to its owning context's kebab-case record name
      logger.info(recordEventName(event), event.event.replaceAll("_", " "), fields.data);
    },
  };
}
