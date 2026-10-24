import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { cutText } from "./elided-text.js";
import { describeErrorChain, serializeError } from "./error-chain.js";
import type { JsonValue, SerializedError } from "./error-chain.js";
import { errorLayerSchema, flattenChain } from "./error-envelope.js";

/** Characters of a record's message kept; a longer one is cut in the middle and says so. */
const MAX_MSG_CHARS = 16_000;
/** Characters of one string field value kept. */
const MAX_FIELD_STRING_CHARS = 16_000;
/** Nesting of one field value kept before it is cut. */
const MAX_FIELD_DEPTH = 6;
/** Keys of one object, or items of one array, kept in a field value; the rest are counted. */
const MAX_FIELD_KEYS = 64;
/** Layers of an ErrorLayer chain kept; the rest are counted. */
const MAX_ERROR_LAYERS = 8;
/** Upper bound on a logged error as JSON text, the same bound serializeError applies to a thrown chain. */
const MAX_ERROR_CHARS = 64_000;

const REDACTED = "[redacted]";

/**
 * Field names whose value is redacted whatever its type: the second guard behind `Secret`.
 * A name matches when, lowercased with every
 * non-alphanumeric character removed, it ends with one of these.
 */
const DENIED_FIELD_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "privatekey",
  "masterkey",
  "accesscode",
] as const;

function isDeniedFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return DENIED_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * A value that must never reach a log line: it serializes, prints and logs as `[redacted]`. The
 * value is held in a private slot, so no enumeration of the object (the error serializer's
 * included) reads it; `reveal()` is the one way to the value.
 * @testseam log.test.ts proves the redaction
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** `<context>.<what>`, e.g. `delivery.cycle-complete`: the stable key readers assert on; the message is for humans. */
type LogEvent = `${string}.${string}`;

/** What a call site may put in a record's fields: JSON, with a `Secret` anywhere a value may be. */
type LogValue = string | number | boolean | null | Secret | readonly LogValue[] | { readonly [key: string]: LogValue };
type LogFields = Readonly<Record<string, LogValue>>;

/** Who and what a record is about. `traceId` is always present: the logger's root scope mints one. */
interface Correlation {
  readonly traceId: string;
  readonly parentTraceId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly attempt?: number;
  readonly cycle?: number;
  readonly callSite?: string;
  readonly callId?: string;
  readonly cell?: string;
  readonly subject?: string;
}

/** One layer of an ErrorLayer chain as logged: its context reduced to JSON and redacted. */
interface LoggedLayer {
  readonly boundary: string;
  readonly operation: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, JsonValue>>;
  readonly timestamp: string;
}

/** An error as a record holds it: a thrown value as its serialized chain, an ErrorLayer as its layers, outermost first. */
type LoggedError =
  | { readonly chain: SerializedError }
  | { readonly layers: readonly LoggedLayer[]; readonly layersNotKept?: number; readonly contextsCut?: true };

/** One log line: a JSON object, nothing before it. */
export interface LogRecord extends Correlation {
  readonly ts: string;
  readonly level: LogLevel;
  /** The UUID of the logger, minted once per composition: two processes' lines in one stream are told apart by it. */
  readonly boot: string;
  readonly event: LogEvent;
  readonly msg: string;
  readonly fields?: Readonly<Record<string, JsonValue>>;
  readonly error?: LoggedError;
}

export interface LogSink {
  write(record: LogRecord): void;
}

type Narrowing = Omit<Partial<Correlation>, "traceId" | "parentTraceId"> & { readonly trace?: "new" };

/**
 * Ashara's one logger. Logging never throws and never stops the path that logs: a record that
 * cannot be built is replaced by one that says so, and a sink that throws is reported to stderr.
 */
export interface Logger {
  readonly boot: string;
  debug(event: LogEvent, msg: string, fields?: LogFields): void;
  info(event: LogEvent, msg: string, fields?: LogFields): void;
  warn(event: LogEvent, msg: string, fields?: LogFields, error?: unknown): void;
  error(event: LogEvent, msg: string, fields: LogFields, error?: unknown): void;
  /**
   * Runs `work` with its records carrying `narrow` beside the enclosing scope's correlation;
   * `trace: "new"` mints a trace whose parent is the enclosing one.
   */
  scope<T>(narrow: Narrowing, work: () => T): T;
  /** The trace the enclosing scope carries, the root's outside every scope: what a record emitted here would carry. */
  trace(): string;
}

/** A v4 UUID from the host's entropy, never from `randomUUID`, so minting one draws nothing from an id stream. */
function freshId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanArray(items: readonly unknown[], depth: number, ancestors: Set<object>): JsonValue {
  const kept = items.slice(0, MAX_FIELD_KEYS).map((item) => clean(item, undefined, depth + 1, ancestors));
  if (items.length > MAX_FIELD_KEYS) kept.push(`[${items.length - MAX_FIELD_KEYS} more items not kept]`);
  return kept;
}

