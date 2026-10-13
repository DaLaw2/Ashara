/**
 * Anti-Corruption Layer: Development (ADR-044).
 *
 * This is the ONLY file in @ashara/orchestrator that imports from @ashara/development.
 * All orchestrator source files import development types and functions through this
 * module, keeping the boundary explicit and the coupling surface auditable.
 *
 * TODO(ADR-044): These are raw pass-throughs. A future phase will introduce
 * orchestrator-local equivalents where the orchestrator needs a different shape.
 */

// --- Types (re-exported as type-only) ---
export type { DevelopmentService, TaskDescriptor } from "@ashara/development";
export type { ProvisionedEnv } from "@ashara/development";

// --- Values (re-exported) ---
export { readManifestContext } from "@ashara/development";
export { assertValidTargetProjectPath } from "@ashara/development";
export { deriveEnvironmentSpec } from "@ashara/development";
