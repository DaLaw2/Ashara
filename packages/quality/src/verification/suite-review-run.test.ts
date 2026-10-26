import { describe, expect, test } from "vitest";
import { ModelCallAborted, PreCallRefusal } from "@ashara/finance";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { SuiteReviewing } from "../suite-review.js";
import { SuiteReviewRun } from "./suite-review-run.js";

type Outcome = Awaited<ReturnType<SuiteReviewing["review"]>>;

const task = { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 };
const reviewed = { reviewed: ["c1", "c2"], setAside: [], released: [], advisory: [], undecided: [] };

function run(review: () => Promise<Outcome>): { readonly job: SuiteReviewRun; readonly events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const job = new SuiteReviewRun({ suiteReview: { review }, logger: recordingLogger(), eventSink: { emit: (event) => void events.push(event) } });
  return { job, events };
}

describe("SuiteReviewRun", () => {
  test("a clean review completes the review task with the suites it read", async () => {
    const { job, events } = run(async () => ({
      ...reviewed,
      kind: "clean",
      claim: { basis: "second-opinion-clean", strength: null, why: "both reviews agree", unconfirmed: [] },
    }));
    const result = await job.reviewSuites(task, "s1", "/srv/target");
    expect(result.status).toBe("completed");
    expect(result.status === "completed" ? result.delivered : null).toEqual({ kind: "suites-reviewed", reviewed: ["c1", "c2"] });
    expect(events.map((event) => event.event)).toEqual(["suites_reviewed"]);
  });

  test("problems are returned for Delivery to route, naming each check task", async () => {
    const { job } = run(async () => ({
      ...reviewed,
      kind: "problems",
      problems: [{ checkTaskIds: ["c2"], kind: "contradiction", problem: "two checks disagree", evidence: "e" }],
    }));
    const result = await job.reviewSuites(task, "s1", "/srv/target");
    expect(result.status).toBe("suite_review_problems");
    expect(result.detail).toContain("1 problem(s) in the checks of c2");
  });

  test("a refused model call anywhere in the cause chain is a refusal, nothing reviewed", async () => {
    const { job } = run(async () => {
      throw new Error("review failed", { cause: new PreCallRefusal("spend cap reached") });
    });
    const result = await job.reviewSuites(task, "s1", "/srv/target");
    expect(result.status).toBe("refused");
    expect(result.detail).toContain("spend cap reached");
  });

  test("a model call the shutdown aborted interrupts the review: nothing was judged, so it neither fails nor blocks", async () => {
    const { job, events } = run(async () => {
      throw new ModelCallAborted({ stage: "in-flight", provider: "p", model: "m", callId: "call-1" }, new Error("SIGTERM"));
    });
    const result = await job.reviewSuites(task, "s1", "/srv/target");
    expect(result.status).toBe("interrupted");
    expect(result.detail).toContain("interrupted by shutdown");
    expect(events).toEqual([]);
  });

  test("Ashara's own failure blocks the review, never passes it", async () => {
    const { job } = run(async () => {
      throw new TypeError("store unreachable");
    });
    const result = await job.reviewSuites(task, "s1", "/srv/target");
    expect(result.status).not.toBe("completed");
    expect(result.status).not.toBe("failed");
  });
});
