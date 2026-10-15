import type {
  WorkItemId,
  WorkItemStatus,
  DomainEvent,
} from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import type { EventPublisher } from "../lifecycle/ports.js";
import { DependencyGraph } from "./dependency.js";
import { GateKeeper } from "./gate.js";
import { TaskSelector } from "./select.js";
import { LifecycleRouter } from "./router.js";

export class PlanningService {
  static async gate(repo: WorkItemRepository, projects: ActiveProjects, events: EventPublisher): Promise<WorkItem[]> {
    return GateKeeper.filterAvailable(repo, projects, events);
  }

  /**
   * How many tasks each eligible task's completion unlocks, from each of their projects' own
   * dependency graph (a cycle in one project leaves only that project's weights at zero).
   */
  static async unlockWeights(repo: WorkItemRepository, eligible: readonly WorkItem[]): Promise<Map<string, number>> {
    const weights = new Map<string, number>();
    for (const projectId of new Set(eligible.map((item) => item.projectId))) {
      const graph = await DependencyGraph.load(repo, projectId);
      for (const [id, weight] of graph.computeUnlockWeights()) weights.set(id, weight);
    }
    return weights;
  }

  static select(
    eligible: WorkItem[],
    maxBatchSize: number,
    unlockWeights?: Map<string, number>,
  ): WorkItem[] {
    return TaskSelector.selectBatch(eligible, maxBatchSize, unlockWeights);
  }

  static async route(
    repo: WorkItemRepository,
    taskId: WorkItemId,
    success: boolean,
  ): Promise<DomainEvent[]> {
    return LifecycleRouter.route(repo, taskId, success);
  }

  /** A merge_unrecorded item whose merge record is now written: Completed, with its ancestors rolled up. */
  static async completeRecordedMerge(repo: WorkItemRepository, item: WorkItem): Promise<DomainEvent[]> {
    return LifecycleRouter.completeRecordedMerge(repo, item);
  }

  static async activateAncestors(
    repo: WorkItemRepository,
    parentId: WorkItemId | undefined,
  ): Promise<DomainEvent[]> {
    return LifecycleRouter.activateAncestors(repo, parentId);
  }

  static async findWorkItem(repo: WorkItemRepository, id: WorkItemId): Promise<WorkItem | null> {
    return repo.findById(id);
  }

  static async saveWorkItem(
    repo: WorkItemRepository,
    item: WorkItem,
    expectedPreviousStatus: WorkItemStatus,
  ): Promise<void> {
    return repo.save(item, expectedPreviousStatus);
  }

  static async createWorkItem(repo: WorkItemRepository, item: WorkItem): Promise<WorkItem> {
    return repo.create(item);
  }
}
