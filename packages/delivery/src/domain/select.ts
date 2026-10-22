import type { WorkItem } from "./work-item.js";

export class TaskSelector {
  /**
   * The eligible task a free lane takes next: the one whose completion unlocks the most tasks, then
   * the oldest, then the lowest id; never one in `taken` (in flight, or already run this cycle).
   * Null when every eligible task is taken.
   */
  static next(
    available: readonly WorkItem[],
    taken: ReadonlySet<string>,
    unlockWeights?: Map<string, number>,
  ): WorkItem | null {
    const sorted = available
      .filter((item) => !taken.has(item.id))
      .sort((a, b) => {
        if (unlockWeights) {
          // eslint-disable-next-line no-restricted-syntax -- policy default: an item absent from the weights unlocks no task; it orders the choice only
          const wa = unlockWeights.get(a.id) ?? 0;
          // eslint-disable-next-line no-restricted-syntax -- policy default: an item absent from the weights unlocks no task; it orders the choice only
          const wb = unlockWeights.get(b.id) ?? 0;
          if (wa !== wb) return wb - wa;
        }
        const byAge = a.createdAt.getTime() - b.createdAt.getTime();
        if (byAge !== 0) return byAge;
        // Items created in one transaction share a timestamp: the id makes their order a function of the items, not of the input order.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return sorted[0] ?? null;
  }
}
