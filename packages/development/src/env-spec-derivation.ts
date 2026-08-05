/**
 * LLM-based EnvironmentSpec derivation (ADR-071 decision 2).
 *
 * Replaces the six hardcoded stack tables deleted in cycle 130: the LLM reads
 * manifest content (from readManifestContext) and derives toolchains, system
 * packages, and build requirements. A project whose stack the system has never
 * seen works with zero code changes — the prompt contains ZERO hardcoded
 * toolchain names.
 *
 * Temperature 0 (Discipline A: deterministic operations).
 * Fail-closed: invalid LLM output throws via the structured provider's
 * schema validation — never returns a default or empty spec.
 */

import { z } from "zod";
import type { StructuredProvider, StructuredValidation } from "@ashara/llm-gateway";
import type { EnvironmentSpec } from "./provisioner.js";

// ---------------------------------------------------------------------------
// LLM output schema — a simplified representation the LLM fills.
// Mapped to the canonical EnvironmentSpec (provisioner.ts) before returning.
// ---------------------------------------------------------------------------

const LlmToolchainSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

const LlmEnvironmentSpecSchema = z.object({
  baseImage: z.string().min(1),
  toolchains: z.array(LlmToolchainSchema),
  systemPackages: z.array(z.string().min(1)),
  envVars: z.record(z.string(), z.string()),
  networkPolicy: z.enum(["provision", "build", "test", "run"]).array(),
  projectMount: z.string().min(1),
});

type LlmEnvironmentSpec = z.infer<typeof LlmEnvironmentSpecSchema>;

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

function validateToolchainsPresent(value: LlmEnvironmentSpec): StructuredValidation {
  if (value.toolchains.length === 0) {
    return {
      ok: false,
      errors: [
        "toolchains array is empty — the manifest content implies at least one language or build tool",
      ],
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Map LLM output → canonical EnvironmentSpec
// ---------------------------------------------------------------------------

function toCanonicalSpec(raw: LlmEnvironmentSpec): EnvironmentSpec {
  const networkPolicy: Record<string, boolean> = {};
  for (const phase of ["provision", "build", "test", "run"] as const) {
    networkPolicy[phase] = raw.networkPolicy.includes(phase);
  }

  return {
    baseImage: raw.baseImage,
    toolchains: raw.toolchains,
    systemPackages: raw.systemPackages,
    envVars: raw.envVars,
    networkPolicy,
    projectMount: raw.projectMount,
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive an EnvironmentSpec from project manifest content using an LLM.
 *
 * The caller provides manifest content gathered by `readManifestContext`
 * (dispatch-utils.ts) and a StructuredProvider — typically wrapped with
 * `withStructuredLadder` for retry + escalation on schema failures.
 *
 * Called after the scaffold task produces the project's manifest files;
 * the caller lives in the orchestrator or execution-service.
 */
export async function deriveEnvironmentSpec(
  manifestContent: string,
  llm: StructuredProvider,
): Promise<EnvironmentSpec> {
  const response = await llm.generateStructured({
    capability: "Strong",
    prompt: buildDerivationPrompt(manifestContent),
    schema: LlmEnvironmentSpecSchema,
    maxTokens: 1024,
    temperature: 0,
    validate: validateToolchainsPresent,
  });
  return toCanonicalSpec(response.data);
}

// ---------------------------------------------------------------------------
// Prompt construction (toolchain-name-free)
// ---------------------------------------------------------------------------

function buildDerivationPrompt(manifestContent: string): string {
  return [
    "Analyze the following project manifest files and determine the complete",
    "environment specification required to build and run this project.",
    "",
    "Manifest content:",
    manifestContent,
    "",
    "Based ENTIRELY on the manifest content above, determine:",
    "",
    "1. baseImage: a minimal container base image suitable for this project's",
    "   toolchain requirements. Choose a general-purpose Linux distribution tag",
    "   appropriate for the languages and tools the manifests declare.",
    "",
    "2. toolchains: every language runtime, compiler, and package manager the",
    "   project requires, each as an object with 'name' (required) and 'version'",
    "   (optional — include only if the manifests specify a version constraint).",
    "   Derive these ENTIRELY from the manifest content.",
    "",
    "3. systemPackages: OS-level packages beyond the base image that the",
    "   project's build or runtime dependencies require (e.g. native libraries,",
    "   development headers). Return an empty array if none are evident.",
    "",
    "4. envVars: environment variables the manifests indicate are needed at",
    "   build or provision time (not runtime secrets). Return an empty object",
    "   if none are evident.",
    "",
    '5. networkPolicy: list the phases that require network access. Valid phases',
    '   are "provision", "build", "test", "run". For example, if the project',
    "   fetches dependencies during provisioning and build, return",
    '   ["provision", "build"]. Return an empty array if fully offline.',
    "",
    "6. projectMount: the conventional working directory path inside the",
    '   container. Use "/workspace" unless the manifests indicate otherwise.',
    "",
    "IMPORTANT: Respond with ONLY valid JSON. No markdown, no code fences,",
    "no commentary.",
  ].join("\n");
}
