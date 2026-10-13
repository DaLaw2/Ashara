import type { ZodType } from "zod";
import { withStructuredLadder } from "@ashara/llm-gateway";
import type { LadderAttemptEvent, StructuredProvider, StructuredValidation } from "@ashara/llm-gateway";
import type { DecompositionLLM } from "./decomposition.js";

type ZodSchema<T> = ZodType<T>;

/**
 * Re-ask suffix for decomposition retries (mig-run10). The `errors` are the
 * schema issues or the decomposer's own UnresolvableDependencyError and
 * TaskCapExceededError messages, so the model is told exactly what to fix.
 * A dependency it drops on this instruction is not lost silently: the decomposer
 * records it on `DecompositionResult.droppedDependencies`.
 */
function decompositionReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. In "dependsOn" use ONLY the "ref" values of other tasks in THIS response; ` +
    `drop any dependency you cannot express that way.`
  );
}

/**
 * Decomposition LLM wired through its OWN reliability ladder (mig-run10, ADR-030):
 * two validated attempts per tier, escalate one capability tier,
 * then `StructuredOutputExhausted`. It runs a SEMANTIC
 * `validate` (phantom `dependsOn` ref detection) inside each attempt and re-asks
 * with the failure feedback, so one malformed emission is corrected on retry
 * instead of exploding the run. Distinct `site` so its exhaustion is attributable.
 */
export function createGatewayDecompositionLLM(
  gateway: StructuredProvider,
  onAttempt?: (event: LadderAttemptEvent) => void,
): DecompositionLLM {
  const laddered = withStructuredLadder(gateway, {
    site: "decomposition",
    attempts: 2,
    reask: decompositionReask,
    onAttempt,
  });
  return {
    async generateStructured<T>(
      prompt: string,
      schema: ZodSchema<T>,
      validate?: (value: T) => StructuredValidation,
    ): Promise<T> {
      const response = await laddered.generateStructured({
        capability: "Strong",
        prompt,
        schema,
        validate,
        maxTokens: 4096,
      });
      return response.data;
    },
  };
}
