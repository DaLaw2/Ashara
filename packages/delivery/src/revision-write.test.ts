import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { isGoalTask } from "./predicates.js";
import { createPendingWorkItem } from "./domain/work-item.js";
import type { WorkItem } from "./domain/work-item.js";
import { setAsideWork } from "./revision-write.js";
import type { StoredTaskSpec } from "./work-item-language/task-spec.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000cc", "test");

function task(title: string, workKind: WorkItem["workKind"], taskSpec?: StoredTaskSpec): WorkItem {
  return { ...createPendingWorkItem("Task", title, PROJECT, undefined, undefined, taskSpec), workKind };
}

describe("setAsideWork: a revision names the superseded goal tasks by the one definition", () => {
  // Each task below but the first two is one a work-kind denylist (no check, environment, sprint0,
  // product-scaffold or acceptance) would name as a goal task: none of them is one by isGoalTask.
  test("only a Task the decomposition wrote is named; every other superseded task is counted", () => {
    const tasks = [
      task("Store keys", "implementation", { origin: "decomposition" }),
      task("Delete keys", null, { origin: "decomposition" }),
      task("Review the plan's checks", null, { origin: "review" }),
      task("Change the environment", "implementation", { origin: "environment-change" }),
      task("A task planned before its origin was recorded", "implementation"),
      task("Write the checks", "check", { origin: "check" }),
    ];

    expect(setAsideWork(tasks)).toEqual({ supersededTasks: ["Store keys", "Delete keys"], supersededOther: 4 });
    expect(setAsideWork(tasks).supersededTasks).toEqual(
      tasks.filter((item) => isGoalTask({ level: item.level, origin: item.taskSpec?.origin ?? null })).map((item) => item.title),
    );
  });
});
