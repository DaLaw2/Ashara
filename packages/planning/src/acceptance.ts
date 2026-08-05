import { z } from "zod";
import type { ProductObservation } from "@ashara/shared";
import type { ProjectContract, Endpoint } from "@ashara/shared";
import type { StructuredLLMProvider } from "./gateway-adapters.js";

/**
 * `unverified` means the acceptance check did not confirm the vision — it threw,
 * the inputs it needs were absent, it had no attempt left to spend, or part of it
 * could not run. It is deliberately NOT collapsed onto `accepted-with-caveats`:
 * absence of a verdict is not a passing verdict (Discipline A).
 */
export type AcceptanceOutcome = "accepted" | "rejected" | "accepted-with-caveats" | "unverified";

/**
 * Why an acceptance check could not confirm the vision.
 *
 *  - `no-checker-configured` — neither tier is wired into the loop.
 *  - `no-vision`             — nothing states what the product was supposed to be.
 *  - `check-threw`           — the check ran and raised.
 *  - `attempts-exhausted`    — the attempt cap was already spent, so THIS termination
 *    was never checked. Distinct from `check-threw` because nothing failed: the run
 *    simply had no budget left to look, which is its own epistemic state and must
 *    never borrow another cause's meaning.
 *  - `check-incomplete`      — the check ran and found nothing wrong, but part of it
 *    could not execute, so "found nothing" is ignorance rather than evidence.
 */
export type AcceptanceUnverifiedCause =
  | "no-checker-configured"
  | "no-vision"
  | "check-threw"
  | "attempts-exhausted"
  | "check-incomplete";

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
  /** Set only when `outcome` is "unverified": self-sufficient reason the check could not run. */
  readonly unverifiedReason?: string;
}

/**
 * What the deterministic tier found AND what it could not look at. The second half
 * is the point: a tier that returns only gaps reports "I checked nothing" and "I
 * found nothing wrong" with the same value — the empty array — and every caller
 * reads that as the product being fine. `unchecked` makes the difference
 * unavoidable, and a non-empty `unchecked` forbids an `accepted` verdict.
 */
export interface DeterministicAssessment {
  readonly gaps: readonly AcceptanceGap[];
  /** Self-sufficient statements of what could not be checked, and why. */
  readonly unchecked: readonly string[];
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
  reasoning: z.string().default(""),
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

/**
 * What this project has to do for the boot check to pass, phrased in terms it
 * can actually satisfy.
 *
 * The expectation becomes the gap task's title verbatim
 * (`orchestrator/src/termination-snapshot.ts`), so a fixed string is a fixed
 * demand: Run 39 opened "process boots and responds to HTTP" against a
 * note-taking CLI, which no amount of work could ever close. HTTP is asserted
 * only when the contract DECLARES an HTTP surface to serve; otherwise the
 * expectation is the one every project shares — that starting it does not fail.
 */
function bootExpectation(declaredEndpoints: readonly Endpoint[]): string {
  return declaredEndpoints.length > 0
    ? `the project starts and serves the ${declaredEndpoints.length} endpoint(s) its contract declares`
    : "the project starts and runs without failing";
}

/**
 * The deterministic tier: read one product observation against the contract and
 * separate what it PROVES from what it never got to look at.
 *
 * Three absences used to return an empty gap list and be read as a clean bill of
 * health — a missing contract, an endpoint that was declared but never probed, and
 * an observation that could not be taken at all. All three are now `unchecked`.
 */
export function assessProductObservation(
  observation: ProductObservation,
  contract: ProjectContract | null,
): DeterministicAssessment {
  const gaps: AcceptanceGap[] = [];
  const unchecked: string[] = [];

  // A missing contract means nothing DECLARED what this product must do, so this
  // tier had no standard to check against — not that the product met one.
  if (contract === null) {
    unchecked.push(
      "no ProjectContract exists for this project, so nothing declares what the product must do and the deterministic tier had no standard to check it against",
    );
  }

  // The HTTP surface the project itself declared. Empty for a CLI, a library, a
  // kernel module — and for any project whose contract simply has no endpoints yet.
  const declaredEndpoints = contract === null ? [] : contract.endpoints.filter((ep) => !ep.outOfScope);

  if (observation.kind === "not-observable") {
    unchecked.push(
      `the product could not be observed (${observation.cause}): ${observation.detail}`,
    );
    return { gaps, unchecked };
  }

  if (observation.kind === "boot-failed") {
    gaps.push({
      ref: "boot",
      kind: "boot-failure",
      expected: bootExpectation(declaredEndpoints),
      observed: observation.detail.slice(0, 300),
    });
    return { gaps, unchecked };
  }

  const probeByKey = new Map(
    observation.endpoints.map((p) => [`${p.method} ${p.path}`, p]),
  );

  for (const ep of declaredEndpoints) {
    const probe = probeByKey.get(`${ep.method} ${ep.path}`);
    if (probe === undefined) {
      // ADR-042 deleted static reachability on the argument that a declared endpoint
      // answering 404 is stronger evidence. That holds only for an endpoint that was
      // ACTUALLY probed; an unprobed one carries no evidence in either direction.
      unchecked.push(
        `declared endpoint ${ep.method} ${ep.path} (ref "${ep.ref}") was never probed by the observation, so its health is unknown`,
      );
      continue;
    }

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

  return { gaps, unchecked };
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

/**
 * The verdict for a check that actually RAN. `unchecked` is required, not optional:
 * a caller cannot reach `accepted` without explicitly asserting, at the call site,
 * that nothing was left unlooked-at. `accepted` is the only outcome that claims the
 * vision was confirmed, so it is the only one that demands a complete check.
 */
export function buildAcceptanceVerdict(
  gaps: readonly AcceptanceGap[],
  unchecked: readonly string[],
  attempt: number,
  maxAttempts: number,
): AcceptanceVerdict {
  if (gaps.length > 0) {
    const outcome: AcceptanceOutcome = attempt >= maxAttempts ? "accepted-with-caveats" : "rejected";
    return { outcome, gaps, attempt, maxAttempts };
  }

  if (unchecked.length > 0) {
    return buildUnverifiedVerdict({
      cause: "check-incomplete",
      detail: unchecked.join("; "),
      attempt,
      maxAttempts,
      priorGaps: [],
    });
  }

  return { outcome: "accepted", gaps, attempt, maxAttempts };
}

export interface UnverifiedVerdictInput {
  readonly cause: AcceptanceUnverifiedCause;
  /**
   * The raw cause — a thrown value or a sentence. Accepted as `unknown` so a full
   * error chain survives into the reason; collapsing it to `String(error)` would
   * drop everything below the outermost error (Discipline C).
   */
  readonly detail: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  /**
   * Gaps a PREVIOUS completed check left open, carried forward so a termination
   * that cannot re-check still reports the last thing known to be wrong instead of
   * reporting nothing. Never evidence that this check ran — the outcome stays
   * `unverified` whatever this holds.
   */
  readonly priorGaps: readonly AcceptanceGap[];
}

/** The verdict for a check that did not confirm the vision. */
export function buildUnverifiedVerdict(input: UnverifiedVerdictInput): AcceptanceVerdict {
  return {
    outcome: "unverified",
    gaps: input.priorGaps,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    unverifiedReason: `${input.cause}: ${describeCauseChain(input.detail)}`,
  };
}

function describeCauseChain(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }

  if (parts.length === 0) return describeValue(value);
  if (current !== undefined && current !== null) parts.push(describeValue(current));
  return parts.join(" <- caused by ");
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
