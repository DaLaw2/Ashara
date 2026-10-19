import type { ZodType } from "zod";
import { AnswerResponseSchema } from "./answers.js";
import { CorrectionResponseSchema } from "./correction.js";
import { IntakeResponseSchema, SecondReadingSchema } from "./intake.js";

/**
 * Every schema Engagement sends to a model, by call site: the integration schema-acceptance test judges each against every provider type, so a schema a provider refuses fails a test before any run sends it.
 */
export const ENGAGEMENT_MODEL_SCHEMAS: Readonly<Record<string, ZodType<unknown>>> = {
  "liaison-intake: tender": IntakeResponseSchema,
  "liaison-intake: second reading": SecondReadingSchema,
  "liaison-intake: answer": AnswerResponseSchema,
  "liaison-intake: change": CorrectionResponseSchema,
};
