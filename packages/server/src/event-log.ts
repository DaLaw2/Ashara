import { z } from "zod";
import { CapabilityLevelSchema } from "@ashara/finance";
import type { LadderAttemptEvent } from "@ashara/finance";
import { AttemptEventNameSchema, ProjectEventNameSchema } from "@ashara/quality";
import type { ExecutionEventSink } from "@ashara/quality";
import type { Clock } from "@ashara/shared";

const EVENT_LINE_PREFIX = "[event] ";

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
  tasksProcessed: count,
  completed: count,
  failed: count,
  refused: count,
  interrupted: count,
});

// Execution events carry their own fields beside a closed name. An attempt's event names its task
// and attempt; a project's names its project. None brings a field named `timestamp`: the writer
// adds that one.
const eventField = z.union([z.json(), z.undefined()]);
const noTimestamp = (e: object): boolean => !Object.hasOwn(e, "timestamp");
const NO_TIMESTAMP = "brings its own timestamp; the writer adds it";
const executionEventSchema = z.union([
  z
    .object({ event: AttemptEventNameSchema, taskId: z.string().min(1), attempt: count })
    .catchall(eventField)
    .refine(noTimestamp, NO_TIMESTAMP),
  z
    .object({ event: ProjectEventNameSchema, projectId: z.string().min(1) })
    .catchall(eventField)
    .refine(noTimestamp, NO_TIMESTAMP),
]);

type EventLine =
  | ({ readonly event: "ladder_attempt" } & LadderAttemptEvent)
  | z.input<typeof cycleCompleteSchema>
  | Parameters<ExecutionEventSink["emit"]>[0];

function schemaFor(event: EventLine): z.ZodType {
  if (event.event === "ladder_attempt") return ladderAttemptSchema;
  if (event.event === "cycle_complete") return cycleCompleteSchema;
  return executionEventSchema;
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
 * The one writer of `[event]` lines: each event is validated against its schema, then written as
 * one JSON object led by an ISO-8601 UTC timestamp from the injected clock, so a simulated run's
 * log reads the simulated time. An event's types admit only JSON values; one the schema still
 * refuses (a NaN count) is handed to `refuse` and no line is written. Emitting never throws: a log
 * line is never a reason for the dispatch path that emits it to stop.
 */
export function createEventLog(clock: Clock, write: (line: string) => void, refuse: (error: EventLineInvalid) => void): EventLog {
  return {
    emit(event) {
      const parsed = schemaFor(event).safeParse(event);
      if (!parsed.success) {
        refuse(new EventLineInvalid(event.event, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)));
        return;
      }
      const timestamp = new Date(clock.now()).toISOString();
      write(`${EVENT_LINE_PREFIX}${JSON.stringify({ timestamp, ...event })}`);
    },
  };
}
