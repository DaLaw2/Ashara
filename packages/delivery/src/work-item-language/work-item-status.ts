import { z } from "zod";

export type WorkItemLevel = "Epic" | "Task";

/**
 * Every status a work item can hold; the type is derived from it so the list cannot fall behind.
 */
export const WORK_ITEM_STATUSES = ["Pending", "InProgress", "Completed", "Blocked", "Failed", "Abandoned"] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

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
