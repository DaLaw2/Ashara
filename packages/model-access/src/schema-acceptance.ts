import { asSchema } from "ai";
import type { ZodType } from "zod";
import { GatewayError } from "./errors.js";
import type { ProviderType } from "./types.js";

/**
 * A restriction a provider puts on a JSON schema it is sent. Each is a refusal the provider makes of
 * the whole request (an HTTP 400 before any token is generated), so a schema that breaks one is
 * never sent: it would cost a request and answer nothing.
 * - object-root: the schema's root is one object (`type: "object"`), never a union of them.
 * - single-schema-items: an array's `items` is one schema; a tuple (`items` as an array of schemas,
 *   or `prefixItems`) is refused.
 * - closed-objects: every object says `additionalProperties: false`.
 * - every-property-required: every property of every object is listed in its `required`.
 * - no-recursive-reference: no `$ref` leads back to a schema it is inside.
 */
type SchemaRule = "object-root" | "single-schema-items" | "closed-objects" | "every-property-required" | "no-recursive-reference";

/** What a schema is sent for: a structured answer's format, or one tool's input. */
type SchemaUse = "structured-output" | "tool-input";

/**
 * How a structured request reaches a provider type: its schema sent with the request for the
 * provider to decode against ("native"), or a JSON answer asked for in the prompt text and parsed
 * and validated by the gateway ("text"), in which case no schema is sent and none can be refused.
 */
type StructuredOutputMode = { readonly mode: "native"; readonly rules: readonly SchemaRule[] } | { readonly mode: "text" };

interface ProviderSchemaRestrictions {
  readonly structuredOutput: StructuredOutputMode;
  readonly toolInput: readonly SchemaRule[];
}

/**
 * A tool's input schema is the root of a function's arguments for every provider type, and a tuple is
 * held to none: draft 2020-12, which tool schemas are read as, has no array form of `items`, and a
 * tuple is never needed, since an object with named members says the same.
 */
const TOOL_INPUT_RULES: readonly SchemaRule[] = ["object-root", "single-schema-items"];

/**
 * The documented restrictions of each provider type, as data: what the gateway refuses to send it.
 * - anthropic: the Messages API `output_config.format` JSON schema limitations (no recursive schema,
 *   `additionalProperties` only false, no complex array constraints), as the @ai-sdk/anthropic adapter
 *   leaves them: it moves string, number and size constraints into descriptions and closes every
 *   object, and passes an array-form `items` through, which the API refuses with "Array types must be
 *   specified with a single object schema for 'items'".
 * - openai: @ai-sdk/openai sends every schema with `strict: true` unless told otherwise, and strict
 *   structured outputs take only an object root, closed objects and every property required.
 * - deepseek, openai-compatible, local: answered in text (StructuredOutputMode "text").
 */
const PROVIDER_SCHEMA_RESTRICTIONS: Readonly<Record<ProviderType, ProviderSchemaRestrictions>> = {
  anthropic: {
    structuredOutput: { mode: "native", rules: ["single-schema-items", "closed-objects", "no-recursive-reference"] },
    toolInput: TOOL_INPUT_RULES,
  },
  openai: {
    structuredOutput: { mode: "native", rules: ["object-root", "single-schema-items", "closed-objects", "every-property-required"] },
    toolInput: TOOL_INPUT_RULES,
  },
  deepseek: { structuredOutput: { mode: "text" }, toolInput: TOOL_INPUT_RULES },
  "openai-compatible": { structuredOutput: { mode: "text" }, toolInput: TOOL_INPUT_RULES },
  local: { structuredOutput: { mode: "text" }, toolInput: TOOL_INPUT_RULES },
};

/** Whether a structured request to `providerType` sends its schema for the provider to decode against. */
export function sendsStructuredSchema(providerType: ProviderType): boolean {
  return PROVIDER_SCHEMA_RESTRICTIONS[providerType].structuredOutput.mode === "native";
}

