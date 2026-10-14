import { z } from "zod";

/** Deep enough for any chain Ashara builds; a deeper one is cut and says so. */
const MAX_CAUSE_DEPTH = 8;
/** Nesting of a single field value (an object inside an object, an Error inside a field ...) kept before it is cut. */
const MAX_FIELD_DEPTH = 4;
/** Keys of one object, or items of one array, kept; the rest are counted, not kept. */
const MAX_KEYS = 64;
/** Child errors of one layer (an AggregateError's `errors`) kept; the rest are counted, not kept. */
const MAX_CHILD_ERRORS = 16;
/**
 * Values visited in one serialization, every layer, field and leaf together. A cycle is caught by
 * the ancestor set; this bounds the work on a value that shares sub-objects without one.
 */
const MAX_NODES = 2_000;
/**
 * Each string kept while walking (a message, a stack, a field, a key), before any whole-chain size
 * is computed: the size computation itself must never meet an unbounded string.
 */
const MAX_STRING_CHARS = 16_000;
/** Characters of all strings kept in one serialization together; past it a string is replaced by a marker. */
const MAX_TEXT_CHARS = 1_000_000;
/** Upper bound on the serialized chain as JSON text; a larger one is cut and says so. */
const DEFAULT_MAX_CHARS = 64_000;
/** The smallest bound honoured; a smaller `maxChars` is raised to it so a name and message still fit. */
const MIN_MAX_CHARS = 256;
/** Each string kept once the whole chain exceeded its size bound. */
const CUT_STRING_CHARS = 4_000;
/** Characters of the serializer's own failure kept in its fallback record. */
const FALLBACK_TEXT_CHARS = 1_000;

/** A JSON value: what a serialized error's own fields are reduced to, so the chain stays plain data. */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/**
 * Why a chain is not whole: `depth` cut at MAX_CAUSE_DEPTH, `cycle` a cause that is an earlier
 * error of the same chain, `size` the whole chain exceeded its size bound and was cut to fit.
 */
type ChainTruncation = "depth" | "cycle" | "size";

/**
 * A thrown value as plain data (Discipline C): the error's class, its message, its own enumerable
 * typed fields (argv, exit code, paths ...), its stack, its child errors (an AggregateError's
 * `errors`) and its cause the same way. A thrown non-Error has the name `NonError` and its JSON
 * text as the message.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, JsonValue>>;
  readonly stack?: string;
  readonly errors?: readonly SerializedError[];
  /** Child errors counted but not kept (past MAX_CHILD_ERRORS, the depth or a bound). */
  readonly errorsNotKept?: number;
  readonly cause?: SerializedError;
  readonly truncated?: ChainTruncation;
}

/**
 * The shape a serialized chain is read back through.
 * @testseam nothing Ashara stores is a bare SerializedError read back today; the schema pins the written shape.
 */
