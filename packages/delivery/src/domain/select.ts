import type { WorkItem } from "./work-item.js";

export class TaskSelector {
  static selectBatch(
    available: WorkItem[],
    maxBatchSize: number,
    unlockWeights?: Map<string, number>,
  ): WorkItem[] {
    const sorted = [...available].sort((a, b) => {
      if (unlockWeights) {
        // eslint-disable-next-line no-restricted-syntax -- policy default: an item absent from the weights unlocks no task; it orders the batch only
        const wa = unlockWeights.get(a.id) ?? 0;
        // eslint-disable-next-line no-restricted-syntax -- policy default: an item absent from the weights unlocks no task; it orders the batch only
        const wb = unlockWeights.get(b.id) ?? 0;
        if (wa !== wb) return wb - wa;
      }
      const byAge = a.createdAt.getTime() - b.createdAt.getTime();
      if (byAge !== 0) return byAge;
      // Items created in one transaction share a timestamp: the id makes their order a function of the items, not of the input order.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return sorted.slice(0, maxBatchSize);
  }
}
