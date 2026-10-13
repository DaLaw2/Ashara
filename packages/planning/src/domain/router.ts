import type { WorkItemId, DomainEvent } from "@ashara/shared";
import { WorkItemNotFound } from "@ashara/shared";
import type { WorkItemRepository } from "./repository.js";
import type { WorkItem } from "./work-item.js";
import { completeWorkItem, failWorkItem, startWorkItem, takeEvents } from "./work-item.js";
import { extractSubstitutedBy } from "./substitution.js";

/**
 * Injected coverage HOLD predicate (mig9-t2, ADR-032 §2). Returns `true` when the
 * given parent must NOT settle Completed — its project has an open contract
 * coverage gap. Kept as a bare async predicate so this domain module stays free of
 * any contract/reconciliation type dependency; the orchestrator supplies the real
 * implementation (createCoverageRollupGuard) and omits it in observe-only mode.
 */
export type CoverageHold = (parent: WorkItem) => Promise<boolean>;

export class LifecycleRouter {
  static async route(
    repo: WorkItemRepository,
    taskId: WorkItemId,
    success: boolean,
    coverageHold?: CoverageHold,
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
        await this.cascadeCompletion(repo, item.parentId, events, coverageHold);
      }
    } else {
      failWorkItem(item, { source: "task_failed", reason: "task_failed" });
      await repo.save(item, from);
      events.push(...takeEvents(item));
    }

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
    coverageHold?: CoverageHold,
  ): Promise<void> {
    let parentId: WorkItemId | undefined = currentParentId;

    while (parentId) {
      const siblings = await repo.findChildren(parentId);
      if (siblings.length === 0) break;
      if (!(await this.allSettled(repo, siblings))) break;

      const parent = await repo.findById(parentId);
      if (!parent) throw new WorkItemNotFound(parentId);

      if (parent.status === "Completed" || parent.status === "Blocked" || parent.status === "Failed") break;

      // Coverage HOLD (mig9-t2): even when every child is settled, do not roll this
      // parent up to Completed while the project has an open contract coverage gap
      // (an endpoint declared but not produced — the Run-9 "Completed while auth
      // unusable" hole). The parent stays in its current status; the cascade stops.
      if (coverageHold && (await coverageHold(parent))) break;

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

  /**
   * A sibling settles its parent when:
   *  1. Completed — the canonical happy path.
   *  2. Abandoned with a salvaged completed result — the agent succeeded but
   *     the item was preempted to Abandoned during execution. The work is done;
   *     keeping the item terminal is correct, and the salvage makes it visible.
   *  3. Abandoned with a substitute that itself settled — failure recovery
   *     routed the work to an equivalent item that completed it under a new id.
   *
   * An Abandoned item outside these three cases is genuinely missing work and
   * must not settle its parent — the parent stays incomplete rather than
   * silently rolling up (Run-9 redteam L2).
   */
  private static async isSettled(repo: WorkItemRepository, item: WorkItem): Promise<boolean> {
    if (item.status === "Completed") return true;
    if (item.status !== "Abandoned") return false;

    // An Abandoned item whose agent actually completed its work: the result was
    // salvaged onto the blockedReason, so the work is done.
    if (item.blockedReason?.salvagedOutcome === "completed") return true;

    const substituteId = extractSubstitutedBy(item.blockedReason);
    if (substituteId === undefined) return false;

    const substitute = await repo.findById(substituteId as WorkItemId);
    if (!substitute) return false;
    return LifecycleRouter.isSettled(repo, substitute);
  }

  private static async allSettled(repo: WorkItemRepository, items: readonly WorkItem[]): Promise<boolean> {
    for (const item of items) {
      if (!(await this.isSettled(repo, item))) return false;
    }
    return true;
  }
}
