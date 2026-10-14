import { describe, expect, test } from "vitest";
import { InvalidStatusTransition, parseProjectId } from "@ashara/shared";
import { exitDisputedCheck, exitStaleChecks, exitSuiteReview } from "./stale-checks.js";
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
      earlierFindings: new Map([[a.id, []], [b.id, []]]),
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

  // W11 (ADR-074 addendum 2 d89 F): rewrite 2's brief carried only review 2's finding, so the stale-lock and
  // interrupted-compact checks review 1 had it drop came back.
  test("a reopened check task's brief carries every earlier review's findings on it, not only the latest", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const exit = exitSuiteReview(review, new Map([[a.id, a]]), {
      problems: [{ checkTaskIds: [a.id], kind: "outside-vision", problem: "lib.sh runs a binary named kvstore", evidence: "lib.sh: ./kvstore" }],
      timesNamed: new Map([[a.id, 2]]),
      earlierFindings: new Map([
        [a.id, [{ kind: "outside-vision" as const, problem: "compact_interrupted requires an atomic rewrite", evidence: "compact.sh: kill -9" }]],
      ]),
    });

    expect(exit.kind).toBe("reopened");
    const brief = a.blockedReason?.source === "replan" ? a.blockedReason.replanContext.detail : "";
    expect(brief).toContain("Problem 1 (a check outside the task's cited vision items): lib.sh runs a binary named kvstore");
    expect(brief).toContain("Earlier reviews found these problems in this task's checks too");
    expect(brief).toContain("Earlier problem 1 (a check outside the task's cited vision items): compact_interrupted requires an atomic rewrite");
    expect(brief).toContain("Evidence: compact.sh: kill -9");
  });

  test("findings naming a check task with no record of its earlier reviews are refused before anything is reopened", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    expect(() =>
      exitSuiteReview(review, new Map([[a.id, a]]), {
        problems: [{ checkTaskIds: [a.id], kind: "contradiction", problem: "p", evidence: "e" }],
        timesNamed: new Map([[a.id, 1]]),
        earlierFindings: new Map(),
      }),
    ).toThrow(/no record of earlier reviews/);
    expect([review.status, a.status]).toEqual(["InProgress", "Completed"]);
  });

  test("a check task named a third time is past the bound: the review is given up and no check task is reopened", () => {
    const review = reviewTask();
    const a = checkTaskFor("impl-a");
    const b = checkTaskFor("impl-b");

    const exit = exitSuiteReview(review, new Map([[a.id, a], [b.id, b]]), {
      problems: [{ checkTaskIds: [a.id, b.id], kind: "contradiction", problem: "p", evidence: "e" }],
      timesNamed: new Map([[a.id, 1], [b.id, 3]]),
      earlierFindings: new Map([[a.id, []], [b.id, []]]),
    });

    expect(exit).toEqual({ kind: "bound", bound: 2, checkTaskId: b.id, times: 3 });
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
      earlierFindings: new Map([[a.id, []], [gone.id, []]]),
    });

    expect(exit.kind).toBe("unreopenable");
    expect(review.status).toBe("Abandoned");
    expect(review.blockedReason).toMatchObject({ source: "suite_review_unresolved", checkTaskIds: [a.id, gone.id] });
    expect(a.status).toBe("Completed");
  });
});


describe("exitDisputedCheck (ADR-074 addendum 2 d65 c, d76 K = 2)", () => {
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
