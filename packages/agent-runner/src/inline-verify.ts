import { runVerifyCore } from "@ashara/development";

// ---------------------------------------------------------------------------
// Public types (consumed by runner.ts and re-exported from index.ts)
// ---------------------------------------------------------------------------

export interface VerifyCheckResult {
    readonly name: string;
    readonly passed: boolean;
    readonly output: string;
}

export interface VerifyTierResult {
    readonly status: "pass" | "fail" | "skipped" | "error";
    readonly details: string;
    readonly checks?: VerifyCheckResult[];
    readonly issues?: string[];
}

export interface InlineVerifyResult {
    readonly passed: boolean;
    readonly tiers: {
        readonly deterministic: VerifyTierResult;
    };
}

export interface InlineVerifyTaskSpec {
    readonly checks?: string[];
}

// ---------------------------------------------------------------------------
// Thin out-of-process adapter over the shared verify-core library.
//
// The agent runs in a subprocess against its own worktree, so working dir and
// git root are the same path and it supplies no pre-computed diff.
// ---------------------------------------------------------------------------

/**
 * Run inline verification in the agent's working directory: deterministic
 * checks (lint, test, typecheck) based on project markers.
 */
export async function runInlineVerify(
    workingDir: string,
    taskSpec?: InlineVerifyTaskSpec,
): Promise<InlineVerifyResult> {
    const result = await runVerifyCore({
        workDir: workingDir,
        gitRoot: workingDir,
        checks: taskSpec?.checks ?? [],
    });

    return {
        passed: result.passed,
        tiers: result.tiers,
    };
}
