import type { StructuredProvider, StructuredValidation } from "@ashara/llm-gateway";

import {
  AlignmentInferenceResponseSchema,
  ALL_DIRECTION_CATEGORIES,
} from "./alignment-types.js";
import type {
  AlignmentConfig,
  AlignmentInferenceResponse,
  AlignmentResult,
  CompletenessCheck,
  DirectionCategory,
  DirectionInference,
  DirectionInferenceResult,
  DirectionQuestion,
  ParsedVision,
  VisionInput,
} from "./alignment-types.js";

/**
 * The alignment inference LLM seam. Structured, schema-validated -- the model
 * returns a typed `AlignmentInferenceResponse`, never free text. Implementations
 * are expected to already ride the reliability ladder (see
 * `createGatewayAlignmentLLM`); this interface is the post-ladder contract.
 */
export interface AlignmentLLM {
  infer(prompt: string): Promise<AlignmentInferenceResponse>;
}

/**
 * Typed terminal failure of the alignment inference call (Discipline C).
 * Carries the vision excerpt it was working from and preserves the
 * underlying cause (normally `StructuredOutputExhausted` from the ladder)
 * without a lossy `toString()` conversion. Thrown by `AlignmentEngine.align`
 * on ladder exhaustion -- it BLOCKS vision intake rather than silently
 * proceeding with an empty/poisoned inference set (Discipline A).
 */
export class AlignmentInferenceError extends Error {
  readonly visionExcerpt: string;

  constructor(message: string, visionExcerpt: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AlignmentInferenceError";
    this.visionExcerpt = visionExcerpt;
  }
}

const RAW_EXCERPT_LENGTH = 400;

function excerpt(text: string): string {
  return text.length <= RAW_EXCERPT_LENGTH ? text : text.slice(0, RAW_EXCERPT_LENGTH);
}

/**
 * Binds the inference call to a structured provider. Mirrors
 * `createGatewaySpecDerivationLLM` (spec-derivation.ts): the composition root
 * wraps the gateway in the reliability ladder ONCE (`withStructuredLadder`,
 * see `alignmentReask` below) and hands the wrapped provider here, so ladder
 * exhaustion surfaces as a typed `StructuredOutputExhausted` rather than a
 * drifted/poisoned result silently reaching the caller.
 */
export function createGatewayAlignmentLLM(provider: StructuredProvider): AlignmentLLM {
  return {
    async infer(prompt: string): Promise<AlignmentInferenceResponse> {
      const response = await provider.generateStructured({
        capability: "Strong",
        prompt,
        schema: AlignmentInferenceResponseSchema,
        maxTokens: 2048,
        temperature: 0,
        validate: validateNoDualCategoryAssignment,
      });
      return response.data;
    },
  };
}

/**
 * Semantic (cross-field) validation the Zod schema cannot express: a category
 * must not be both confidently inferred AND flagged ambiguous in the same
 * response. Returning `ok: false` makes the ladder treat the attempt as
 * failed and (via `alignmentReask`) feed the contradiction back so the model
 * self-heals on retry instead of the caller silently picking a side.
 */
function validateNoDualCategoryAssignment(value: AlignmentInferenceResponse): StructuredValidation {
  const inferredCategories = new Set(value.inferences.map((i) => i.category));
  const overlap = value.ambiguousCategories.filter((c) => inferredCategories.has(c));
  if (overlap.length > 0) {
    return {
      ok: false,
      errors: [
        `Categories cannot be both inferred and marked ambiguous in the same response: ${overlap.join(", ")}`,
      ],
    };
  }
  return { ok: true };
}

/**
 * Re-ask suffix for alignment-inference retries. Restates the fixed category
 * enum and repeats the "JSON only" instruction -- this is the direct fix for
 * the Run-10 poisoning shape, where a markdown-bulleted explanation ("-
 * **Why**: ...") was accepted by the old free-text colon-split parser as a
 * category. Exported so the composition root (CLI) can pass it into
 * `withStructuredLadder` alongside the site name.
 */
