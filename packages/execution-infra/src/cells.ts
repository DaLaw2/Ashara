import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describeErrorChain } from "@ashara/shared";
import { SubstrateUnavailable } from "./errors.js";
import type { PodmanSubstrate } from "./podman.js";

/** Whether the substrate answers now, with what it answered or why it did not. */
interface SubstrateProbe {
  probe(): Promise<{ readonly passed: true; readonly evidence: string } | { readonly passed: false; readonly evidence: string }>;
}

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

/**
 * The probe an infrastructure halt waits on (story s-loop-never-stop-m1 W6): the substrate answers
 * `info`. A probe that throws, for any reason, did not pass.
 */
export function substrateProbe(substrate: Pick<PodmanSubstrate, "probeSubstrate">): SubstrateProbe {
  return {
    async probe() {
      try {
        const info = await substrate.probeSubstrate();
        return { passed: true, evidence: `substrate answered: version ${info.version}, rootless ${String(info.rootless)}` };
      } catch (err) {
        return { passed: false, evidence: describeErrorChain(err) };
      }
    },
  };
}

/**
 * Between cycles, when no attempt is in flight: every cell this process still holds is one whose
 * teardown failed (its attempt is over, its task may be settled), so it is removed now rather than
 * left running until shutdown. A failure is logged at warn and the next cycle retries it.
 */
export async function releaseHeldCells(substrate: Pick<PodmanSubstrate, "teardownAll">): Promise<void> {
  try {
    const removed = await substrate.teardownAll();
    if (removed.length > 0) console.log(`Cells: removed ${removed.length} cell(s) a failed teardown left: ${removed.join(", ")}`);
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: removal of cells a failed teardown left is cleanup, retried every cycle and at shutdown
    console.warn(`Cells: a cell a failed teardown left could not be removed; the next cycle retries it: ${describeErrorChain(err)}`);
  }
}

/** Shutdown drain: every cell this process still holds is removed; a failure is reported, never swallowed. */
export async function teardownCellsAtShutdown(substrate: Pick<PodmanSubstrate, "teardownAll">): Promise<void> {
  try {
    const removed = await substrate.teardownAll();
    console.log(`Cells: removed ${removed.length} cell(s) at shutdown`);
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the shutdown drain is cleanup; the next startup's reconciliation removes the cells it left
    console.error("Cells: teardown at shutdown incomplete; the next startup's reconciliation removes the rest:", err);
  }
}
