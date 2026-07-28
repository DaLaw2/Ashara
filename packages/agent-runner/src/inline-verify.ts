import { createVerifyAdapter } from "./acl/development-acl.js";
import type { VerifyOutput, VerifyPort } from "./acl/development-acl.js";

// ---------------------------------------------------------------------------
// Public types (consumed by runner.ts and re-exported from index.ts).
// The result shapes come from the ACL — agent-runner never restates
// development's verify contract locally.
// ---------------------------------------------------------------------------

export type InlineVerifyResult = VerifyOutput;

export interface InlineVerifyTaskSpec {
    readonly checks?: string[];
}

// ---------------------------------------------------------------------------
// Thin out-of-process adapter over the ACL's VerifyPort.
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
    verify: VerifyPort = createVerifyAdapter(),
): Promise<InlineVerifyResult> {
    return verify.runVerify({
        workDir: workingDir,
        gitRoot: workingDir,
        checks: taskSpec?.checks ?? [],
    });
}
