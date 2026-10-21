import { z } from "zod";

export type WorkItemLevel = "Epic" | "Task";

/**
 * Every status a work item can hold; the type is derived from it so the list cannot fall behind.
 */
export const WORK_ITEM_STATUSES = ["Pending", "InProgress", "Completed", "Blocked", "Failed", "Abandoned"] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Whether a work item in each status still asks for work: an open item may yet run, change or be
 * given up, a settled one never runs again unless reopened. Every status is classified here, so a
 * status added above does not compile until it is placed; a reader that asks whether anything is
 * still open reads the settled half and counts every other status as open.
 */
const WORK_ITEM_STATUS_STANDING = {
  Pending: "open",
  InProgress: "open",
  Completed: "settled",
  Blocked: "open",
  Failed: "open",
  Abandoned: "settled",
} as const satisfies Record<WorkItemStatus, "open" | "settled">;

export const SETTLED_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = WORK_ITEM_STATUSES.filter((status) => WORK_ITEM_STATUS_STANDING[status] === "settled");

/** @testseam the partition and acceptance readiness tests enumerate the open half; readers ask for the settled half, so a status no one placed reads as open */
export const OPEN_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = WORK_ITEM_STATUSES.filter((status) => WORK_ITEM_STATUS_STANDING[status] === "open");

const WorkItemLevelSchema = z.enum(["Epic", "Task"]);
const WorkItemStatusSchema = z.enum(WORK_ITEM_STATUSES);

/** A stored level or status that names none of its vocabulary. */
class InvalidWorkItemEnum extends Error {
  constructor(
    readonly enumName: "WorkItemLevel" | "WorkItemStatus",
    readonly raw: unknown,
    readonly valid: readonly string[],
  ) {
    super(`Invalid ${enumName} ${JSON.stringify(raw)}. Valid: ${valid.join(", ")}`);
    this.name = "InvalidWorkItemEnum";
  }
}

export function parseWorkItemLevel(raw: unknown): WorkItemLevel {
  const parsed = WorkItemLevelSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidWorkItemEnum("WorkItemLevel", raw, WorkItemLevelSchema.options);
  return parsed.data;
}

export function parseWorkItemStatus(raw: unknown): WorkItemStatus {
  const parsed = WorkItemStatusSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidWorkItemEnum("WorkItemStatus", raw, WORK_ITEM_STATUSES);
  return parsed.data;
}
