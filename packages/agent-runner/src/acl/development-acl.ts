/**
 * Anti-Corruption Layer: agent-runner <-> @ashara/development (ADR-044 Phase 6).
 *
 * This is the ONLY file in agent-runner that imports from @ashara/development.
 * All other agent-runner modules program against the port interfaces and types
 * defined here. If development changes its internal types, only this file's
 * adapter code needs to change.
 *
 * Structure:
 *   1. Agent-runner-local types (what agent-runner programs against)
 *   2. Port interfaces (contracts for each capability)
 *   3. Adapter factories (wire development's implementations behind ports)
 */

import {
    runVerifyCore,
    defaultRunCommand,
    buildAutoProfile as devBuildAutoProfile,
    buildProjectContext as devBuildProjectContext,
    formatProjectProfile as devFormatProjectProfile,
} from "@ashara/development";
import type {
    ProjectProfile as DevProjectProfile,
} from "@ashara/development";

// ============================================================================
// 1. Agent-runner-local types
// ============================================================================

// ---------------------------------------------------------------------------
// Verify types (mirrors CoreVerifyInput / CoreVerifyResult / CoreTierResult
// from development's verify-core, which are not exported from the package
// barrel — agent-runner defines its own equivalent shapes)
// ---------------------------------------------------------------------------

export interface VerifyInput {
    readonly workDir: string;
    readonly gitRoot: string;
    readonly checks: readonly string[];
    readonly contractChecks: readonly string[];
}

export interface VerifyCheckResult {
    readonly name: string;
    readonly passed: boolean;
    readonly output: string;
}

export interface VerifyTierResult {
    readonly status: "pass" | "fail" | "skipped" | "error";
    readonly details: string;
    readonly checks?: readonly VerifyCheckResult[];
    readonly issues?: readonly string[];
}

export interface VerifyOutput {
    readonly verdict: "passed" | "failed" | "unverified";
    readonly tiers: {
        readonly deterministic: VerifyTierResult;
    };
}

// ---------------------------------------------------------------------------
// Project profile types (mirrors ProjectProfile from development's
// brief-assembly)
// ---------------------------------------------------------------------------

export interface ProjectProfile {
    readonly name: string;
    readonly techStack: string[];
    readonly buildCommand: string;
    readonly testCommand: string;
    readonly lintCommand: string;
    readonly conventions: string[];
    readonly moduleBoundaries: string;
}

// ============================================================================
// 2. Port interfaces
// ============================================================================

/**
 * Deterministic verification: lint, typecheck, test checks against a worktree.
 * Used by inline-verify.ts to run post-agent verification.
 */
export interface VerifyPort {
    runVerify(input: VerifyInput): Promise<VerifyOutput>;
}

/**
 * Project profile auto-detection: scans a working directory for tech stack
 * markers, instruction files, and directory structure. Used by runner.ts
 * and brief-builder.ts.
 */
export interface ProjectProfilePort {
    buildAutoProfile(projectDir: string): Promise<ProjectProfile>;
    buildProjectContext(projectDir: string): Promise<string>;
    formatProjectProfile(profile: ProjectProfile): string;
}

// ============================================================================
// 3. Adapter factories
// ============================================================================

// ---------------------------------------------------------------------------
// Verify adapter
// ---------------------------------------------------------------------------

/**
 * Create a VerifyPort backed by development's runVerifyCore.
 *
 * The adapter is a structural pass-through: agent-runner's VerifyInput and
 * VerifyOutput are shape-compatible with development's CoreVerifyInput and
 * CoreVerifyResult. The boundary protection comes from this being the single
 * import point, not from a data transformation.
 */
export function createVerifyAdapter(): VerifyPort {
    return {
        async runVerify(input: VerifyInput): Promise<VerifyOutput> {
            // Explicit defaultRunCommand: this code runs inside the ADR-058
            // agent container, so local spawn is already contained. Both
            // preparation and checks use the same runner — the container
            // already has network access for dependency fetching.
            const devResult = await runVerifyCore(
                {
                    workDir: input.workDir,
                    gitRoot: input.gitRoot,
                    checks: [...input.checks],
                    contractChecks: [...input.contractChecks],
                },
                {
                    runCommand: defaultRunCommand,
                    prepareRunCommand: defaultRunCommand,
                },
            );
            return translateVerifyOutput(devResult);
        },
    };
}

/**
 * Translate development's CoreVerifyResult into agent-runner's VerifyOutput.
 * Currently a structural pass-through; if development changes the shape,
 * only this function needs updating.
 */
function translateVerifyOutput(devResult: {
    readonly verdict: "passed" | "failed" | "unverified";
    readonly tiers: {
        readonly deterministic: {
            readonly status: "pass" | "fail" | "skipped" | "error";
            readonly details: string;
            readonly checks?: ReadonlyArray<{
                readonly name: string;
                readonly passed: boolean;
                readonly output: string;
            }>;
            readonly issues?: readonly string[];
        };
    };
}): VerifyOutput {
    const devTier = devResult.tiers.deterministic;
    return {
        verdict: devResult.verdict,
        tiers: {
            deterministic: {
                status: devTier.status,
                details: devTier.details,
                checks: devTier.checks?.map((c) => ({
                    name: c.name,
                    passed: c.passed,
                    output: c.output,
                })),
                issues: devTier.issues ? [...devTier.issues] : undefined,
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Project profile adapter
// ---------------------------------------------------------------------------

/**
 * Create a ProjectProfilePort backed by development's dispatch-utils and
 * brief-assembly functions.
 *
 * The adapter translates between agent-runner's ProjectProfile type and
 * development's ProjectProfile type. Currently structurally identical.
 */
export function createProfileAdapter(): ProjectProfilePort {
    return {
        async buildAutoProfile(projectDir: string): Promise<ProjectProfile> {
            const devProfile = await devBuildAutoProfile(projectDir);
            return translateProjectProfile(devProfile);
        },

        async buildProjectContext(projectDir: string): Promise<string> {
            return devBuildProjectContext(projectDir);
        },

        formatProjectProfile(profile: ProjectProfile): string {
            const devProfile: DevProjectProfile = {
                name: profile.name,
                techStack: profile.techStack,
                buildCommand: profile.buildCommand,
                testCommand: profile.testCommand,
                lintCommand: profile.lintCommand,
                conventions: profile.conventions,
                moduleBoundaries: profile.moduleBoundaries,
            };
            return devFormatProjectProfile(devProfile);
        },
    };
}

/** Translate development ProjectProfile to agent-runner ProjectProfile. */
function translateProjectProfile(devProfile: DevProjectProfile): ProjectProfile {
    return {
        name: devProfile.name,
        techStack: [...devProfile.techStack],
        buildCommand: devProfile.buildCommand,
        testCommand: devProfile.testCommand,
        lintCommand: devProfile.lintCommand,
        conventions: [...devProfile.conventions],
        moduleBoundaries: devProfile.moduleBoundaries,
    };
}
