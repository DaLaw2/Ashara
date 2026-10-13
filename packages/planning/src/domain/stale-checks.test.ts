import { describe, expect, test } from "vitest";
import { InvalidStatusTransition, parseProjectId } from "@ashara/shared";
import { exitStaleChecks } from "./stale-checks.js";
import { createPendingWorkItem, startWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000bb");

function implementation(): WorkItem {
  const item = { ...createPendingWorkItem("Task", "write hello.txt", "run", PROJECT), workKind: "implementation" as const };
  startWorkItem(item);
  item.events = [];
  return item;
}

function completedCheckTask(): WorkItem {
  return { ...createPendingWorkItem("Task", "write the checks", "run", PROJECT), workKind: "check", status: "Completed" };
}

describe("exitStaleChecks", () => {
  test("a stale revision 2 still reopens the check task: its rewrite is the second, the bound", () => {
    const task = implementation();
    const check = completedCheckTask();

    expect(exitStaleChecks(task, check, { checkTaskId: check.id, revision: 2, detail: "red run" })).toEqual({ kind: "rewrite" });
    expect(task.status).toBe("Pending");
    expect(check.status).toBe("Pending");
    expect(check.events.map((e) => e.eventType)).toEqual(["work_item.reopened"]);
    expect(task.events.map((e) => e.eventType)).toEqual(["work_item.awaiting_checks"]);
  });

  test("a stale revision 3 is past the bound: the task is parked and the check task untouched", () => {
    const task = implementation();
    const check = completedCheckTask();

    expect(exitStaleChecks(task, check, { checkTaskId: check.id, revision: 3, detail: "red run" })).toEqual({ kind: "bound" });
    expect(task.blockedReason).toMatchObject({ source: "checks_rewrite_bound", revision: 3, bound: 2 });
    expect(check.status).toBe("Completed");
  });

  test("a task no longer InProgress: rejected before the check task is reopened", () => {
    const task = { ...implementation(), status: "Abandoned" as const };
    const check = completedCheckTask();

    expect(() => exitStaleChecks(task, check, { checkTaskId: check.id, revision: 1, detail: "red run" })).toThrow(InvalidStatusTransition);
    expect(check.status).toBe("Completed");
  });
});