export const serializedErrorSchema: z.ZodType<SerializedError> = z.lazy(() =>
  z.object({
    name: z.string(),
    message: z.string(),
    fields: z.record(z.string(), jsonValueSchema).optional(),
    stack: z.string().optional(),
    errors: z.array(serializedErrorSchema).optional(),
    errorsNotKept: z.number().int().nonnegative().optional(),
    cause: serializedErrorSchema.optional(),
    truncated: z.enum(["depth", "cycle", "size"]).optional(),
  }),
);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}[truncated by Ashara: ${max} of ${text.length} characters kept]`;
}

/**
 * What a value thrown inside the serializer itself was. Reads nothing that could throw again
 * unguarded, so the serializer's own failure is still described rather than escaping.
 */
function describeThrown(thrown: unknown): string {
  try {
    if (thrown instanceof Error) {
      const message: unknown = thrown.message;
      return typeof message === "string" ? clip(message, FALLBACK_TEXT_CHARS) : "an Error with a non-string message";
    }
    return typeof thrown === "string" ? clip(thrown, FALLBACK_TEXT_CHARS) : `a thrown ${typeof thrown}`;
  } catch {
    return "a value whose own description threw";
  }
}

type PropertyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly text: string };

/** A property read that a throwing getter or proxy trap cannot escape from. */
function readProperty(target: object, key: string): PropertyRead {
  try {
    return { ok: true, value: Reflect.get(target, key) };
  } catch (thrown) {
    return { ok: false, text: `[unreadable: ${describeThrown(thrown)}]` };
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * One serialization's shared state: the objects on the current path (every layer of the cause
 * chain stays on it while its causes are walked), the values visited so far against MAX_NODES and
 * the text still allowed against MAX_TEXT_CHARS. Every layer, child error and field, an Error inside
 * a field included, shares it, so no nested value restarts the bounds. A layer's own name and message
 * draw on a budget of their own, so a wide layer's fields cannot spend the text its causes are named by.
 */
interface Walk {
  readonly ancestors: Set<object>;
  nodes: number;
  readonly textLeft: Record<TextPool, number>;
}

/** `head`: a chain layer's own name and message; `body`: everything else (fields, keys, stacks). */
type TextPool = "head" | "body";

function newWalk(): Walk {
  return { ancestors: new Set(), nodes: 0, textLeft: { head: MAX_TEXT_CHARS, body: MAX_TEXT_CHARS } };
}

/** A string as kept: at most MAX_STRING_CHARS, and only while the walk's budget for its pool lasts. */
function keepText(text: string, walk: Walk, pool: TextPool = "body"): string {
  const left = walk.textLeft[pool];
  if (left <= 0) return `[not kept: text budget spent, ${text.length} characters]`;
  const allowed = Math.min(MAX_STRING_CHARS, left);
  walk.textLeft[pool] = left - Math.min(text.length, allowed);
  return clip(text, allowed);
}

/** Any value as one line of text, through the same bounded walk as a field. */
function describeValue(value: unknown, walk: Walk): string {
  const json = toJsonValue(value, 0, walk);
  if (typeof json === "string") return json;
  try {
    return JSON.stringify(json);
  } catch (thrown) {
    return `[not describable: ${describeThrown(thrown)}]`;
  }
}

function readText(target: object, key: string, walk: Walk, pool: TextPool = "body"): string {
  const read = readProperty(target, key);
  if (!read.ok) return read.text;
  if (read.value === undefined) return "";
  return typeof read.value === "string" ? keepText(read.value, walk, pool) : describeValue(read.value, walk);
}

/**
 * An Error layer's keys that are serialized in their own slot, so they are not repeated among its
 * fields. Only an Error has these slots: a plain object's `message`, `name`, `stack` or `cause` is
 * ordinary data (a driver's `{code, message}`, a provider's `{error: {message}}`) and is kept.
 */
const ERROR_SLOTS: ReadonlySet<string> = new Set(["name", "message", "stack", "cause"]);
const ERROR_SLOTS_WITH_CHILDREN: ReadonlySet<string> = new Set([...ERROR_SLOTS, "errors"]);
const NO_SLOTS: ReadonlySet<string> = new Set();

/** An Error layer's keys kept out of its fields: its slots, and `errors` when that is serialized as child errors. */
function errorSlots(hasChildArray: boolean): ReadonlySet<string> {
  return hasChildArray ? ERROR_SLOTS_WITH_CHILDREN : ERROR_SLOTS;
}

/** The own enumerable keys of `target` other than `skip`, each value at `childDepth`. */
function fieldsOf(target: object, childDepth: number, walk: Walk, skip: ReadonlySet<string>): Record<string, JsonValue> {
  let keys: string[];
  try {
    keys = Object.keys(target);
  } catch (thrown) {
    return { "[keys]": `[unreadable: ${describeThrown(thrown)}]` };
  }
  const kept = keys.filter((key) => !skip.has(key));
  const entries: [string, JsonValue][] = kept.slice(0, MAX_KEYS).map((key) => {
    const read = readProperty(target, key);
    return [keepText(key, walk), read.ok ? toJsonValue(read.value, childDepth, walk) : read.text];
  });
  if (kept.length > MAX_KEYS) entries.push(["[more keys]", `${kept.length - MAX_KEYS} not kept`]);
  return Object.fromEntries(entries);
}

/** An Error found inside a field: name, message, fields, child errors and cause, all at the field's own depth. */
function errorAsJson(err: Error, depth: number, walk: Walk): JsonValue {
  const children = readProperty(err, "errors");
  const childArray = children.ok && isArray(children.value) ? children.value : undefined;
  const fields = fieldsOf(err, depth + 1, walk, errorSlots(childArray !== undefined));
  const entries: [string, JsonValue][] = [
    ["name", readText(err, "name", walk)],
    ["message", readText(err, "message", walk)],
  ];
  if (Object.keys(fields).length > 0) entries.push(["fields", fields]);
  if (childArray !== undefined) entries.push(["errors", arrayAsJson(childArray, depth, walk)]);
  const cause = readProperty(err, "cause");
  if (!cause.ok) entries.push(["cause", cause.text]);
  else if (cause.value !== undefined) entries.push(["cause", toJsonValue(cause.value, depth + 1, walk)]);
  return Object.fromEntries(entries);
}

function lengthOf(items: readonly unknown[]): number {
  const read = readProperty(items, "length");
  return read.ok && typeof read.value === "number" && Number.isSafeInteger(read.value) && read.value >= 0 ? read.value : 0;
}

function arrayAsJson(items: readonly unknown[], depth: number, walk: Walk): JsonValue {
  const out: JsonValue[] = [];
  const length = lengthOf(items);
  for (let i = 0; i < Math.min(length, MAX_KEYS); i++) {
    const read = readProperty(items, String(i));
    out.push(read.ok ? toJsonValue(read.value, depth + 1, walk) : read.text);
  }
  if (length > MAX_KEYS) out.push(`[${length - MAX_KEYS} more items not kept]`);
  return out;
}

/** Binary data is described by its size, never enumerated byte by byte. */
function binarySize(value: object): number | undefined {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return value.byteLength;
  return undefined;
}

/** A field value as JSON. A cycle, an over-deep value, a spent budget or a throwing read says so. */
function toJsonValue(value: unknown, depth: number, walk: Walk): JsonValue {
  if (walk.nodes >= MAX_NODES) return "[not kept: value budget spent]";
  walk.nodes++;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return keepText(value, walk);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return keepText(`${value.toString()}n`, walk);
  if (value === undefined) return "[undefined]";
  if (typeof value === "symbol") return keepText(`[${value.toString()}]`, walk);
  if (typeof value === "function") return `[function ${readText(value, "name", walk) || "anonymous"}]`;
  if (walk.ancestors.has(value)) return "[circular]";
  if (depth >= MAX_FIELD_DEPTH) return "[nested too deep]";
  walk.ancestors.add(value);
  try {
    const bytes = binarySize(value);
    if (bytes !== undefined) return `[binary ${bytes} bytes]`;
    if (isError(value)) return errorAsJson(value, depth, walk);
    if (isArray(value)) return arrayAsJson(value, depth, walk);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
    return fieldsOf(value, depth + 1, walk, NO_SLOTS);
  } catch (thrown) {
    return `[unserializable: ${describeThrown(thrown)}]`;
  } finally {
    walk.ancestors.delete(value);
  }
}

/** A layer's child errors (an AggregateError's `errors`, or any `errors` array on an Error), each a chain of its own. */
function childErrors(items: readonly unknown[], depth: number, walk: Walk): Pick<SerializedError, "errors" | "errorsNotKept"> {
  const length = lengthOf(items);
  if (length === 0) return {};
  const errors: SerializedError[] = [];
  const room = depth + 1 >= MAX_CAUSE_DEPTH ? 0 : Math.min(length, MAX_CHILD_ERRORS);
  for (let i = 0; i < room && walk.nodes < MAX_NODES; i++) {
    const read = readProperty(items, String(i));
    if (!read.ok) errors.push({ name: "UnreadableError", message: read.text });
    else if (typeof read.value === "object" && read.value !== null && walk.ancestors.has(read.value)) {
      errors.push({ name: "CircularError", message: "[an error already on this chain]", truncated: "cycle" });
    } else errors.push(serializeChain(read.value, depth + 1, walk));
  }
  return {
    ...(errors.length > 0 ? { errors } : {}),
    ...(length > errors.length ? { errorsNotKept: length - errors.length } : {}),
  };
}

function serializeChain(err: unknown, depth: number, walk: Walk): SerializedError {
  if (!isError(err)) {
    return { name: "NonError", message: describeValue(err, walk), fields: { type: err === null ? "null" : typeof err } };
  }
  walk.nodes++;
  walk.ancestors.add(err);
  try {
    const children = readProperty(err, "errors");
    const childArray = children.ok && isArray(children.value) ? children.value : undefined;
    const fields = fieldsOf(err, 0, walk, errorSlots(childArray !== undefined));
    const stack = readProperty(err, "stack");
    const base: SerializedError = {
      name: readText(err, "name", walk, "head"),
      message: readText(err, "message", walk, "head"),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      ...(stack.ok && typeof stack.value === "string" ? { stack: keepText(stack.value, walk) } : {}),
      ...(childArray !== undefined ? childErrors(childArray, depth, walk) : {}),
    };
    const cause = readProperty(err, "cause");
    if (!cause.ok) return { ...base, cause: { name: "UnreadableCause", message: cause.text } };
    if (cause.value === undefined) return base;
    if (typeof cause.value === "object" && cause.value !== null && walk.ancestors.has(cause.value)) {
      return { ...base, truncated: "cycle" };
    }
    if (depth + 1 >= MAX_CAUSE_DEPTH) return { ...base, truncated: "depth" };
    return { ...base, cause: serializeChain(cause.value, depth + 1, walk) };
  } finally {
    walk.ancestors.delete(err);
  }
}

function cutJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return clip(value, CUT_STRING_CHARS);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cutJson);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutJson(item)]));
}

function withoutStacks(s: SerializedError): SerializedError {
  const { stack: _stack, cause, errors, ...rest } = s;
  return {
    ...rest,
    ...(errors !== undefined ? { errors: errors.map(withoutStacks) } : {}),
    ...(cause !== undefined ? { cause: withoutStacks(cause) } : {}),
  };
}

function withCutStrings(s: SerializedError): SerializedError {
  const fields: Record<string, JsonValue> | undefined =
    s.fields === undefined ? undefined : Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, cutJson(v)]));
  return {
    name: clip(s.name, CUT_STRING_CHARS),
    message: clip(s.message, CUT_STRING_CHARS),
    ...(fields !== undefined ? { fields } : {}),
    ...(s.errors !== undefined ? { errors: s.errors.map(withCutStrings) } : {}),
    ...(s.errorsNotKept !== undefined ? { errorsNotKept: s.errorsNotKept } : {}),
    ...(s.cause !== undefined ? { cause: withCutStrings(s.cause) } : {}),
    ...(s.truncated !== undefined ? { truncated: s.truncated } : {}),
  };
}

/** Every layer's child errors dropped and counted instead. */
function withoutChildErrors(s: SerializedError): SerializedError {
  const { errors, errorsNotKept, cause, ...rest } = s;
  const notKept = (errors?.length ?? 0) + (errorsNotKept ?? 0);
  return {
    ...rest,
    ...(notKept > 0 ? { errorsNotKept: notKept } : {}),
    ...(cause !== undefined ? { cause: withoutChildErrors(cause) } : {}),
  };
}

/** The chain with only its first `keep` layers, the last one marked as cut for size. */
function firstLayers(s: SerializedError, keep: number): SerializedError {
  if (s.cause === undefined) return s;
  if (keep > 1) return { ...s, cause: firstLayers(s.cause, keep - 1) };
  const { cause: _dropped, ...rest } = s;
  return { ...rest, truncated: "size" };
}

function chainLength(s: SerializedError): number {
  return s.cause === undefined ? 1 : 1 + chainLength(s.cause);
}

function size(s: SerializedError): number {
  return JSON.stringify(s).length;
}

/**
 * The root's name and message alone, halved until they fit: the step that cannot fail to fit,
 * for a single layer whose fields alone exceed the bound.
 */
function nameAndMessageOnly(s: SerializedError, maxChars: number): SerializedError {
  let name = s.name;
  let message = s.message;
  for (;;) {
    const candidate: SerializedError = { name, message, truncated: "size" };
    if (size(candidate) <= maxChars || (name === "" && message === "")) return candidate;
    if (message !== "") message = message.slice(0, Math.floor(message.length / 2));
    else name = name.slice(0, Math.floor(name.length / 2));
  }
}

/**
 * Past the bound the stacks go first, then every string is cut, then the child errors, then the
 * deepest layers, then the root's fields. Every string is already within MAX_STRING_CHARS and the
 * whole within MAX_TEXT_CHARS, so each size computation here is bounded.
 */
function fitTo(full: SerializedError, maxChars: number): SerializedError {
  if (size(full) <= maxChars) return full;
  const markRoot = (s: SerializedError): SerializedError => ({ ...s, truncated: s.truncated ?? "size" });
  const noStacks = withoutStacks(full);
  if (size(noStacks) <= maxChars) return markRoot(noStacks);
  let cut = withCutStrings(noStacks);
  if (size(cut) <= maxChars) return markRoot(cut);
  cut = withoutChildErrors(cut);
  if (size(cut) <= maxChars) return markRoot(cut);
  for (let keep = chainLength(cut) - 1; keep >= 1; keep--) {
    cut = firstLayers(cut, keep);
    if (size(cut) <= maxChars) return markRoot(cut);
  }
  return nameAndMessageOnly(cut, maxChars);
}

/**
 * The one cause-chain serializer for an error that crosses a boundary (a block's reason, an
 * envelope's chain, an attempt record, the fatal exit). Never throws: every property read is
 * guarded, every string is cut while it is walked, and the walk and the fitting both run inside one
 * guard whose failure comes back as an `UnserializableError` record of bounded size.
 * Bounded: MAX_CAUSE_DEPTH layers, MAX_CHILD_ERRORS child errors a layer, MAX_FIELD_DEPTH and
 * MAX_KEYS per field value, MAX_NODES values in all, and at most `maxChars` (never below
 * MIN_MAX_CHARS) of JSON text; a root cut to fit says `truncated: "size"`.
 */
export function serializeError(err: unknown, maxChars: number = DEFAULT_MAX_CHARS): SerializedError {
  const bound = Number.isNaN(maxChars) ? DEFAULT_MAX_CHARS : Math.max(MIN_MAX_CHARS, maxChars);
  try {
    return fitTo(serializeChain(err, 0, newWalk()), bound);
  } catch (thrown) {
    const text = clip(describeThrown(thrown), Math.floor((bound - 100) / 6));
    return { name: "UnserializableError", message: `the thrown value could not be serialized: ${text}`, truncated: "size" };
  }
}

/**
 * The head of a thrown value without its chain: whether it is an Error, and its own message (a
 * non-Error's description), cut to the per-string bound. Never throws, for a caller that keeps the
 * message beside the serialized chain (an ErrorLayer's own message).
 */
export function errorHead(err: unknown): { readonly isError: boolean; readonly message: string } {
  try {
    const walk = newWalk();
    if (isError(err)) return { isError: true, message: readText(err, "message", walk, "head") };
    return { isError: false, message: describeValue(err, walk) };
  } catch (thrown) {
    return { isError: false, message: `[not describable: ${describeThrown(thrown)}]` };
  }
}

/** Every layer of a serialized chain, outermost first. */
function serializedLayers(s: SerializedError): SerializedError[] {
  const layers: SerializedError[] = [];
  let current: SerializedError | undefined = s;
  while (current !== undefined) {
    layers.push(current);
    current = current.cause;
  }
  return layers;
}

function describeSerialized(s: SerializedError): string {
  const parts: string[] = [];
  for (const layer of serializedLayers(s)) {
    let text = layer.name === "NonError" ? `non-Error thrown: ${layer.message}` : `${layer.name}: ${layer.message}`;
    const children = layer.errors ?? [];
    const notKept = layer.errorsNotKept ?? 0;
    if (children.length > 0 || notKept > 0) {
      const listed = children.map(describeSerialized);
      if (notKept > 0) listed.push(`${notKept} more not kept`);
      text += ` [${children.length + notKept} errors: ${listed.join("; ")}]`;
    }
    parts.push(text);
    if (layer.truncated !== undefined && layer.truncated !== "size") parts.push(`[chain cut: ${layer.truncated}]`);
  }
  return parts.join(" <- caused by ");
}

/**
 * The serialized chain as one line, every cause's name and message kept and every child error
 * listed, for a durable text record of a failure (a block's reason, a last-error column, a
 * client-message internal, a log line). Never throws: it reads only the plain data serializeError returns.
 */
export function describeErrorChain(err: unknown): string {
  return describeSerialized(serializeError(err));
}
