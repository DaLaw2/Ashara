import { z } from "zod";

// Single source of truth for the category enum: the type is DERIVED from the
// tuple (not the other way around) so the runtime list (used for prompts,
// Zod validation, and iteration) can never drift from the type (ADR-030-style
// enum-drift guard, applied here to close the Run-10 phantom-dimension hole
// where an out-of-enum string like "- **Why**" was accepted as a category).
const DIRECTION_CATEGORY_VALUES = [
  "platform",
  "architecture",
  "data_flow",
  "scale",
  "persistence",
  "deployment",
  "integration",
  "security",
  "scope",
  "stack",
  "priorities",
] as const;

export type DirectionCategory = (typeof DIRECTION_CATEGORY_VALUES)[number];

export const ALL_DIRECTION_CATEGORIES: readonly DirectionCategory[] = DIRECTION_CATEGORY_VALUES;

/** Zod enum built from the SAME tuple as the type -- rejects any other string. */
export const DirectionCategorySchema = z.enum(DIRECTION_CATEGORY_VALUES);

export interface VisionInput {
  readonly description: string;
  readonly additionalContext?: string;
}

export interface DirectionInference {
  readonly category: DirectionCategory;
  readonly inference: string;
  readonly confidence: "high" | "medium" | "low";
  readonly source: "explicit" | "inferred";
}

export interface DirectionQuestion {
  readonly category: DirectionCategory;
  readonly question: string;
  readonly why: string;
  readonly options?: string[];
}

export interface AlignmentResult {
  readonly inferences: DirectionInference[];
  readonly questions: DirectionQuestion[];
  readonly completeness: CompletenessCheck;
  readonly visionSummary: string;
}

export interface CompletenessCheck {
  readonly complete: boolean;
  readonly coveredCategories: DirectionCategory[];
  readonly missingCategories: DirectionCategory[];
  readonly score: number;
}

export interface AlignmentConfig {
  readonly requiredCategories: DirectionCategory[];
  readonly optionalCategories: DirectionCategory[];
  readonly minCompletenessScore: number;
}

export interface ParsedVision {
  readonly raw: string;
}

// ---------------------------------------------------------------------------
// LLM inference call contract (mig4-t1 / T1). Replaces the old free-text
// `AlignmentLLM.generate(): Promise<string>` seam + colon-split parsing. Every
// category the model names must be one of the fixed enum values above --
// there is no path for the model to mint a category string that was not
// already a known, templated question axis (ADR-018: bounded to the fixed
// axis set, so the model cannot introduce a scope-drifting new question).
// ---------------------------------------------------------------------------

export const LLMDirectionInferenceSchema = z
  .object({
    category: DirectionCategorySchema,
    inference: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

/**
 * The structured response shape for one alignment inference call. `inferences`
 * are the model's best-effort directions for categories not already explicit
 * in the vision text; `ambiguousCategories` are categories the model judges
 * cannot be reasonably assumed (genuine ambiguity worth asking the user
 * about) rather than silently guessed. A category must not appear in both --
 * enforced as a semantic (cross-field) check on top of this schema, since Zod
 * alone cannot express the invariant.
 */
export const AlignmentInferenceResponseSchema = z
  .object({
    inferences: z.array(LLMDirectionInferenceSchema),
    ambiguousCategories: z.array(DirectionCategorySchema),
  })
  .strict();

export type AlignmentInferenceResponse = z.infer<typeof AlignmentInferenceResponseSchema>;

/** `inferDirections`' return: inferences plus the categories flagged genuinely ambiguous. */
export interface DirectionInferenceResult {
  readonly inferences: DirectionInference[];
  readonly ambiguousCategories: DirectionCategory[];
}
