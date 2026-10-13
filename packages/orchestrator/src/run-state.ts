import { randomUUID } from "node:crypto";
import type { RunStateRepository } from "@ashara/db";
import type { RunState } from "@ashara/shared";

/**
 * The durable half of the budget's cap counter (Discipline B): a bound only means
 * something if it survives a crash-restart of the process it bounds.
 */
export type RunStateStore = Pick<RunStateRepository, "load" | "save">;

export interface RunCounters {
  readonly spendUsd: number;
}

/**
 * Adopts the existing run record, or starts one when the database has none.
 *
 * Nothing closes a run, so a restart always adopts the recorded spend: the cap is
 * a lifetime total per database (ADR-073 addendum 3, interim until story
 * c-cost-ledger). The owner unblocks a spent cap by raising
 * `ASHARA_BUDGET_LIMIT_USD`.
 *
 * Deliberately NOT fail-soft: a store error propagates. Dispatching against an
 * unknown budget baseline is dispatching with no cap at all, so the cycle fails
 * and the runner backs off rather than starting from an invented zero.
 */
export async function openRun(store: RunStateStore): Promise<RunState> {
  const existing = await store.load();

  if (existing) {
    console.warn(
      `[run-state] resuming run ${existing.runId} opened at ${existing.openedAt}: ` +
        `$${existing.spendUsd.toFixed(4)} already spent.`,
    );
    return existing;
  }

  const opened: RunState = {
    runId: randomUUID(),
    openedAt: new Date().toISOString(),
    spendUsd: 0,
  };
  await store.save(opened);
  console.log(`[run-state] opened run ${opened.runId}; spend starts at zero`);
  return opened;
}

/**
 * Writes the current counters back to the open run. Fail-soft with a loud warn:
 * the in-process caps still bind for this process, and refusing to continue
 * would turn a transient DB blip into a stopped run. The cost of a lost write is
 * that a crash-restart adopts a stale (lower) spend, which is why it is logged
 * at warn rather than swallowed.
 */
export async function persistRun(
  store: RunStateStore,
  state: RunState,
  counters: RunCounters,
): Promise<RunState> {
  const next: RunState = { ...state, ...counters };
  try {
    await store.save(next);
  } catch (e) {
    console.warn(
      `[run-state] failed to persist run ${state.runId} ($${counters.spendUsd.toFixed(4)} spent); ` +
        `a crash before the next successful write would resume from a stale total:`,
      e,
    );
  }
  return next;
}
