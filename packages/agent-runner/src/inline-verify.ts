import { createVerifyAdapter } from "./acl/development-acl.js";
import type { VerifyOutput, VerifyPort } from "./acl/development-acl.js";

// ---------------------------------------------------------------------------
// Public types (consumed by runner.ts and re-exported from index.ts).
// The result shapes come from the ACL — agent-runner never restates
// development's verify contract locally.
// ---------------------------------------------------------------------------

export type InlineVerifyResult = VerifyOutput;

// ---------------------------------------------------------------------------
// Thin out-of-process adapter over the ACL's VerifyPort.
//
// The agent runs in a subprocess against its own worktree, so working dir and
// git root are the same path and it supplies no pre-computed diff.
//
// Both `checks` and `contractChecks` are required — the caller resolves any
// optionality at the call site, not here. A missing field is a compile error,
// not a silent empty array (C1: the identity element is unavailable).
// ---------------------------------------------------------------------------

/**
 * Run inline verification in the agent's working directory: deterministic
 * checks (lint, test, typecheck) based on project markers.
 */
export async function runInlineVerify(
    workingDir: string,
    checks: readonly string[],
    contractChecks: readonly string[],
    verify: VerifyPort = createVerifyAdapter(),
): Promise<InlineVerifyResult> {
    return verify.runVerify({
        workDir: workingDir,
        gitRoot: workingDir,
        checks: [...checks],
        contractChecks: [...contractChecks],
    });
}
