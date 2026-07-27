import { z } from "zod";
import type { StructuredLLMProvider } from "./gateway-adapters.js";

export const ReplanProposalSchema = z.object({
  replacesId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  goal: z.string().min(1),
  approach: z.string().min(1),
  differentiator: z.string().min(1),
  deliverables: z.array(z.string()).default([]),
});
export type ReplanProposal = z.infer<typeof ReplanProposalSchema>;

export const ReplanResultSchema = z.object({
  proposals: z.array(ReplanProposalSchema),
  noAlternativeIds: z.array(z.string()).default([]),
  reasoning: z.string(),
});
export type ReplanResult = z.infer<typeof ReplanResultSchema>;

export interface AbandonedItemContext {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly deliverables?: readonly string[];
  readonly attempts?: number;
  readonly failureDetail?: string;
  readonly priorLessons: readonly string[];
}

export interface ReplanInput {
  readonly visionText: string;
  readonly completedItems: readonly { id: string; title: string }[];
  readonly abandonedItems: readonly AbandonedItemContext[];
  readonly blockedItems: readonly { id: string; title: string }[];
  readonly globalLessons: readonly string[];
}

export interface ReplanLLM {
  replanFromVision(input: ReplanInput): Promise<ReplanResult>;
}

function formatAbandonedItem(item: AbandonedItemContext): string {
  const lines = [`- ID: ${item.id}`, `  Title: ${item.title}`];
  if (item.goal) lines.push(`  Goal: ${item.goal}`);
  if (item.deliverables && item.deliverables.length > 0) {
    lines.push(`  Deliverables: ${item.deliverables.join(", ")}`);
  }
  if (item.attempts !== undefined) lines.push(`  Attempts: ${item.attempts}`);
  if (item.failureDetail) lines.push(`  Last failure: ${item.failureDetail}`);
  if (item.priorLessons.length > 0) {
    lines.push(`  Lessons learned:`);
    for (const lesson of item.priorLessons) {
      lines.push(`    - ${lesson}`);
    }
  }
  return lines.join("\n");
}

export function createGatewayReplanLLM(provider: StructuredLLMProvider): ReplanLLM {
  return {
    async replanFromVision(input) {
      const completedSection =
        input.completedItems.length > 0
          ? input.completedItems.map((i) => `- [Completed] ${i.title} (${i.id})`).join("\n")
          : "(none)";

      const abandonedSection =
        input.abandonedItems.length > 0
          ? input.abandonedItems.map(formatAbandonedItem).join("\n\n")
          : "(none)";

      const blockedSection =
        input.blockedItems.length > 0
          ? input.blockedItems.map((i) => `- [Blocked] ${i.title} (${i.id})`).join("\n")
          : "(none)";

      const lessonsSection =
        input.globalLessons.length > 0
          ? input.globalLessons.map((l) => `- ${l}`).join("\n")
          : "(none)";

      const prompt = [
        "You are a technical replanning advisor. The development plan has stalled because abandoned tasks block remaining work.",
        "Your job: propose ALTERNATIVE approaches for abandoned tasks so development can resume.",
        "",
        "CRITICAL RULES:",
        "- Do NOT retry the same approach that already failed.",
        "- Each proposal MUST take a genuinely DIFFERENT approach (different architecture, different algorithm, different technology, different scope).",
        "- The differentiator field must explain concretely what makes this approach different from prior attempts.",
        "- If a task is truly unsolvable with any alternative approach, include its ID in noAlternativeIds instead.",
        "- Only propose replacements for abandoned tasks listed below.",
        "",
        "VISION TEXT:",
        input.visionText,
        "",
        "COMPLETED ITEMS (already delivered):",
        completedSection,
        "",
        "ABANDONED ITEMS (need alternative approaches):",
        abandonedSection,
        "",
        "BLOCKED ITEMS (waiting on abandoned items above):",
        blockedSection,
        "",
        "ACCUMULATED LESSONS:",
        lessonsSection,
        "",
        "For each abandoned item where an alternative approach exists, propose a replacement with:",
        "- replacesId: the ID of the abandoned item this replaces",
        "- title: concise name for the new task",
        "- description: what this task will build",
        "- goal: the product goal this serves (from the vision)",
        "- approach: the specific technical approach to take",
        "- differentiator: what makes this approach DIFFERENT from what was tried before (must be substantive, >20 chars)",
        "- deliverables: list of concrete outputs",
        "",
        "For abandoned items with no viable alternative, include their IDs in noAlternativeIds.",
      ].join("\n");

      const result = await provider.generateStructured({
        capability: "Strong",
        prompt,
        schema: ReplanResultSchema,
        maxTokens: 4096,
        temperature: 0,
      });
      return result.data;
    },
  };
}
