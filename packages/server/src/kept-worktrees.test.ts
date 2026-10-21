import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WORK_ITEM_STATUSES, type WorkItemStatus } from "@ashara/delivery/work-item";
import { sweepOrphanedWorktrees } from "@ashara/execution-infra";
import { createWorkItemId, type WorkItemId } from "@ashara/shared";
import { keptWorktreeTaskIds } from "./kept-worktrees.js";

let base: string | null = null;

afterEach(() => {
  if (base !== null) fs.rmSync(base, { recursive: true, force: true });
  base = null;
});

describe("keptWorktreeTaskIds", () => {
  test("the startup sweep keeps the worktree of every open task, a Failed one included, and removes a settled task's", async () => {
    const workdirBase = fs.mkdtempSync(path.join(os.tmpdir(), "kept-worktrees-"));
    base = workdirBase;
    const statusOf = new Map<WorkItemId, WorkItemStatus>(WORK_ITEM_STATUSES.map((status) => [createWorkItemId(), status]));
    for (const id of statusOf.keys()) fs.mkdirSync(path.join(workdirBase, `task-${id}`));
    const repo = {
      async listIdsByStatus(statuses: readonly WorkItemStatus[]): Promise<WorkItemId[]> {
        return [...statusOf].filter(([, status]) => statuses.includes(status)).map(([id]) => id);
      },
    };

    await sweepOrphanedWorktrees(workdirBase, keptWorktreeTaskIds(repo));

    const kept = new Set(fs.readdirSync(workdirBase));
    const keptStatuses = [...statusOf].filter(([id]) => kept.has(`task-${id}`)).map(([, status]) => status);
    expect(keptStatuses.sort()).toEqual(["Blocked", "Failed", "InProgress", "Pending"]);
  });
});
