import { parseStoredBlockedReason, type StoredBlockedReason } from "./blocked-reason.js";
import { parseWorkItemStatus, type WorkItemStatus } from "./work-item-status.js";

/** What decides whether a work item's work is on main: its status and, when Blocked, its stored reason. */
export interface WorkStanding {
  readonly status: WorkItemStatus;
  readonly blockedReason?: StoredBlockedReason | undefined;
}

/**
 * Whether the item's work is merged on main: Completed, or Blocked as merge_unrecorded, whose code is
 * on main with only its merge record unwritten (its exit completes it). Every reader that asks whether
 * a correction or a revision may plan an item's work again reads this, never the status alone.
 */
export function workOnMain(item: WorkStanding): boolean {
  if (item.status === "Completed") return true;
  return item.status === "Blocked" && item.blockedReason?.source === "merge_unrecorded";
}

/**
 * workOnMain of a work item's row as another context reads it, its status and blocked reason as
 * stored: the reason is parsed only of a Blocked item, the one status whose standing it decides.
 */
export function storedWorkOnMain(row: { readonly status: string; readonly blockedReason: unknown }): boolean {
  const status = parseWorkItemStatus(row.status);
  return workOnMain({ status, blockedReason: status === "Blocked" ? parseStoredBlockedReason(row.blockedReason) : undefined });
}
