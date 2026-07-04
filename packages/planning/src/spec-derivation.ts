import { z } from "zod";

import { HttpMethodSchema, normalizePath } from "@ashara/shared";
import type { Endpoint } from "@ashara/shared";

import type { StructuredLLMProvider } from "./gateway-adapters.js";
import { deriveEndpointRef } from "./contract-derivation.js";

/**
 * Spec-derived endpoint declaration (ADR-032 §2, mig9-t1). An INDEPENDENT
 * derivation pass: it reads the PROJECT VISION text directly and enumerates the
 * HTTP endpoints the product must expose, with NO sight of the decomposition
 * task list. This is the auditor half of the author/auditor split — the same
 * LLM pass that omits an endpoint from the plan (Run 9's "User Registration"
 * story that produced a schema task and a page task but never a
 * POST /api/register task) also omits it from a self-authored contract, so the
 * missing endpoint can only be recovered by a pass that never saw the plan.
 *
 * Fail-closed (Discipline A): the derivation runs through the shared reliability
 * ladder (temperature 0, validated attempts, one capability escalation) and, on
 * exhaustion, raises a typed `SpecDerivationError` that BLOCKS the planning step
 * — it never silently returns an empty endpoint set. A structurally-valid but
 * empty enumeration is a legitimate result (an endpoint-less CLI/library vision)
 * and is returned as an empty list, not an error.
 */

const RAW_EXCERPT_LENGTH = 400;

const DerivedEndpointSchema = z
  .object({
    method: HttpMethodSchema,
    path: z.string().min(1),
    purpose: z.string().min(1),
  })
  .strict();

/**
 * The enumeration the derivation pass returns. `capabilities` is optional
 * free-text the model may use to reason about non-endpoint product requirements;
 * only `endpoints` feed the contract in this phase (the contract has no
 * capability registry and `checks` has no consumer yet — ADR-031: no speculative
 * persistence).
 */
export const SpecDerivationSchema = z
  .object({
    endpoints: z.array(DerivedEndpointSchema),
    capabilities: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SpecDerivation = z.infer<typeof SpecDerivationSchema>;

/**
 * The vision text the derivation reads. Deliberately NOT the task list: only the
 * project's top-level intent (its own title/description/north-star) so the pass
 * is independent of what decomposition planned.
 */
export interface SpecVisionInput {
  readonly title: string;
  readonly description: string;
  readonly northStar?: string;
}

/**
 * Typed terminal failure of the derivation pass (Discipline C). Carries the
 * vision excerpt it was working from and preserves the underlying cause
 * (normally a `StructuredOutputExhausted` from the ladder) WITHOUT lossy
 * conversion, so the failure is self-diagnosing from the message and `cause`.
 */
export class SpecDerivationError extends Error {
  readonly visionExcerpt: string;

  constructor(message: string, visionExcerpt: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpecDerivationError";
    this.visionExcerpt = visionExcerpt;
  }
}

/**
 * The derivation LLM seam. Mirrors the gateway-adapters pattern: the composition
 * root wraps the gateway in the reliability ladder ONCE and hands the wrapped
 * provider here, so exhaustion surfaces as a typed error rather than a drifted
 * enum silently accepted.
 */
export interface SpecDerivationLLM {
  deriveEndpoints(prompt: string): Promise<SpecDerivation>;
}

/** Binds the derivation call to a ladder-wrapped structured provider. */
export function createGatewaySpecDerivationLLM(provider: StructuredLLMProvider): SpecDerivationLLM {
  return {
    async deriveEndpoints(prompt: string): Promise<SpecDerivation> {
      const response = await provider.generateStructured({
        capability: "Strong",
        prompt,
        schema: SpecDerivationSchema,
        maxTokens: 2048,
        temperature: 0,
      });
      return response.data;
    },
  };
}

function excerpt(text: string): string {
  return text.length <= RAW_EXCERPT_LENGTH ? text : text.slice(0, RAW_EXCERPT_LENGTH);
}

export function buildSpecDerivationPrompt(vision: SpecVisionInput): string {
  const lines = [
    `You are enumerating the COMPLETE set of public interfaces this system must expose to`,
    `deliver the product described below. For HTTP services, list API endpoints (method + path).`,
    `For CLI tools, list subcommands. For libraries, list public exports. If the product has no`,
    `public surface (pure internal tool), return an empty array. Work ONLY from this product`,
    `vision — do NOT assume any implementation plan, task list, or existing code exists.`,
    `Your job is to independently name every interface the product REQUIRES, including ones`,
    `the vision only implies.`,
    ``,
    `Enumerate every interface implied by the product, e.g.:`,
    `- authentication flows imply their own endpoints (registration, login, logout, session/token),`,
    `- every user-managed resource implies its full CRUD set (list, create, read, update, delete),`,
    `- CLI tools imply their subcommands (init, build, run, test),`,
    `- do not omit an interface merely because the vision does not spell out its verb or path.`,
    ``,
    `Product Vision`,
    `Title: ${vision.title}`,
    `Description: ${vision.description}`,
  ];
  if (vision.northStar && vision.northStar.trim().length > 0) {
    lines.push(`North Star: ${vision.northStar}`);
  }
  lines.push(
    ``,
    `For each endpoint give its HTTP method, its path (e.g. "/api/register"), and a one-line purpose.`,
    `If the product is a CLI or library with no HTTP surface, return an empty endpoints array.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"endpoints": [{"method": "POST", "path": "/api/register", "purpose": "..."}], "capabilities": ["..."]}`,
  );
  return lines.join("\n");
}

/**
 * Maps the raw enumeration onto contract endpoints: assigns each a stable `ref`
 * via `deriveEndpointRef` (the SAME structural resource+action slug the
 * decomposition path uses, so a spec-derived endpoint and a later explicit
 * declaration of the same logical endpoint collapse onto one ref instead of
 * duplicating), dedups within the batch by ref, and stamps the honest
 * `spec-derivation` provenance.
 */
function toContractEndpoints(derivation: SpecDerivation): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const seenRefs = new Set<string>();
  for (const e of derivation.endpoints) {
    const ref = deriveEndpointRef(e.method, e.path);
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    endpoints.push({
      ref,
      method: e.method,
      path: normalizePath(e.path),
      purpose: e.purpose,
      source: "spec-derivation",
    });
  }
  return endpoints;
}

/**
 * DISABLED (granularity-debate.md §5, File 5). With the coarse vertical-slice
 * decomposition strategy, every endpoint is declared once, at decomposition
 * time, by the task that owns it (contract-derivation.ts). An independent
 * re-derivation from the vision text adds no signal over that and reproduces
 * Run 11's #1 finding — a dual-namespace schism where the two independently
 * derived endpoint sets for the same feature disagree on path (e.g.
 * `/api/login` vs `/api/auth/login`).
 *
 * Always resolves to an empty endpoint set without invoking the LLM, so
 * `deriveProjectContractFromVision` (story-decomposer.ts) hits its
 * `endpoints.length === 0` short-circuit and neither seeds nor amends the
 * contract. Left callable (not deleted, not removed from its call site) so
 * `SpecDerivationLLM` and the composition-root wiring that constructs it stay
 * unchanged; only this function's behavior changes.
 */
export async function deriveSpecEndpoints(
  _llm: SpecDerivationLLM,
  _vision: SpecVisionInput,
): Promise<Endpoint[]> {
  return [];
}