function rulesFor(providerType: ProviderType, use: SchemaUse): readonly SchemaRule[] {
  const restrictions = PROVIDER_SCHEMA_RESTRICTIONS[providerType];
  if (use === "tool-input") return restrictions.toolInput;
  return restrictions.structuredOutput.mode === "native" ? restrictions.structuredOutput.rules : [];
}

/** One place a schema breaks one rule: its JSON pointer and what is there. */
interface SchemaRefusal {
  readonly path: string;
  readonly rule: SchemaRule;
  readonly detail: string;
}

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, ...segments: readonly (string | number)[]): string {
  return segments.reduce<string>((at, segment) => `${at}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`, path);
}

/** Keywords whose value is one subschema. */
const ONE_SUBSCHEMA = ["additionalProperties", "not", "if", "then", "else", "contains", "additionalItems", "propertyNames"] as const;
/** Keywords whose value is a list of subschemas. */
const LIST_OF_SUBSCHEMAS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
/** Keywords whose value maps names to subschemas. */
const MAP_OF_SUBSCHEMAS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

function isObjectSchema(node: JsonObject): boolean {
  const type = node["type"];
  return type === "object" || (Array.isArray(type) && type.includes("object")) || isJsonObject(node["properties"]);
}

/** The refusals one schema node makes itself, its subschemas aside. */
function nodeRefusals(node: JsonObject, path: string, rules: ReadonlySet<SchemaRule>): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  if (rules.has("single-schema-items")) {
    if (Array.isArray(node["items"])) {
      refusals.push({ path: pointer(path, "items"), rule: "single-schema-items", detail: `"items" is a list of ${node["items"].length} schemas (a tuple)` });
    }
    if (node["prefixItems"] !== undefined) refusals.push({ path: pointer(path, "prefixItems"), rule: "single-schema-items", detail: `"prefixItems" is a tuple` });
  }
  if (isObjectSchema(node)) {
    if (rules.has("closed-objects") && node["additionalProperties"] !== false) {
      refusals.push({ path, rule: "closed-objects", detail: `an object whose "additionalProperties" is ${JSON.stringify(node["additionalProperties"]) ?? "absent"}, not false` });
    }
    const properties = node["properties"];
    if (rules.has("every-property-required") && isJsonObject(properties)) {
      const required = new Set(Array.isArray(node["required"]) ? node["required"].filter((key): key is string => typeof key === "string") : []);
      const optional = Object.keys(properties).filter((key) => !required.has(key));
      if (optional.length > 0) refusals.push({ path, rule: "every-property-required", detail: `properties ${optional.map((key) => JSON.stringify(key)).join(", ")} are not required` });
    }
  }
  return refusals;
}

/** Every subschema of a node, with its pointer. */
function subschemas(node: JsonObject, path: string): Array<readonly [JsonObject, string]> {
  const found: Array<readonly [JsonObject, string]> = [];
  for (const key of ONE_SUBSCHEMA) {
    const value = node[key];
    if (isJsonObject(value)) found.push([value, pointer(path, key)]);
  }
  for (const key of LIST_OF_SUBSCHEMAS) {
    const value = node[key];
    if (Array.isArray(value)) for (const [i, each] of value.entries()) if (isJsonObject(each)) found.push([each, pointer(path, key, i)]);
  }
  for (const key of MAP_OF_SUBSCHEMAS) {
    const value = node[key];
    if (isJsonObject(value)) for (const [name, each] of Object.entries(value)) if (isJsonObject(each)) found.push([each, pointer(path, key, name)]);
  }
  const items = node["items"];
  if (isJsonObject(items)) found.push([items, pointer(path, "items")]);
  if (Array.isArray(items)) for (const [i, each] of items.entries()) if (isJsonObject(each)) found.push([each, pointer(path, "items", i)]);
  return found;
}

/**
 * A `$ref` that points at the root or at a schema it is inside: a recursive schema. A reference into
 * a definition is followed, so a definition that refers to itself through others is found too.
 */
