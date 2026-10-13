import type { WorkItemId, DomainEvent } from "@ashara/shared";
import { WorkItemNotFound } from "@ashara/shared";
import type { WorkItemRepository } from "./repository.js";
import type { WorkItem } from "./work-item.js";
import { completeRecordedMerge, completeWorkItem, failWorkItem, startWorkItem, takeEvents } from "./work-item.js";

export class LifecycleRouter {
  static async route(
    repo: WorkItemRepository,
    taskId: WorkItemId,
    success: boolean,
  ): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];

    const item = await repo.findById(taskId);
    if (!item) throw new WorkItemNotFound(taskId);

    const from = item.status;
    if (success) {
      completeWorkItem(item);
      await repo.save(item, from);
      events.push(...takeEvents(item));

      if (item.parentId) {
        await this.cascadeCompletion(repo, item.parentId, events);
      }
    } else {
      failWorkItem(item, { source: "task_failed", reason: "task_failed" });
      await repo.save(item, from);
      events.push(...takeEvents(item));
    }

    return events;
  }

  /**
   * Completes `item`, Blocked as merge_unrecorded, once its merge record is written, and rolls
   * the completion up to its ancestors as a completed attempt does. Saved against `Blocked`: an
   * item that moved concurrently is InvalidStatusTransition.
   */
  static async completeRecordedMerge(repo: WorkItemRepository, item: WorkItem): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    completeRecordedMerge(item);
    await repo.save(item, "Blocked");
    events.push(...takeEvents(item));
    if (item.parentId) await this.cascadeCompletion(repo, item.parentId, events);
    return events;
  }

  static async activateAncestors(
    repo: WorkItemRepository,
    currentParentId: WorkItemId | undefined,
  ): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    let parentId = currentParentId;

    while (parentId) {
      const parent = await repo.findById(parentId);
      if (!parent) break;
      if (parent.status !== "Pending") break;

      const from = parent.status;
      startWorkItem(parent);
      await repo.save(parent, from);
      events.push(...takeEvents(parent));

      parentId = parent.parentId;
    }

    return events;
  }

  private static async cascadeCompletion(
    repo: WorkItemRepository,
    currentParentId: WorkItemId,
    events: DomainEvent[],
  ): Promise<void> {
    let parentId: WorkItemId | undefined = currentParentId;

    while (parentId) {
      const siblings = await repo.findChildren(parentId);
      if (siblings.length === 0) break;
      if (!siblings.every(isSettled)) break;

      const parent = await repo.findById(parentId);
      if (!parent) throw new WorkItemNotFound(parentId);

      if (parent.status === "Completed" || parent.status === "Blocked" || parent.status === "Failed") break;

      if (parent.status === "Pending") {
        startWorkItem(parent);
        await repo.save(parent, "Pending");
        events.push(...takeEvents(parent));
      }

      const from = parent.status;
      completeWorkItem(parent);
      await repo.save(parent, from);
      events.push(...takeEvents(parent));

      parentId = parent.parentId;
    }
  }
}

/**
 * A sibling settles its parent when:
 *  1. Completed — the canonical happy path.
 *  2. Abandoned with a salvaged completed result — the agent succeeded but
 *     the item was preempted to Abandoned during execution. The work is done;
 *     keeping the item terminal is correct, and the salvage makes it visible.
 *
 * An Abandoned item outside these two cases is genuinely missing work and
 * must not settle its parent — the parent stays incomplete rather than
 * silently rolling up (Run-9 redteam L2).
 */
function isSettled(item: WorkItem): boolean {
  if (item.status === "Completed") return true;
  return item.status === "Abandoned" && item.blockedReason?.salvagedOutcome === "completed";
}