function cleanObject(value: object, depth: number, ancestors: Set<object>): Record<string, JsonValue> {
  const keys = Object.keys(value);
  const entries: [string, JsonValue][] = keys
    .slice(0, MAX_FIELD_KEYS)
    .map((key) => [key, clean(Reflect.get(value, key), key, depth + 1, ancestors)]);
  if (keys.length > MAX_FIELD_KEYS) entries.push(["[more keys]", `${keys.length - MAX_FIELD_KEYS} not kept`]);
  return Object.fromEntries(entries);
}

/**
 * A field value as bounded, redacted JSON: a `Secret` or a deny-listed name becomes `[redacted]`,
 * a non-JSON value (undefined, NaN, a bigint) a marker, a cycle `[circular]`. Never throws.
 */
function clean(value: unknown, name: string | undefined, depth: number, ancestors: Set<object>): JsonValue {
  if (name !== undefined && isDeniedFieldName(name)) return REDACTED;
  try {
    if (value instanceof Secret) return REDACTED;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length <= MAX_FIELD_STRING_CHARS ? value : cutText(value, MAX_FIELD_STRING_CHARS);
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value !== "object") return `[${typeof value}]`;
    if (ancestors.has(value)) return "[circular]";
    if (depth >= MAX_FIELD_DEPTH) return "[nested too deep]";
    ancestors.add(value);
    try {
      return Array.isArray(value) ? cleanArray(value, depth, ancestors) : cleanObject(value, depth, ancestors);
    } finally {
      ancestors.delete(value);
    }
  } catch (thrown) {
    return `[unserializable: ${describeErrorChain(thrown).slice(0, 200)}]`;
  }
}

function cleanFields(fields: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  return cleanObject(fields, 0, new Set());
}

/** A serialized chain with every layer's fields redacted by name, its children and causes alike. */
function redactChain(s: SerializedError): SerializedError {
  return {
    ...s,
    ...(s.fields !== undefined ? { fields: cleanFields(s.fields) } : {}),
    ...(s.errors !== undefined ? { errors: s.errors.map(redactChain) } : {}),
    ...(s.cause !== undefined ? { cause: redactChain(s.cause) } : {}),
  };
}

function loggedLayers(error: unknown): LoggedError | undefined {
  const parsed = errorLayerSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const all = flattenChain(parsed.data);
  const layers: LoggedLayer[] = all.slice(0, MAX_ERROR_LAYERS).map((layer) => ({
    boundary: cutText(layer.boundary, MAX_FIELD_STRING_CHARS),
    operation: cutText(layer.operation, MAX_FIELD_STRING_CHARS),
    message: cutText(layer.message, MAX_FIELD_STRING_CHARS),
    ...(layer.context !== undefined ? { context: cleanFields(layer.context) } : {}),
    timestamp: layer.timestamp,
  }));
  const notKept = all.length > MAX_ERROR_LAYERS ? { layersNotKept: all.length - MAX_ERROR_LAYERS } : {};
  const whole: LoggedError = { layers, ...notKept };
  if (JSON.stringify(whole).length <= MAX_ERROR_CHARS) return whole;
  return { layers: layers.map(({ context: _context, ...rest }) => rest), ...notKept, contextsCut: true };
}

/** An error as a record holds it: an ErrorLayer as its layers, anything else as its serialized chain. Never throws. */
function loggedError(error: unknown): LoggedError {
  try {
    const layers = typeof error === "object" && error !== null && "boundary" in error ? loggedLayers(error) : undefined;
    return layers ?? { chain: redactChain(serializeError(error, MAX_ERROR_CHARS)) };
  } catch (thrown) {
    return { chain: { name: "UnloggableError", message: `the error could not be logged: ${describeErrorChain(thrown).slice(0, 1_000)}` } };
  }
}

/**
 * The sink's own failure, on stderr: the one place a record that could not be written is still
 * seen. Whether stderr took it is the result; a stderr that throws is past reporting to.
 */
function reportSinkFailure(event: string, thrown: unknown): boolean {
  try {
    return process.stderr.write(`log sink failed to write "${event}": ${describeErrorChain(thrown)}\n`);
  } catch {
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the report not taken, the honest answer when stderr throws, never read as success
    return false;
  }
}

/** One call to the logger, before it is built into a record: `error` is null when the call passed none. */
interface LogCall {
  readonly level: LogLevel;
  readonly event: LogEvent;
  readonly msg: string;
  readonly fields: LogFields | undefined;
  readonly error: { readonly thrown: unknown } | null;
}

/**
 * The logger of one composition, writing to `sink`. `ts` reads the injected clock, so a simulated
 * run's records carry simulated time. Records below `minLevel` are dropped.
 */
