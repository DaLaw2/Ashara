import type { z } from "zod";
import { DELIVERY_MODEL_SCHEMAS } from "@ashara/delivery";
import { ENGAGEMENT_MODEL_SCHEMAS } from "@ashara/engagement";
import { PROVIDER_TYPES, schemaRefusalsFor, wireSchemaOf } from "@ashara/model-access";
import { ORGANIZATION_MODEL_SCHEMAS } from "@ashara/organization";
import { QUALITY_MODEL_SCHEMAS } from "@ashara/quality";
import { offeredToolSchemas } from "@ashara/workplace";
import type { Violation } from "./invariants.js";

// The gateway refuses a schema a provider type would refuse before the request is sent, so a stand-in
// never sees it: the run would end with the call's work halted on Ashara's own fault, a halt no
// oracle judges wrong. Every schema Ashara can send is judged here at the run's start instead, against
// every provider type a deployment may configure, so a refused schema is a violation of every seed.

const STRUCTURED: Readonly<Record<string, z.ZodType<unknown>>> = {
  ...DELIVERY_MODEL_SCHEMAS,
  ...ENGAGEMENT_MODEL_SCHEMAS,
  ...ORGANIZATION_MODEL_SCHEMAS,
  ...QUALITY_MODEL_SCHEMAS,
};

/** One I1 violation per model-bound schema and provider type that refuses it. */
export async function refusedModelSchemas(step: number): Promise<Violation[]> {
  const judged: {
    readonly what: string;
    readonly use: "structured-output" | "tool-input";
    readonly schema: unknown;
  }[] = [];
  for (const [site, schema] of Object.entries(STRUCTURED))
    judged.push({ what: `structured output ${site}`, use: "structured-output", schema: await wireSchemaOf(schema) });
  for (const [tool, schema] of Object.entries(offeredToolSchemas()))
    judged.push({ what: `tool input ${tool}`, use: "tool-input", schema: schema.inputSchema });
  return judged.flatMap(({ what, use, schema }) =>
    PROVIDER_TYPES.flatMap((type) => {
      const refusals = schemaRefusalsFor(type, use, schema);
      if (refusals.length === 0) return [];
      const detail = refusals.map((refusal) => `${refusal.path}: ${refusal.rule}: ${refusal.detail}`).join("; ");
      return [
        {
          invariant: "I1" as const,
          step,
          statement: `the ${what} schema is one provider type ${type} refuses: ${detail}`,
          key: `I1:schema-refused:${type}:${what}`,
        },
      ];
    }),
  );
}
