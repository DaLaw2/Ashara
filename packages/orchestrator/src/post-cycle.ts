import { reconcileCoverage } from "./acl/planning-acl.js";
import type { CoreLoopDeps } from "./types.js";

/**
 * Runs the per-cycle coverage reconciliation (mig9-t2). No-op when no contract
 * repo is wired. Logs each open gap; enforcing mode also proposes coverage tasks
 * (inside reconcileCoverage) so an uncovered declared endpoint becomes plannable
 * work rather than a silent hole. Never throws into the cycle — a reconciliation
 * failure is logged and the cycle proceeds (the rollup HOLD is the safety net).
 */
export async function reconcileCoverageGaps(deps: CoreLoopDeps, runScope: string): Promise<void> {
  if (!deps.contractRepo) return;
  try {
    const gaps = await reconcileCoverage({
      workItemRepo: deps.workItemRepo,
      contractRepo: deps.contractRepo,
      withPlanningTransaction: deps.withPlanningTransaction,
      enforcing: deps.config.coverageEnforcing,
      runScope,
    });
    for (const gap of gaps) {
      console.log(
        `Coverage gap (${deps.config.coverageEnforcing ? "enforcing" : "observe-only"}): ` +
          `${gap.method} ${gap.path} [${gap.kind}] — ${gap.reason}`,
      );
    }
  } catch (e) {
    console.warn("Coverage reconciliation failed, continuing:", e);
  }
}
