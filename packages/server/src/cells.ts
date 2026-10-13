import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SubstrateUnavailable } from "@ashara/execution-infra";
import type { PodmanSubstrate } from "@ashara/execution-infra";

/**
 * The ashara.instance label of this deployment's cells: a stable digest of workdirBase, so a
 * restart of the same deployment finds its own leaked cells and never another deployment's.
 */
export function cellInstanceFor(workdirBase: string): string {
  return `w-${createHash("sha256").update(resolve(workdirBase)).digest("hex").slice(0, 16)}`;
}

/**
 * Startup (Discipline B): removes the cells a previous process of this instance left behind,
 * before the runner dispatches anything. A substrate that is unavailable now is not a reason to
 * refuse to boot: every task then blocks at its own probe (s-isolated-worker-m1 C2), and the
 * leaked cells are removed by the first startup that can reach podman.
 */
export async function reconcileCellsAtStartup(substrate: Pick<PodmanSubstrate, "reconcileOrphans">, instance: string): Promise<void> {
  try {
    const removed = await substrate.reconcileOrphans(instance);
    console.log(`Cells: reconciled instance ${instance}, removed ${removed.length} orphaned cell(s)${removed.length > 0 ? `: ${removed.join(", ")}` : ""}`);
  } catch (err) {
    if (!(err instanceof SubstrateUnavailable)) throw err;
    console.warn(`Cells: orphan reconciliation skipped, the substrate is unavailable; tasks will block until it is: ${err.message}`);
  }
}

/** Shutdown drain: every cell this process still holds is removed; a failure is reported, never swallowed. */
export async function teardownCellsAtShutdown(substrate: Pick<PodmanSubstrate, "teardownAll">): Promise<void> {
  try {
    const removed = await substrate.teardownAll();
    console.log(`Cells: removed ${removed.length} cell(s) at shutdown`);
  } catch (err) {
    console.error("Cells: teardown at shutdown incomplete; the next startup's reconciliation removes the rest:", err);
  }
}
