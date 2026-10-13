import type { WorkItem } from "./work-item.js";

export class TaskSelector {
  static selectBatch(
    available: WorkItem[],
    maxBatchSize: number,
    unlockWeights?: Map<string, number>,
  ): WorkItem[] {
    const sorted = [...available].sort((a, b) => {
      if (unlockWeights) {
        const wa = unlockWeights.get(a.id) ?? 0;
        const wb = unlockWeights.get(b.id) ?? 0;
        if (wa !== wb) return wb - wa;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return sorted.slice(0, maxBatchSize);
  }
}
