import { randomUUID } from "node:crypto";
import type { RunStateRepository } from "@ashara/db";
import type { RunState } from "@ashara/shared";

/**
 * The durable half of every per-run cap counter (Discipline B). Spend and
 * acceptance attempts are the same kind of thing — a bound
 * that only means something if it survives a crash-restart of the run it bounds
 * — so they share ONE record and ONE open/close protocol rather than each
 * growing its own persistence.
 */
export type RunStateStore = Pick<RunStateRepository, "load" | "save">;

export interface RunCounters {
  readonly spendUsd: number;
  readonly acceptanceAttempts: number;
}

/**
 * Adopts the in-flight run, or starts a new one.
 *
 * A run ends when the runner stops on its own termination verdict, and that
 * closes the record — so a *relaunch* after a finished run correctly starts at
 * zero, which is the per-run semantic the owner's ledger-archive decision
 * encodes. An OPEN record means the previous process died mid-run: its spend is
 * adopted, because handing the same $1 out again is how a "per-run cap" becomes
 * unbounded across a crash loop.
 *
 * Deliberately NOT fail-soft: a store error propagates. Dispatching against an
 * unknown budget baseline is dispatching with no cap at all, so the cycle fails
 * and the runner backs off rather than starting from an invented zero.
 */
export async function openRun(store: RunStateStore): Promise<RunState> {
  const existing = await store.load();

  if (existing && !existing.closed) {
    console.warn(
      `[run-state] resuming run ${existing.runId} opened at ${existing.openedAt}: ` +
        `$${existing.spendUsd.toFixed(4)} already spent, acceptanceAttempts=${existing.acceptanceAttempts}. ` +
        `The previous process did not close this run.`,
    );
    return existing;
  }

  const opened: RunState = {
    runId: randomUUID(),
    openedAt: new Date().toISOString(),
    closed: false,
    spendUsd: 0,
    acceptanceAttempts: 0,
  };
  await store.save(opened);
  console.log(`[run-state] opened run ${opened.runId}; per-run counters start at zero`);
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

/**
 * Closes the run so the next process starts fresh. Called ONLY when the runner
 * stopped on its own termination verdict — an operator SIGTERM leaves the record
 * open on purpose, so a restart resumes the same cap.
 */
export async function closeRun(store: RunStateStore): Promise<void> {
  try {
    const state = await store.load();
    if (!state || state.closed) return;
    await store.save({ ...state, closed: true });
    console.log(
      `[run-state] closed run ${state.runId} at $${state.spendUsd.toFixed(4)}; the next run starts at zero`,
    );
  } catch (e) {
    console.warn(
      "[run-state] failed to close the run record; the next process will resume this run's counters instead of starting fresh:",
      e,
    );
  }
}
