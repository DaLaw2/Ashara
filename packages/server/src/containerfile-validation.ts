/**
 * Content validation for LLM-derived Containerfile directives.
 *
 * Runs BEFORE generateContainerfile() interpolates values into Containerfile
 * directives. The Zod schema in provisioner.ts validates shape (non-empty
 * string); this module validates safety — rejecting shell injection patterns
 * that could escape a RUN/ENV/FROM directive.
 *
 * Injection patterns mirror those in command-policy.ts (agent-runner) but are
 * adapted for the Containerfile context: no allowlist/blocklist of binaries
 * (Target Generality — the provisioner does not know which package manager the
 * base image uses), only structural injection detection.
 */

import type { EnvironmentSpec } from "@ashara/development";

// ---------------------------------------------------------------------------
// Typed error (Discipline C: self-diagnosing, structured context)
// ---------------------------------------------------------------------------

export interface ContainerfileValidationContext {
  readonly field: string;
  readonly value: string;
  readonly rule: string;
  readonly detail: string;
}

export class ContainerfileValidationError extends Error {
  constructor(public readonly context: ContainerfileValidationContext) {
    super(
      `containerfile validation failed for ${context.field}: ${context.detail}`,
    );
    this.name = "ContainerfileValidationError";
  }
}

// ---------------------------------------------------------------------------
// Injection patterns (reused from command-policy.ts)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
  { pattern: /`[^`]*`/, rule: "backtick-substitution" },
  { pattern: /\$\(\(/, rule: "arithmetic-expansion" },
  { pattern: /\$\(/, rule: "command-substitution" },
  { pattern: /\$\{[^}]*[!@#%^:=+\-?/]/, rule: "parameter-expansion-operator" },
  { pattern: /\bIFS\s*=/, rule: "ifs-manipulation" },
  { pattern: /<\(/, rule: "process-substitution-in" },
  { pattern: />\(/, rule: "process-substitution-out" },
  { pattern: /\w+\s*\(\)\s*\{/, rule: "function-definition" },
];

// ---------------------------------------------------------------------------
// Per-field validators
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters that must never appear in a base image reference.
 * A valid image reference is [registry/]name[:tag][@digest] — none of these
 * characters are legal in any segment.
 */
const BASE_IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

function validateBaseImage(value: string): ContainerfileValidationContext | null {
  if (!BASE_IMAGE_PATTERN.test(value)) {
    return {
      field: "baseImage",
      value,
      rule: "base-image-format",
      detail: "base image must match [registry/]name[:tag][@digest] — no shell metacharacters",
    };
  }
  const injection = checkInjection(value);
  if (injection) {
    return { field: "baseImage", value, ...injection };
  }
  return null;
}

/**
 * Validate a shell command destined for a RUN directive.
 *
 * Allows compound commands (&&) which are normal in package install lines
 * (e.g. "apt-get update && apt-get install -y gcc"). Rejects injection
 * patterns that would let the LLM escape the intended directive.
 */
function validateRunDirective(
  field: string,
  value: string,
): ContainerfileValidationContext | null {
  const injection = checkInjection(value);
  if (injection) {
    return { field, value, ...injection };
  }
  return null;
}

/**
 * ENV key: only alphanumerics and underscores.
 */
const ENV_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Shell metacharacters forbidden in ENV values. These would let an LLM
 * inject commands via ENV value expansion in subsequent RUN directives.
 */
const ENV_VALUE_UNSAFE = /[;|&`$(){}]/;

function validateEnvVar(
  key: string,
  value: string,
): ContainerfileValidationContext | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return {
      field: `envVars.${key}`,
      value: key,
      rule: "env-key-format",
      detail: "environment variable name must match [A-Z_][A-Z0-9_]*",
    };
  }
  if (ENV_VALUE_UNSAFE.test(value)) {
    return {
      field: `envVars.${key}`,
      value,
      rule: "env-value-metachar",
      detail: "environment variable value contains shell metacharacters",
    };
  }
  return null;
}

/**
 * projectMount: must be an absolute path with no shell metacharacters.
 */
const MOUNT_PATH_PATTERN = /^\/[a-zA-Z0-9._\-/]*$/;

function validateProjectMount(value: string): ContainerfileValidationContext | null {
  if (!MOUNT_PATH_PATTERN.test(value)) {
    return {
      field: "projectMount",
      value,
      rule: "mount-path-format",
      detail: "projectMount must be an absolute path with no shell metacharacters",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared injection check
// ---------------------------------------------------------------------------

function checkInjection(
  value: string,
): { rule: string; detail: string } | null {
  for (const { pattern, rule } of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      return {
        rule: `injection:${rule}`,
        detail: `shell injection pattern detected: ${rule}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all LLM-derived fields in an EnvironmentSpec before they are
 * interpolated into Containerfile directives. Throws on the first violation
 * (fail-closed, Discipline A).
 */
export function validateContainerfileSpec(spec: EnvironmentSpec): void {
  const baseImageResult = validateBaseImage(spec.baseImage);
  if (baseImageResult) throw new ContainerfileValidationError(baseImageResult);

  for (const cmd of spec.systemPackages) {
    const result = validateRunDirective("systemPackages", cmd);
    if (result) throw new ContainerfileValidationError(result);
  }

  for (const tc of spec.toolchains) {
    if (tc.installMethod) {
      const result = validateRunDirective(
        `toolchains[${tc.name}].installMethod`,
        tc.installMethod,
      );
      if (result) throw new ContainerfileValidationError(result);
    }
  }

  for (const [key, value] of Object.entries(spec.envVars)) {
    const result = validateEnvVar(key, value);
    if (result) throw new ContainerfileValidationError(result);
  }

  const mountResult = validateProjectMount(spec.projectMount);
  if (mountResult) throw new ContainerfileValidationError(mountResult);
}
