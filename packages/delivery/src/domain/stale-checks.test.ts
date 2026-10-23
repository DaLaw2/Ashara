import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { HELD_SET_RULE, heldSetRuleText } from "../acl/workplace-acl.js";
import { exitDisputedCheck, exitStaleChecks, exitSuiteReview } from "./stale-checks.js";
import { createPendingWorkItem, startWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000bb", "test");

function implementation(): WorkItem {
  const item = { ...createPendingWorkItem("Task", "write hello.txt", PROJECT), workKind: "implementation" as const };
  startWorkItem(item);
  item.events = [];
  return item;
}

function completedCheckTask(): WorkItem {
  return { ...createPendingWorkItem("Task", "write the checks", PROJECT), workKind: "check", status: "Completed" };
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
    expect(check.blockedReason).toMatchObject({ replanContext: { detail: expect.stringContaining(heldSetRuleText(HELD_SET_RULE)) } });
  });

  test("a stale revision 3 is past the bound: the task is given up and the check task untouched", () => {
    const task = implementation();
    const check = completedCheckTask();

    expect(exitStaleChecks(task, check, { checkTaskId: check.id, revision: 3, detail: "red run" })).toEqual({ kind: "bound" });
    expect(task.status).toBe("Abandoned");
    expect(task.blockedReason).toMatchObject({ source: "checks_rewrite_bound", revision: 3, bound: 2 });
    expect(task.events.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
    expect(check.status).toBe("Completed");
  });

  test("a check task that cannot be reopened gives the task up with checks_stale", () => {
    const task = implementation();
    const gone = { ...completedCheckTask(), status: "Abandoned" as const };

    expect(exitStaleChecks(task, gone, { checkTaskId: gone.id, revision: 1, detail: "red run" }).kind).toBe("unreopenable");
    expect(task.status).toBe("Abandoned");
    expect(task.blockedReason).toMatchObject({ source: "checks_stale", checkTaskId: gone.id });
  });

  test("a task no longer InProgress: rejected before the check task is reopened", () => {
    const task = { ...implementation(), status: "Abandoned" as const };
    const check = completedCheckTask();

    expect(() => exitStaleChecks(task, check, { checkTaskId: check.id, revision: 1, detail: "red run" })).toThrow(
      expect.objectContaining({ name: "InvalidStatusTransition", from: "Abandoned", to: "Pending" }),
    );
    expect(check.status).toBe("Completed");
  });

  test("a Pending task past the bound is not given up through a stale-checks exit", () => {
    const task = { ...implementation(), status: "Pending" as const };
    const check = completedCheckTask();

    expect(() => exitStaleChecks(task, check, { checkTaskId: check.id, revision: 3, detail: "red run" })).toThrow(
      expect.objectContaining({ name: "InvalidStatusTransition", from: "Pending", to: "Abandoned" }),
    );
    expect(task.status).toBe("Pending");
  });
});

function reviewTask(): WorkItem {
  const item = { ...createPendingWorkItem("Task", "review the checks", PROJECT, undefined, undefined, { origin: "review" }), workKind: "check" as const };
  startWorkItem(item);
  item.events = [];
  return item;
}

function checkTaskFor(checkedTaskId: string): WorkItem {
  return { ...completedCheckTask(), taskSpec: { origin: "check", checksFor: checkedTaskId } };
}

