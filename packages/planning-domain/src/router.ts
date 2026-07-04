import type { WorkItemId, DomainEvent } from "@ashara/shared";

import type { WorkItemRepository } from "./repository.js";
import type { WorkItem } from "./work-item.js";
import { completeWorkItem, failWorkItem, startWorkItem, takeEvents } from "./work-item.js";
import { WorkItemNotFound } from "./errors.js";
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
      failWorkItem(item, { reason: "task_failed" });
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
   * A sibling settles its parent when Completed, or when Abandoned with an
   * explicit substitute (blockedReason.substitutedBy) that itself resolved to
   * Completed — the identical fail-closed rule DependencyGraph.classifyDependency
   * applies at the dispatch gate (dependency.ts:159-174). An exhausted Abandoned
   * sibling (no substitute recorded, or a substitute that never completed) means
   * the work is genuinely missing, so it must NOT settle the parent (Run-9
   * redteam L2) — the parent stays incomplete rather than silently rolling up.
   */
  private static async isSettled(repo: WorkItemRepository, item: WorkItem): Promise<boolean> {
    if (item.status === "Completed") return true;
    if (item.status !== "Abandoned") return false;

    const substituteId = extractSubstitutedBy(item.blockedReason);
    if (substituteId === undefined) return false;

    const substitute = await repo.findById(substituteId as WorkItemId);
    return substitute?.status === "Completed";
  }

  private static async allSettled(repo: WorkItemRepository, items: readonly WorkItem[]): Promise<boolean> {
    for (const item of items) {
      if (!(await this.isSettled(repo, item))) return false;
    }
    return true;
  }
}
