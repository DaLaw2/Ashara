import type { WorkItemLevel, WorkItemStatus } from "@ashara/shared";
import { TERMINAL_STATUSES } from "@ashara/shared";
import type { DependencyResolution } from "../domain/index.js";
import type { TerminationDecision, TerminationCounts, StalledItem, StalledCause, TerminationPlanExhausted } from "../termination.js";

export interface TerminationItemSnapshot {
  readonly id: string;
  readonly parentId?: string;
  readonly status: WorkItemStatus;
  readonly level: WorkItemLevel;
  readonly resolution: DependencyResolution;
  readonly blockedBy: readonly string[];
  readonly recoverable?: boolean;
}

export interface TerminationSnapshot {
  readonly items: readonly TerminationItemSnapshot[];
  readonly budgetExhausted: boolean;
  readonly openCoverageGaps: number;
}

function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function evaluate(snapshot: TerminationSnapshot): TerminationDecision {
  const { items, budgetExhausted, openCoverageGaps } = snapshot;
  const parentsWithChildren = collectParents(items);
  const counts = tallyCounts(items, parentsWithChildren);

  if (counts.total > 0 && counts.nonTerminal === 0 && openCoverageGaps === 0) {
    return { decision: "plan_exhausted", trigger: "completeness", counts, stalled: [] };
  }

  if (budgetExhausted) {
    return { decision: "stop", reason: "economy", counts, stalled: [], abandonedRoots: [] };
  }

  if (counts.total > 0 && counts.nonTerminal > 0 && !hasAdvanceableItem(items, parentsWithChildren)) {
    const { stalled } = classifyStalled(items);
    return { decision: "plan_exhausted", trigger: "liveness", counts, stalled };
  }

  return { decision: "continue", counts };
}

function collectParents(items: readonly TerminationItemSnapshot[]): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const item of items) {
    if (item.parentId !== undefined) parents.add(item.parentId);
  }
  return parents;
}

function isAdvanceable(item: TerminationItemSnapshot, parentsWithChildren: ReadonlySet<string>): boolean {
  if (item.status === "InProgress" && item.level === "Task") return true;
  if (item.status === "Failed") return item.recoverable === true;
  if (item.status !== "Pending") return false;
  if (item.resolution !== "met") return false;
  if (item.level === "Task") return true;
  if (item.level === "Story" && !parentsWithChildren.has(item.id)) return true;
  return false;
}

function hasAdvanceableItem(
  items: readonly TerminationItemSnapshot[],
  parentsWithChildren: ReadonlySet<string>,
): boolean {
  return items.some((item) => isAdvanceable(item, parentsWithChildren));
}

function classifyStalled(items: readonly TerminationItemSnapshot[]): {
  stalled: StalledItem[];
  abandonedRoots: string[];
} {
  const childrenByParent = groupByParent(items);
  const stalled: StalledItem[] = [];
  const roots = new Set<string>();

  for (const item of items) {
    if (isTerminal(item.status)) continue;
    const cause = classifyCause(item);
    let blockedBy = item.blockedBy;

    if (cause === "blocked_by_abandoned") {
      for (const root of item.blockedBy) roots.add(root);
    } else if (cause === "cascade_frozen") {
      const abandonedLeaves = collectAbandonedDescendants(item.id, childrenByParent);
      if (abandonedLeaves.length > 0) blockedBy = abandonedLeaves;
      for (const root of abandonedLeaves) roots.add(root);
    }

    stalled.push({ id: item.id, status: item.status, level: item.level, cause, blockedBy });
  }

  return { stalled, abandonedRoots: [...roots] };
}

function groupByParent(
  items: readonly TerminationItemSnapshot[],
): ReadonlyMap<string, TerminationItemSnapshot[]> {
  const byParent = new Map<string, TerminationItemSnapshot[]>();
  for (const item of items) {
    if (item.parentId === undefined) continue;
    const siblings = byParent.get(item.parentId);
    if (siblings) siblings.push(item);
    else byParent.set(item.parentId, [item]);
  }
  return byParent;
}

function collectAbandonedDescendants(
  rootId: string,
  childrenByParent: ReadonlyMap<string, TerminationItemSnapshot[]>,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>([rootId]);
  const stack: TerminationItemSnapshot[] = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || visited.has(node.id)) continue;
    visited.add(node.id);
    if (node.status === "Abandoned") out.push(node.id);
    const children = childrenByParent.get(node.id);
    if (children) stack.push(...children);
  }
  return out;
}

function classifyCause(item: TerminationItemSnapshot): StalledCause {
  if (item.resolution === "blocked") return "blocked_by_abandoned";
  if (item.status === "Failed") return "stuck_failed";
  if (item.status === "Blocked") return "externally_blocked";
  if (item.level !== "Task") return "cascade_frozen";
  return "stalled_waiting";
}

function tallyCounts(
  items: readonly TerminationItemSnapshot[],
  parentsWithChildren: ReadonlySet<string>,
): TerminationCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  let failed = 0;
  let abandoned = 0;
  let nonTerminal = 0;
  let dispatchable = 0;
  let inFlight = 0;

  for (const item of items) {
    switch (item.status) {
      case "Pending":
        pending += 1;
        break;
      case "InProgress":
        inProgress += 1;
        break;
      case "Completed":
        completed += 1;
        break;
      case "Blocked":
        blocked += 1;
        break;
      case "Failed":
        failed += 1;
        break;
      case "Abandoned":
        abandoned += 1;
        break;
    }

    if (!isTerminal(item.status)) nonTerminal += 1;
    if (item.status === "InProgress" && item.level === "Task") inFlight += 1;
    if (isAdvanceable(item, parentsWithChildren) && item.status === "Pending") dispatchable += 1;
  }

  return {
    total: items.length,
    pending,
    inProgress,
    completed,
    blocked,
    failed,
    abandoned,
    nonTerminal,
    dispatchable,
    inFlight,
  };
}
