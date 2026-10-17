import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DELIVERY_MODEL_SCHEMAS } from "@ashara/delivery";
import { ENGAGEMENT_MODEL_SCHEMAS } from "@ashara/engagement";
import { KNOWN_LLM_SITES, PROVIDER_TYPES, schemaRefusalsFor, wireSchemaOf } from "@ashara/model-access";
import { ORGANIZATION_MODEL_SCHEMAS } from "@ashara/organization";
import { QUALITY_MODEL_SCHEMAS } from "@ashara/quality";
import { offeredToolSchemas } from "@ashara/workplace";

// Every schema Ashara sends to a model, judged against every provider type's documented restrictions
// as the gateway judges it before a request: a schema some provider refuses fails here, before any
// run sends it. The fake transports of every other test take whatever schema they are sent.

const STRUCTURED: Readonly<Record<string, z.ZodType<unknown>>> = {
  ...DELIVERY_MODEL_SCHEMAS,
  ...ENGAGEMENT_MODEL_SCHEMAS,
  ...ORGANIZATION_MODEL_SCHEMAS,
  ...QUALITY_MODEL_SCHEMAS,
};

/** The sites that make no structured call of their own: agent turns, and the ladder's escalation tag on another site's call. */
const NO_STRUCTURED_SCHEMA_OF_THEIR_OWN = new Set(["agent-runner", "escalation"]);

describe("every model-bound schema is one each provider type accepts", () => {
  test.each(Object.keys(STRUCTURED))("structured output %s", async (site) => {
    const schema = STRUCTURED[site];
    if (schema === undefined) throw new Error(`no schema registered as ${site}`);
    const wire = await wireSchemaOf(schema);
    const refused = PROVIDER_TYPES.flatMap((type) => schemaRefusalsFor(type, "structured-output", wire).map((refusal) => ({ type, ...refusal })));
    expect(refused).toEqual([]);
  });

  test.each(Object.keys(offeredToolSchemas()))("tool input %s", (tool) => {
    const schema = offeredToolSchemas()[tool];
    if (schema === undefined) throw new Error(`no tool schema offered as ${tool}`);
    const refused = PROVIDER_TYPES.flatMap((type) => schemaRefusalsFor(type, "tool-input", schema.inputSchema).map((refusal) => ({ type, ...refusal })));
    expect(refused).toEqual([]);
  });

  test("every call site that sends a structured schema has its schemas registered", () => {
    const registered = new Set(Object.keys(STRUCTURED).map((key) => key.split(":")[0]));
    const unregistered = KNOWN_LLM_SITES.filter((site) => !NO_STRUCTURED_SCHEMA_OF_THEIR_OWN.has(site) && !registered.has(site));
    expect(unregistered).toEqual([]);
    expect(Object.keys(offeredToolSchemas()).length).toBeGreaterThan(0);
  });
});

describe("the judgement refuses what a provider refuses, at the path it names", () => {
  const Side = z.strictObject({ checkTask: z.string().min(1), check: z.string().min(1) });

  test("a tuple renders as array-form items, which Anthropic refuses ('Array types must be specified with a single object schema for items')", async () => {
    const wire = await wireSchemaOf(z.strictObject({ conflict: z.tuple([Side, Side]) }));
    expect(wire).toMatchObject({ properties: { conflict: { type: "array", items: [{ type: "object" }, { type: "object" }] } } });
    expect(schemaRefusalsFor("anthropic", "structured-output", wire)).toEqual([
      { path: "#/properties/conflict/items", rule: "single-schema-items", detail: '"items" is a list of 2 schemas (a tuple)' },
    ]);
    // The same shape as two named sides is accepted by every type.
    const named = await wireSchemaOf(z.strictObject({ conflict: z.strictObject({ first: Side, second: Side }) }));
    expect(PROVIDER_TYPES.flatMap((type) => schemaRefusalsFor(type, "structured-output", named))).toEqual([]);
  });

  test("OpenAI's strict structured output refuses an optional property and a union at the root", async () => {
    const optional = await wireSchemaOf(z.strictObject({ ref: z.string().optional(), title: z.string() }));
    expect(schemaRefusalsFor("openai", "structured-output", optional)).toEqual([
      { path: "#", rule: "every-property-required", detail: 'properties "ref" are not required' },
    ]);
    const union = await wireSchemaOf(z.discriminatedUnion("verdict", [z.strictObject({ verdict: z.literal("a") }), z.strictObject({ verdict: z.literal("b") })]));
    expect(schemaRefusalsFor("openai", "structured-output", union).map((refusal) => refusal.rule)).toContain("object-root");
  });

  test("a recursive schema is refused where it refers back", async () => {
    type Node = { readonly children: readonly Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() => z.strictObject({ children: z.array(NodeSchema) }));
    const wire = await wireSchemaOf(z.strictObject({ root: NodeSchema }));
    expect(schemaRefusalsFor("anthropic", "structured-output", wire).map((refusal) => refusal.rule)).toContain("no-recursive-reference");
  });

  test("a provider type answered in text is sent no structured schema, so none is refused; its tool schemas are judged", async () => {
    const wire = await wireSchemaOf(z.strictObject({ conflict: z.tuple([Side, Side]) }));
    expect(schemaRefusalsFor("deepseek", "structured-output", wire)).toEqual([]);
    expect(schemaRefusalsFor("deepseek", "tool-input", { type: "array", items: [{ type: "string" }] }).map((refusal) => refusal.rule)).toEqual(["object-root", "single-schema-items"]);
  });
});
