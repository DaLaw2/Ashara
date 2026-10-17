import type { ZodType } from "zod";
import { TaskOutputSchema } from "./decomposition-types.js";
import { EnvironmentJudgmentSchema } from "./replan.js";

/**
 * Every schema Delivery sends to a model, by call site: the integration schema-acceptance test judges each against every provider type, so a schema a provider refuses fails a test before any run sends it.
 */
export const DELIVERY_MODEL_SCHEMAS: Readonly<Record<string, ZodType<unknown>>> = {
  "decomposition: tasks": TaskOutputSchema,
  "decomposition: environment change": EnvironmentJudgmentSchema,
};