function recursiveReferences(root: JsonObject): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const resolve = (ref: string): JsonObject | null => {
    if (ref === "#") return root;
    if (!ref.startsWith("#/")) return null;
    let at: unknown = root;
    for (const segment of ref.slice(2).split("/")) {
      at = isJsonObject(at) ? at[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    }
    return isJsonObject(at) ? at : null;
  };
  const walk = (node: JsonObject, path: string, inside: readonly JsonObject[]): void => {
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const target = resolve(ref);
      if (target !== null && (inside.includes(target) || target === node)) {
        refusals.push({ path: pointer(path, "$ref"), rule: "no-recursive-reference", detail: `"$ref" ${JSON.stringify(ref)} refers to a schema it is inside` });
        return;
      }
      if (target !== null) walk(target, `${path}(${ref})`, [...inside, node]);
    }
    for (const [child, childPath] of subschemas(node, path)) walk(child, childPath, [...inside, node]);
  };
  walk(root, "#", []);
  return refusals;
}

function refusalsUnder(root: unknown, rules: readonly SchemaRule[]): SchemaRefusal[] {
  if (rules.length === 0) return [];
  if (!isJsonObject(root)) return [{ path: "#", rule: "object-root", detail: `the schema is ${JSON.stringify(root) ?? "absent"}, not a JSON schema object` }];
  const active = new Set(rules);
  const refusals: SchemaRefusal[] = [];
  if (active.has("object-root") && root["type"] !== "object") {
    refusals.push({ path: "#", rule: "object-root", detail: `the root's "type" is ${JSON.stringify(root["type"]) ?? "absent"}, not "object"` });
  }
  const walk = (node: JsonObject, path: string): void => {
    refusals.push(...nodeRefusals(node, path, active));
    for (const [child, childPath] of subschemas(node, path)) walk(child, childPath);
  };
  walk(root, "#");
  if (active.has("no-recursive-reference")) refusals.push(...recursiveReferences(root));
  return refusals;
}

/**
 * Every restriction of `providerType` the JSON schema breaks when sent for `use`; none when that
 * type takes it as it is, or is sent no schema for that use. The gateway judges every request with
 * it, and the simulator's stand-in transports judge every request they are sent.
 */
export function schemaRefusalsFor(providerType: ProviderType, use: SchemaUse, jsonSchema: unknown): SchemaRefusal[] {
  return refusalsUnder(jsonSchema, rulesFor(providerType, use));
}

/**
 * The JSON schema the AI SDK sends for a Zod schema: its own conversion (draft 7, input side, every
 * object closed), never a separate rendering that could differ from it.
 */
export async function wireSchemaOf(schema: ZodType<unknown>): Promise<unknown> {
  return await asSchema(schema).jsonSchema;
}

/** What a refused schema was to be sent with: the call site, where it goes, and for what. */
interface SchemaTarget {
  readonly site: string;
  readonly provider: string;
  readonly providerType: ProviderType;
  readonly model: string;
  /** "structured output", or the tool's name. */
  readonly sentAs: string;
}

/**
 * A schema Ashara was about to send breaks a restriction of the provider type it was going to:
 * Ashara's defect, found before the request was admitted, so nothing was spent and no other
 * provider is tried (a failover would hide it).
 */
export class SchemaUnacceptable extends GatewayError {
  readonly target: SchemaTarget;
  readonly refusals: readonly SchemaRefusal[];

  constructor(target: SchemaTarget, refusals: readonly SchemaRefusal[]) {
    super(
      `call site "${target.site}": the ${target.sentAs} schema is one provider type "${target.providerType}" refuses ` +
        `(provider ${target.provider}, model ${target.model}), so the request was not sent: ` +
        refusals.map((refusal) => `${refusal.path}: ${refusal.rule}: ${refusal.detail}`).join("; "),
    );
    this.name = "SchemaUnacceptable";
    this.target = target;
    this.refusals = refusals;
  }
}

/** Throws SchemaUnacceptable when `jsonSchema` breaks any restriction of the target's type for `use`. */
export function refuseUnacceptableSchema(target: SchemaTarget, use: SchemaUse, jsonSchema: unknown): void {
  const refusals = schemaRefusalsFor(target.providerType, use, jsonSchema);
  if (refusals.length > 0) throw new SchemaUnacceptable(target, refusals);
}