describe("exitSuiteReview: the plan review reopens the check tasks it names", () => {
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
      timesNamed: new Map([[a.id, 1], [b.id, 1]]),
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

  test("an undecided cited item is briefed as undecided and asks for a check added, never as a check outside the vision", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const exit = exitSuiteReview(review, new Map([[a.id, a]]), {
      problems: [{ checkTaskIds: [a.id], kind: "undecided-item", problem: "Cited item scope-1 is decided by none of the checks: no check reads a month's total", evidence: "sh checks/count.sh" }],
      timesNamed: new Map([[a.id, 1]]),
    });

    expect(exit.kind).toBe("reopened");
    const brief = a.blockedReason?.source === "replan" ? a.blockedReason.replanContext.detail : "";
    expect(brief).toContain("Problem 1 (a cited item no check decides): Cited item scope-1 is decided by none of the checks");
    expect(brief).toContain("add a check that decides a cited item no check decides");
    expect(brief).toContain("Keep every check that is not part of a problem.");
    expect(brief).not.toContain("outside the task's cited vision items");
    expect(brief).not.toContain("no vision item the task cites asks for");
  });

  test("a check that requires what a cited item rules out reopens its check task, briefed to keep the promise whatever the task's own lines say", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const exit = exitSuiteReview(review, new Map([[a.id, a]]), {
      problems: [{ checkTaskIds: [a.id], kind: "breaks-contract", problem: `Check "returned-late" requires what cited item G16 rules out`, evidence: "php overdue_report.php returned_late" }],
      timesNamed: new Map([[a.id, 1]]),
    });

    expect(exit.kind).toBe("reopened");
    expect(a.status).toBe("Pending");
    const brief = a.blockedReason?.source === "replan" ? a.blockedReason.replanContext.detail : "";
    expect(brief).toContain(`Problem 1 (a check that requires what a cited item rules out): Check "returned-late" requires what cited item G16 rules out`);
    expect(brief).toContain("so that a product keeping the promise passes it");
  });

  // A check task is reopened by its review at most once, counted from the durable record.
  test("a check task named a second time is past the bound: the review is given up and no check task is reopened", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const b = checkTaskFor("impl-b");

    const exit = exitSuiteReview(review, new Map([[a.id, a], [b.id, b]]), {
      problems: [{ checkTaskIds: [a.id, b.id], kind: "contradiction", problem: "p", evidence: "e" }],
      timesNamed: new Map([[a.id, 1], [b.id, 2]]),
    });

    expect(exit).toEqual({ kind: "bound", bound: 1, checkTaskId: b.id, times: 2 });
    expect([review.status, a.status, b.status]).toEqual(["Abandoned", "Completed", "Completed"]);
    expect(review.blockedReason).toMatchObject({ source: "suite_review_unresolved", checkTaskIds: [a.id, b.id] });
  });

  test("a named check task that cannot be reopened gives the review up, and no check task is reopened", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const gone = { ...checkTaskFor("impl-b"), status: "Abandoned" as const };

    const exit = exitSuiteReview(review, new Map([[a.id, a], [gone.id, gone]]), {
      problems: [{ checkTaskIds: [a.id, gone.id], kind: "contradiction", problem: "p", evidence: "e" }],
      timesNamed: new Map([[a.id, 1], [gone.id, 1]]),
    });

    expect(exit.kind).toBe("unreopenable");
    expect(review.status).toBe("Abandoned");
    expect(review.blockedReason).toMatchObject({ source: "suite_review_unresolved", checkTaskIds: [a.id, gone.id] });
    expect(a.status).toBe("Completed");
  });
});


describe("exitDisputedCheck: an implementer disputes one check task's checks at most K = 2 times", () => {
  const dispute = (checkTaskId: string, disputes: number) => ({
    checkTaskId,
    revision: 1,
    check: { name: "put", command: "sh checks/put.sh" },
    reason: "put cannot pass on correct work",
    evidence: null,
    disputes,
  });

  test("within the bound the check task is reopened with the dispute and the task waits on it", () => {
    const task = implementation();
    const check = completedCheckTask();
    expect(exitDisputedCheck(task, check, dispute(check.id, 2))).toEqual({ kind: "rewrite" });
    expect([task.status, check.status]).toEqual(["Pending", "Pending"]);
    expect(check.blockedReason).toMatchObject({ replanContext: { detail: expect.stringContaining(heldSetRuleText(HELD_SET_RULE)) } });
  });

  test("a dispute past the bound gives the task up for a plan repair, never waiting on a person", () => {
    const task = implementation();
    const check = completedCheckTask();
    expect(exitDisputedCheck(task, check, dispute(check.id, 3))).toEqual({ kind: "bound", bound: 2 });
    expect(task.status).toBe("Abandoned");
    expect(task.blockedReason).toMatchObject({ source: "check_disputed", checkTaskId: check.id, checkName: "put" });
    expect(check.status).toBe("Completed");
  });
});
