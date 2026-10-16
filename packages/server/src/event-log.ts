import { z } from "zod";
import { CapabilityLevelSchema } from "@ashara/finance";
import type { LadderAttemptEvent } from "@ashara/finance";
import { ExecutionEventNameSchema } from "@ashara/quality";
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

// Execution events carry their own fields beside a closed name; what every one must carry is the
// task or the project it concerns, and no field named `timestamp`: the writer adds that one.
const executionEventSchema = z
  .object({
    event: ExecutionEventNameSchema,
    taskId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    attempt: count.optional(),
  })
  // An undefined field is dropped by JSON.stringify, as an absent one would be.
  .catchall(z.union([z.json(), z.undefined()]))
  .refine((e) => e.taskId !== undefined || e.projectId !== undefined, "names neither a taskId nor a projectId")
  // A key check, not a value check: `{timestamp: undefined}` would overwrite the writer's timestamp.
  .refine((e) => !Object.hasOwn(e, "timestamp"), "brings its own timestamp; the writer adds it");

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
 * log reads the simulated time.
 */
export function createEventLog(clock: Clock, write: (line: string) => void): EventLog {
  return {
    emit(event) {
      const parsed = schemaFor(event).safeParse(event);
      if (!parsed.success) {
        throw new EventLineInvalid(
          event.event,
          parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
        );
      }
      const timestamp = new Date(clock.now()).toISOString();
      write(`${EVENT_LINE_PREFIX}${JSON.stringify({ timestamp, ...event })}`);
    },
  };
}
