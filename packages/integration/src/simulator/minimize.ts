import type { Decision } from "./tape.js";

/** Whether a replay of these decisions (every other one benign) still fails the same way. */
type StillFails = (decisions: readonly Decision[]) => Promise<boolean>;

interface Minimized {
  readonly decisions: readonly Decision[];
  readonly replays: number;
  /** True when the replay budget ran out before a 1-minimal set was reached. */
  readonly budgetExhausted: boolean;
}

/**
 * Zeller's ddmin over a failing run's non-benign decisions: removes chunks, then
 * halves the chunk size, until no single decision can be removed. Each probe is one replay, so the
 * replay budget bounds it.
 */
export async function minimize(failing: readonly Decision[], stillFails: StillFails, maxReplays: number): Promise<Minimized> {
  let current = [...failing];
  let granularity = 2;
  let replays = 0;
  while (current.length >= 1) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += size) {
      if (replays >= maxReplays) return { decisions: current, replays, budgetExhausted: true };
      const complement = [...current.slice(0, start), ...current.slice(start + size)];
      replays += 1;
      if (await stillFails(complement)) {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (size <= 1) break;
    granularity = Math.min(granularity * 2, current.length);
  }
  return { decisions: current, replays, budgetExhausted: false };
}
