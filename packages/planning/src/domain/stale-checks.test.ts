import { describe, expect, test } from "vitest";
import { InvalidStatusTransition, parseProjectId } from "@ashara/shared";
import { exitStaleChecks, exitSuiteReview } from "./stale-checks.js";
import { createPendingWorkItem, startWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000bb", "test");

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

function reviewTask(): WorkItem {
  const item = { ...createPendingWorkItem("Task", "review the checks", "run", PROJECT, undefined, undefined, { origin: "review" }), workKind: "check" as const };
  startWorkItem(item);
  item.events = [];
  return item;
}

function checkTaskFor(checkedTaskId: string): WorkItem {
  return { ...completedCheckTask(), taskSpec: { origin: "check", checksFor: checkedTaskId } };
}

describe("exitSuiteReview (ADR-074 addendum 2 d71 c)", () => {
  test("problems reopen every named check task with its own problems in its brief; the review waits on them at Pending", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const b = checkTaskFor("impl-b");
    const c = checkTaskFor("impl-c");
    const problems = [
      { checkTaskIds: [a.id, b.id], kind: "contradiction" as const, problem: "a prints a count that b forbids", evidence: "a: wc -l; b: test -z" },
      { checkTaskIds: [b.id], kind: "outside-vision" as const, problem: "b checks a column count nobody asked for", evidence: "b: grep 3" },
    ];

    const exit = exitSuiteReview(review, new Map([[a.id, a], [b.id, b], [c.id, c]]), {
      problems,
      timesNamed: new Map([[a.id, 1], [b.id, 2]]),
    });

    expect(exit).toEqual({ kind: "reopened", checkTasks: [a, b] });
    expect([a.status, b.status, c.status]).toEqual(["Pending", "Pending", "Completed"]);
    expect(review.status).toBe("Pending");
    expect(review.events.map((e) => e.eventType)).toEqual(["work_item.awaiting_checks"]);
    const briefOf = (item: WorkItem) => (item.blockedReason?.source === "replan" ? item.blockedReason.replanContext.detail : "");
    expect(briefOf(a)).toContain("a prints a count that b forbids");
    expect(briefOf(a)).toContain(`It also involves the checks of check task(s) ${b.id}.`);
    expect(briefOf(a)).not.toContain("column count");
    expect(briefOf(b)).toContain("b checks a column count nobody asked for");
    expect(a.blockedReason).toMatchObject({ source: "replan", replanContext: { raw: { checkedTaskId: "impl-a", reviewTaskId: review.id } } });
  });

  test("a check task named a third time is past the bound: nothing is mutated and the caller blocks the project", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const b = checkTaskFor("impl-b");

    const exit = exitSuiteReview(review, new Map([[a.id, a], [b.id, b]]), {
      problems: [{ checkTaskIds: [a.id, b.id], kind: "contradiction", problem: "p", evidence: "e" }],
      timesNamed: new Map([[a.id, 1], [b.id, 3]]),
    });

    expect(exit).toEqual({ kind: "bound", bound: 2, checkTaskId: b.id, times: 3 });
    expect([review.status, a.status, b.status]).toEqual(["InProgress", "Completed", "Completed"]);
  });

  test("a named check task that cannot be reopened parks the review, and no check task is reopened", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const gone = { ...checkTaskFor("impl-b"), status: "Abandoned" as const };

    const exit = exitSuiteReview(review, new Map([[a.id, a], [gone.id, gone]]), {
      problems: [{ checkTaskIds: [a.id, gone.id], kind: "contradiction", problem: "p", evidence: "e" }],
      timesNamed: new Map([[a.id, 1], [gone.id, 1]]),
    });

    expect(exit.kind).toBe("unreopenable");
    expect(review.status).toBe("Blocked");
    expect(review.blockedReason).toMatchObject({ source: "suite_review_unresolved", checkTaskIds: [a.id, gone.id] });
    expect(a.status).toBe("Completed");
  });
});

