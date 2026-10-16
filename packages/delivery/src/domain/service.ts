import type { WorkItemId, DomainEvent, StepContainment } from "@ashara/shared";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import type { EventPublisher } from "../lifecycle/ports.js";
import { GateKeeper } from "./gate.js";
import type { GatedWork } from "./gate.js";
import { TaskSelector } from "./select.js";
import { LifecycleRouter } from "./router.js";
import type { AttemptVerdict } from "./router.js";

export class PlanningService {
  /**
   * The tasks admitted this cycle, each with how many tasks its completion unlocks, from its own
   * project's dependency graph (a cycle in one project leaves only that project's weights at zero).
   */
  static async gate(repo: WorkItemRepository, projects: ActiveProjects, events: EventPublisher, containment: StepContainment): Promise<GatedWork> {
    return GateKeeper.filterAvailable(repo, projects, events, containment);
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
    verdict: AttemptVerdict,
  ): Promise<DomainEvent[]> {
    return LifecycleRouter.route(repo, taskId, verdict);
  }

  /** A merge_unrecorded (or orphan_unreconciled, merge found) item whose merge record is now written: Completed, with its ancestors rolled up. */
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