export function alignmentReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. Use ONLY these category values: ${ALL_DIRECTION_CATEGORIES.join(", ")}. ` +
    `No markdown, no bullet points, no explanatory prose -- JSON only.`
  );
}

const DEFAULT_CONFIG: AlignmentConfig = {
  requiredCategories: ["platform", "architecture", "data_flow", "persistence", "scope", "stack", "priorities"],
  optionalCategories: ["scale", "deployment", "integration", "security"],
  minCompletenessScore: 0.6,
};

const CATEGORY_QUESTIONS: Record<DirectionCategory, { question: string; why: string; options?: string[] }> = {
  platform: {
    question: "What platform will users interact with?",
    why: "Platform choice determines tech stack, deployment model, and user experience constraints.",
    options: ["Web application", "REST/GraphQL API", "Mobile app", "Desktop app", "CLI tool"],
  },
  architecture: {
    question: "What architectural style fits this system?",
    why: "Architecture impacts team structure, deployment complexity, and how independently components can evolve.",
    options: ["Monolith", "Microservices", "Serverless", "Event-driven"],
  },
  data_flow: {
    question: "How does data flow through the system?",
    why: "Data flow patterns determine latency guarantees, infrastructure costs, and system complexity.",
    options: ["Request-response (synchronous)", "Real-time (WebSocket/SSE)", "Batch processing", "Event-driven (async)"],
  },
  scale: {
    question: "What scale does this system need to support?",
    why: "Scale requirements drive database choices, caching strategy, and infrastructure costs.",
    options: ["Single user / personal tool", "Small team (< 100 users)", "Multi-tenant SaaS", "Enterprise / high-traffic"],
  },
  persistence: {
    question: "What kind of data storage does this system need?",
    why: "Persistence strategy affects data integrity, query patterns, and operational complexity.",
    options: ["Relational (PostgreSQL/MySQL)", "Document store (MongoDB)", "Key-value (Redis)", "File storage", "No persistence needed"],
  },
  deployment: {
    question: "Where will this system be deployed?",
    why: "Deployment target constrains available services, affects latency, and determines operational overhead.",
    options: ["Cloud (AWS/GCP/Azure)", "Self-hosted / on-premises", "Edge / CDN", "Hybrid"],
  },
  integration: {
    question: "Does this system need to integrate with external services?",
    why: "External integrations add failure modes and require retry/fallback strategies in the architecture.",
    options: ["No external integrations", "Payment providers", "Auth providers (OAuth/SSO)", "Third-party APIs", "Webhooks"],
  },
  security: {
    question: "What level of security does this system require?",
    why: "Security requirements affect auth architecture, data handling, and compliance obligations.",
    options: ["No auth needed", "Basic user auth", "Role-based access control", "Enterprise SSO / compliance"],
  },
  scope: {
    question: "What is explicitly in scope for this build, and what should be deferred or excluded?",
    why: "Scope boundaries stop the plan from either under-building the core ask or drifting into unrequested work (ADR-018).",
    options: ["Core flow only (MVP)", "Core flow plus the integrations explicitly named", "Full feature set as described, no deferrals"],
  },
  stack: {
    question: "Is there a specific language, framework, or technology stack this must use?",
    why: "A mandated stack changes every downstream task; an unstated one defaults to the project's existing conventions.",
    options: ["Use the project's existing stack/conventions", "A specific stack (name it when answering)", "No preference -- pick what fits best"],
  },
  priorities: {
    question: "If trade-offs are needed, what matters most: shipping speed, feature completeness, or reliability?",
    why: "Priority ordering determines what the plan sequences first when scope, time, and robustness compete.",
    options: ["Speed to a working first version", "Feature completeness", "Reliability / production-readiness", "No strong preference"],
  },
};

/**
 * Documented, per-category fallback assumption (ADR-019 non-interactive mode).
 * Used when a question fires (category uncovered or flagged ambiguous, see
 * `generateQuestions`) but nothing is running interactively to answer it: the
 * CLI records this value as an `Inferred`-confidence, `SystemInference`-source
 * assumption instead of silently discarding the question. Each value is the
 * safest, least-committal choice for that axis -- e.g. "no auth" over
 * "enterprise SSO", "core flow only" over "full feature set" (ADR-018
 * scope-drift guardrail) -- so a wrong guess costs the least if the vision
 * turns out to need something else. `priorities` defaults to reliability
 * because that is this project's own stated engineering priority (CLAUDE.md
 * "Safety & Stability"), not an arbitrary pick.
 *
 * Deliberately exhaustive over `DirectionCategory` (enforced by the `Record`
 * type -- adding a category without a default here is a compile error) so the
 * non-interactive path never has a question it cannot at least tentatively
 * resolve.
 */
export const DEFAULT_DIRECTION_ASSUMPTIONS: Record<DirectionCategory, string> = {
  platform: "Unspecified application",
  architecture: "Monolithic architecture",
  data_flow: "Request-response (synchronous)",
  scale: "Single user / personal tool",
  persistence: "No persistence assumed",
  deployment: "Cloud deployment",
  integration: "No external integrations",
  security: "Basic user authentication",
  scope: "Core flow only (MVP); defer anything not explicitly named",
  stack: "Use the project's existing stack/conventions",
  priorities: "Reliability / production-readiness",
};

/**
 * Test/stub double for `AlignmentLLM`. Deliberately conservative: it only
 * infers a couple of categories from a handful of keywords and never flags
 * anything ambiguous, so any category it doesn't recognize falls through to
 * a question (safe default for the CLI's explicit no-real-LLM test mode,
 * `ASHARA_TEST_STUB_LLM=1`). The genuine ambiguity-gate behavior (a
 * confident LLM commits to defaults and yields zero questions) is exercised
 * against a purpose-built fake in alignment.test.ts, not this stub.
 */
export class StubAlignmentLLM implements AlignmentLLM {
  readonly calls: string[] = [];

  async infer(prompt: string): Promise<AlignmentInferenceResponse> {
    this.calls.push(prompt);
    return {
      inferences: [
        { category: "platform" as DirectionCategory, inference: "web application", confidence: "high" as const },
        { category: "persistence" as DirectionCategory, inference: "relational database", confidence: "medium" as const },
        { category: "stack" as DirectionCategory, inference: "TypeScript", confidence: "medium" as const },
      ],
      ambiguousCategories: [],
    };
  }
}

function buildInferencePrompt(visionRaw: string, categories: readonly DirectionCategory[]): string {
  const lines = [
    `You are inferring unstated technical/product directions for a project vision.`,
    `Vision: ${JSON.stringify(visionRaw)}`,
    ``,
  ];

  if (categories.length === 0) {
    lines.push(
      `Every direction category is already explicitly stated in the vision text above.`,
      `Return {"inferences": [], "ambiguousCategories": []}.`,
    );
  } else {
    lines.push(
      `For EACH of the following direction categories, decide whether the vision gives enough`,
      `context to make a reasonable, defensible assumption:`,
      ``,
      ...categories.map((c) => `- ${c}: ${CATEGORY_QUESTIONS[c].question} (${CATEGORY_QUESTIONS[c].why})`),
      ``,
      `For each category above:`,
      `- If you CAN make a reasonable assumption (even a common-sense default), add it to`,
      `  "inferences" with "confidence": "medium" (clearly implied by context) or "low" (a`,
      `  plausible default, not stated).`,
      `- If the vision gives genuinely insufficient or contradictory signal such that guessing`,
      `  wrong would materially misdirect the plan, add the category name to`,
      `  "ambiguousCategories" INSTEAD of guessing.`,
      `- Do not put the same category in both lists.`,
      `- Only use category values from the exact list above -- never invent a new category and`,
      `  never explain your reasoning in prose.`,
    );
  }

  lines.push(
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"inferences": [{"category": "...", "inference": "...", "confidence": "medium"}], "ambiguousCategories": ["..."]}`,
  );

  return lines.join("\n");
}

