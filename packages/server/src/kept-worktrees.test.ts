import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WORK_ITEM_STATUSES, type WorkItemStatus } from "@ashara/delivery/work-item";
import { createWorkItemId, type WorkItemId } from "@ashara/shared";
import { sweepWorktreesAtStartup } from "./kept-worktrees.js";

let base: string | null = null;

afterEach(() => {
  if (base !== null) fs.rmSync(base, { recursive: true, force: true });
  base = null;
});

describe("sweepWorktreesAtStartup", () => {
  test("keeps the worktree of every open task Delivery's work items hold, a Failed one included, and removes a settled task's", async () => {
    const workdirBase = fs.mkdtempSync(path.join(os.tmpdir(), "kept-worktrees-"));
    base = workdirBase;
    const statusOf = new Map<WorkItemId, WorkItemStatus>(WORK_ITEM_STATUSES.map((status) => [createWorkItemId(), status]));
    for (const id of statusOf.keys()) fs.mkdirSync(path.join(workdirBase, `task-${id}`));
    const repo = {
      async listIdsByStatus(statuses: readonly WorkItemStatus[]): Promise<WorkItemId[]> {
        return [...statusOf].filter(([, status]) => statuses.includes(status)).map(([id]) => id);
      },
    };

    await sweepWorktreesAtStartup(workdirBase, repo);

    const kept = new Set(fs.readdirSync(workdirBase));
    const keptStatuses = [...statusOf].filter(([id]) => kept.has(`task-${id}`)).map(([, status]) => status);
    expect(keptStatuses.sort()).toEqual(["Blocked", "Failed", "InProgress", "Pending"]);
  });
});