export function createLogger(options: { readonly sink: LogSink; readonly clock: Clock; readonly minLevel: LogLevel }): Logger {
  const { sink, clock, minLevel } = options;
  const boot = freshId();
  const root: Correlation = { traceId: freshId() };
  const scopes = new AsyncLocalStorage<Correlation>();

  const build = ({ level, event, msg, fields, error }: LogCall): LogRecord => {
    const correlation = scopes.getStore() ?? root;
    return {
      ...correlation,
      ts: new Date(clock.now()).toISOString(),
      level,
      boot,
      event,
      msg: msg.length <= MAX_MSG_CHARS ? msg : cutText(msg, MAX_MSG_CHARS),
      ...(fields !== undefined ? { fields: cleanFields(fields) } : {}),
      ...(error !== null ? { error: loggedError(error.thrown) } : {}),
    };
  };

  /** The record, or, when building it threw (a clock that throws, a hostile value), one that says so. */
  const recordOf = (call: LogCall): LogRecord => {
    try {
      return build(call);
    } catch (thrown) {
      return {
        traceId: root.traceId,
        ts: new Date().toISOString(),
        level: call.level,
        boot,
        event: call.event,
        msg: "the log record could not be built",
        error: loggedError(thrown),
      };
    }
  };

  const emit = (call: LogCall): void => {
    if (LEVEL_RANK[call.level] < LEVEL_RANK[minLevel]) return;
    const record = recordOf(call);
    try {
      sink.write(record);
    } catch (thrown) {
      reportSinkFailure(call.event, thrown);
      return;
    }
  };

  return {
    boot,
    debug: (event, msg, fields) => emit({ level: "debug", event, msg, fields, error: null }),
    info: (event, msg, fields) => emit({ level: "info", event, msg, fields, error: null }),
    warn: (event, msg, fields, ...error) => emit({ level: "warn", event, msg, fields, error: error.length > 0 ? { thrown: error[0] } : null }),
    error: (event, msg, fields, ...error) => emit({ level: "error", event, msg, fields, error: error.length > 0 ? { thrown: error[0] } : null }),
    scope(narrow, work) {
      const enclosing = scopes.getStore() ?? root;
      const { trace, ...rest } = narrow;
      const next: Correlation =
        trace === "new" ? { ...enclosing, ...rest, traceId: freshId(), parentTraceId: enclosing.traceId } : { ...enclosing, ...rest };
      return scopes.run(next, work);
    },
    trace: () => (scopes.getStore() ?? root).traceId,
  };
}

/**
 * A sink writing each record as one JSON object and a newline through `write`.
 * @testseam tests read the exact lines a deployment's stdout would carry through it
 */
export function jsonLineSink(write: (line: string) => void): LogSink {
  return { write: (record) => write(`${JSON.stringify(record)}\n`) };
}

/** The production sink: one JSON object per line on the process's stdout. */
export const stdoutSink: LogSink = jsonLineSink((line) => {
  process.stdout.write(line);
});

/** A unit test, or a test builder, hands it where a Logger is injected; a test asserts on the records' `event` and `fields`. */
export function recordingLogger(): Logger & { readonly records: readonly LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createLogger({ sink: { write: (record) => records.push(record) }, clock: systemClock, minLevel: "debug" });
  return { ...logger, records };
}

const jsonRecord = z.record(z.string(), z.json());

const serializedErrorSchema: z.ZodType<SerializedError> = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    message: z.string(),
    fields: jsonRecord.optional(),
    stack: z.string().optional(),
    errors: z.array(serializedErrorSchema).optional(),
    errorsNotKept: z.number().int().nonnegative().optional(),
    cause: serializedErrorSchema.optional(),
    truncated: z.enum(["depth", "cycle", "size"]).optional(),
  }),
);

const loggedLayerSchema = z.strictObject({
  boundary: z.string(),
  operation: z.string(),
  message: z.string(),
  context: jsonRecord.optional(),
  timestamp: z.string(),
});

const loggedErrorSchema = z.union([
  z.strictObject({ chain: serializedErrorSchema }),
  z.strictObject({
    layers: z.array(loggedLayerSchema),
    layersNotKept: z.number().int().positive().optional(),
    contextsCut: z.literal(true).optional(),
  }),
]);

/**
 * One log line's object, for every reader of the stream (tests, the simulator, an operator's viewer).
 * @testseam its readers are tests until the simulator reads the stream as records
 */
export const logRecordSchema: z.ZodType<LogRecord> = z.strictObject({
  traceId: z.string().min(1),
  parentTraceId: z.string().min(1).optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  cycle: z.number().int().nonnegative().optional(),
  callSite: z.string().optional(),
  callId: z.string().optional(),
  cell: z.string().optional(),
  subject: z.string().optional(),
  ts: z.iso.datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  boot: z.uuid(),
  event: z.templateLiteral([z.string(), ".", z.string()]),
  msg: z.string(),
  fields: jsonRecord.optional(),
  error: loggedErrorSchema.optional(),
});