export class AlignmentEngine {
  private readonly llm: AlignmentLLM;
  private readonly config: AlignmentConfig;

  constructor(llm: AlignmentLLM, config?: Partial<AlignmentConfig>) {
    this.llm = llm;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  async align(vision: VisionInput): Promise<AlignmentResult> {
    const fullText = vision.additionalContext
      ? `${vision.description} ${vision.additionalContext}`
      : vision.description;

    const parsed = this.parseVision(fullText);
    const { inferences, ambiguousCategories } = await this.inferDirections(parsed);
    const questions = this.generateQuestions(inferences, this.config, ambiguousCategories);
    const completeness = this.checkCompleteness(inferences, this.config);

    const visionSummary = this.buildSummary(inferences, parsed);

    return { inferences, questions, completeness, visionSummary };
  }

  parseVision(description: string): ParsedVision {
    return { raw: description };
  }

  async inferDirections(parsed: ParsedVision): Promise<DirectionInferenceResult> {
    let response: AlignmentInferenceResponse;
    try {
      response = await this.llm.infer(buildInferencePrompt(parsed.raw, ALL_DIRECTION_CATEGORIES));
    } catch (err) {
      throw new AlignmentInferenceError(
        "Alignment inference could not produce a valid structured response from the project vision",
        excerpt(parsed.raw),
        { cause: err },
      );
    }

    const inferences: DirectionInference[] = [];
    const seenCategories = new Set<DirectionCategory>();
    for (const llmInference of response.inferences) {
      if (seenCategories.has(llmInference.category)) continue;
      seenCategories.add(llmInference.category);
      inferences.push({
        category: llmInference.category,
        inference: llmInference.inference,
        confidence: llmInference.confidence,
        source: "inferred",
      });
    }

    return { inferences, ambiguousCategories: response.ambiguousCategories };
  }

  generateQuestions(
    inferences: DirectionInference[],
    config: AlignmentConfig,
    ambiguousCategories: readonly DirectionCategory[] = [],
  ): DirectionQuestion[] {
    const inferredCategories = new Set(inferences.map((i) => i.category));
    const ambiguousSet = new Set(ambiguousCategories);

    const questions: DirectionQuestion[] = [];

    for (const category of [...config.requiredCategories, ...config.optionalCategories]) {
      const uncovered = !inferredCategories.has(category);
      const flaggedAmbiguous = ambiguousSet.has(category);
      if (!uncovered && !flaggedAmbiguous) continue;

      const template = CATEGORY_QUESTIONS[category];
      questions.push({
        category,
        question: template.question,
        why: template.why,
        options: template.options,
      });
    }

    return questions;
  }

  checkCompleteness(
    inferences: DirectionInference[],
    config: AlignmentConfig,
  ): CompletenessCheck {
    const coveredSet = new Set(
      inferences
        .filter((i) => i.confidence === "high" || i.confidence === "medium")
        .map((i) => i.category),
    );

    const allCategories = [...config.requiredCategories, ...config.optionalCategories];
    const coveredCategories = allCategories.filter((c) => coveredSet.has(c));
    const missingCategories = allCategories.filter((c) => !coveredSet.has(c));

    const score = allCategories.length > 0 ? coveredCategories.length / allCategories.length : 0;

    const allRequiredCovered = config.requiredCategories.every((c) => coveredSet.has(c));
    const complete = allRequiredCovered && score >= config.minCompletenessScore;

    return {
      complete,
      coveredCategories: coveredCategories as DirectionCategory[],
      missingCategories: missingCategories as DirectionCategory[],
      score,
    };
  }

  private buildSummary(inferences: DirectionInference[], parsed: ParsedVision): string {
    if (inferences.length === 0) {
      return `The vision describes: "${parsed.raw}". No specific architectural directions were detected.`;
    }

    const parts: string[] = [];
    const items = inferences.map((i) => i.inference).join(", ");
    parts.push(`Based on the vision, the system likely involves: ${items}.`);

    if (inferences.length < 4) {
      parts.push("Several architectural directions still need clarification.");
    }

    return parts.join(" ");
  }
}
