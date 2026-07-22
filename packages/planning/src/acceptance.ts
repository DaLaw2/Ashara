import { z } from "zod";

import type { ProductObservation } from "@ashara/shared";
import type { ProjectContract, Endpoint } from "@ashara/shared";
import type { StructuredLLMProvider } from "./gateway-adapters.js";

export type AcceptanceOutcome = "accepted" | "rejected" | "accepted-with-caveats";

export interface AcceptanceGap {
  readonly ref: string;
  readonly kind: "boot-failure" | "unreachable" | "not-mounted" | "server-error" | "missing-feature";
  readonly expected: string;
  readonly observed: string;
  readonly lesson?: string;
  readonly suggestedApproach?: string;
  readonly supersedes?: string;
}

export interface AcceptanceVerdict {
  readonly outcome: AcceptanceOutcome;
  readonly gaps: readonly AcceptanceGap[];
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface WorkItemSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly failureDetail?: string;
}

export const VisionGapResultSchema = z.object({
  gaps: z.array(z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    visionEvidence: z.string().min(1),
    lesson: z.string().optional(),
    suggestedApproach: z.string().optional(),
    supersedes: z.string().optional(),
  })).default([]),
  reasoning: z.string(),
});
export type VisionGapResult = z.infer<typeof VisionGapResultSchema>;

export interface AcceptanceLLM {
  checkVisionGaps(input: {
    visionText: string;
    items: readonly WorkItemSummary[];
  }): Promise<VisionGapResult>;
}

export function createGatewayAcceptanceLLM(provider: StructuredLLMProvider): AcceptanceLLM {
  return {
    async checkVisionGaps(input) {
      const itemsSummary = input.items
        .map((i) => `- [${i.status}] ${i.title} (${i.id})`)
        .join("\n");

      const abandonedItems = input.items.filter((i) => i.status === "Abandoned");
      const abandonedSection = abandonedItems.length > 0
        ? abandonedItems.map((i) => {
            const detail = i.failureDetail ? ` (failure: ${i.failureDetail})` : "";
            return `- ${i.title} (${i.id})${detail}`;
          }).join("\n")
        : "(none)";

      const prompt = [
        "You are a product acceptance reviewer. Compare the vision text against the completed work items.",
        "Identify features EXPLICITLY stated in the vision that have NOT been addressed by any Completed work item.",
        "",
        "VISION TEXT:",
        input.visionText,
        "",
        "WORK ITEMS:",
        itemsSummary,
        "",
        "ABANDONED ITEMS (tried and failed):",
        abandonedSection,
        "",
        "For each gap, provide:",
        "- title: a short name for the missing feature",
        "- description: what needs to be built",
        "- visionEvidence: the EXACT quoted phrase from the vision text that proves this feature is required",
        "- lesson: (optional) what was learned from prior failed attempts at this feature",
        "- suggestedApproach: (optional) a DIFFERENT approach that avoids the prior failure",
        "- supersedes: (optional) the ID of an abandoned item this gap replaces",
        "",
        "When a gap corresponds to an abandoned item, include the abandoned item's ID in 'supersedes'",
        "and propose a different approach in 'suggestedApproach' that avoids the failure mode.",
        "",
        "Only report genuine gaps. If all vision requirements are covered, return an empty gaps array.",
      ].join("\n");

      const result = await provider.generateStructured({
        capability: "Strong",
        prompt,
        schema: VisionGapResultSchema,
        maxTokens: 2048,
        temperature: 0,
      });
      return result.data;
    },
  };
}

export function buildDeterministicGaps(
  observation: ProductObservation,
  contract: ProjectContract | null,
): AcceptanceGap[] {
  const gaps: AcceptanceGap[] = [];

  if (!observation.booted) {
    gaps.push({
      ref: "boot",
      kind: "boot-failure",
      expected: "process boots and responds to HTTP",
      observed: observation.bootOutput.slice(0, 300),
    });
    return gaps;
  }

  if (contract === null) return gaps;

  const probeByKey = new Map(
    observation.endpoints.map((p) => [`${p.method} ${p.path}`, p]),
  );

  for (const ep of contract.endpoints) {
    if (ep.outOfScope) continue;
    const probe = probeByKey.get(`${ep.method} ${ep.path}`);
    if (probe === undefined) continue;

    if (probe.status === null) {
      gaps.push({
        ref: ep.ref,
        kind: "unreachable",
        expected: `${ep.method} ${ep.path} responds`,
        observed: probe.detail,
      });
    } else if (probe.status === 404) {
      gaps.push({
        ref: ep.ref,
        kind: "not-mounted",
        expected: `${ep.method} ${ep.path} is mounted`,
        observed: `HTTP 404`,
      });
    } else if (probe.status >= 500) {
      gaps.push({
        ref: ep.ref,
        kind: "server-error",
        expected: `${ep.method} ${ep.path} responds without server error`,
        observed: `HTTP ${probe.status}`,
      });
    }
  }

  return gaps;
}

export function buildVisionGaps(
  visionGapResult: VisionGapResult,
  visionText: string,
): AcceptanceGap[] {
  return visionGapResult.gaps
    .filter((g) => visionText.includes(g.visionEvidence))
    .map((g) => ({
      ref: g.title.toLowerCase().replace(/\s+/g, "-").slice(0, 60),
      kind: "missing-feature" as const,
      expected: g.description,
      observed: `not addressed (vision: "${g.visionEvidence}")`,
      lesson: g.lesson,
      suggestedApproach: g.suggestedApproach,
      supersedes: g.supersedes,
    }));
}

export function buildAcceptanceVerdict(
  gaps: readonly AcceptanceGap[],
  attempt: number,
  maxAttempts: number,
): AcceptanceVerdict {
  const outcome: AcceptanceOutcome =
    gaps.length === 0
      ? "accepted"
      : attempt >= maxAttempts
        ? "accepted-with-caveats"
        : "rejected";

  return { outcome, gaps, attempt, maxAttempts };
}
