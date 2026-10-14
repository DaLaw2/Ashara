import { describe, expect, test } from "vitest";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { PreCallRefusal, StructuredOutputExhausted } from "@ashara/llm-gateway";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { SuiteReviewer } from "./suite-review.js";
import type { SuiteReviewSource } from "./suite-review.js";
import type { TaskChecks } from "./task-checks.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000cc", "test");
const REVIEW_ID = createWorkItemId();
const IMPL_A = createWorkItemId();
const IMPL_B = createWorkItemId();
const CHECK_A = "check-a";
const CHECK_B = "check-b";
const VISION = ["In: monthly totals of a CSV of expenses", "Malformed rows are refused with their line number"];

function stored(checkTaskId: string, name: string, command: string): TaskChecks {
  return { checkTaskId, revision: 1, environmentVersion: "v1", baselineCommit: "b".repeat(40), checks: [{ name, command }], files: [{ path: "checks/t.sh", content: "exit 1" }] };
}

function source(statusB = "Completed"): SuiteReviewSource {
  return {
    checkTasksUnderReview: async () => [
      { id: CHECK_A, status: "Completed", checksFor: IMPL_A, visionItems: [VISION[0] ?? ""], checkedTitle: "Sum by month" },
      { id: CHECK_B, status: statusB, checksFor: IMPL_B, visionItems: [VISION[1] ?? ""], checkedTitle: "Refuse bad rows" },
    ],
    latest: async (taskId) => (taskId === IMPL_A ? stored(CHECK_A, "prints-count", "sh checks/count.sh") : stored(CHECK_B, "stdout-empty", "sh checks/empty.sh")),
  };
}

/** Answers every structured call with the next scripted answer, parsed by the request's own schema. */
function scripted(answers: unknown[], prompts: string[] = []): ContextualLlm {
  let next = 0;
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        prompts.push(request.prompt);
        const answer = answers[Math.min(next, answers.length - 1)];
        next++;
        if (answer instanceof Error) throw answer;
        return { data: request.schema.parse(answer) };
      },
    }),
  };
}

const TASK = { id: REVIEW_ID, projectId: PROJECT, taskSpec: { origin: "review" as const, visionItems: VISION } };

describe("SuiteReviewer (ADR-074 addendum 2 d71 c)", () => {
  test("a clean verdict is accepted after its schema validates; the prompt holds every suite and the vision", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source() });

    expect(await reviewer.review(TASK)).toEqual({ kind: "clean", reviewed: [CHECK_A, CHECK_B], setAside: [] });
    expect(prompts).toHaveLength(1);
    for (const text of [...VISION, `## Check task ${CHECK_A}`, `## Check task ${CHECK_B}`, "sh checks/count.sh", "sh checks/empty.sh", "--- file checks/t.sh"]) {
      expect(prompts[0]).toContain(text);
    }
  });

  test("problems come back with the check tasks they name", async () => {
    const problem = { checkTasks: [CHECK_A, CHECK_B], kind: "contradiction", problem: "a prints a count, b requires empty stdout", evidence: "count.sh; empty.sh" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [problem] }]), source: source() });

    expect(await reviewer.review(TASK)).toEqual({
      kind: "problems",
      reviewed: [CHECK_A, CHECK_B],
      setAside: [],
      problems: [{ checkTaskIds: [CHECK_A, CHECK_B], kind: "contradiction", problem: problem.problem, evidence: problem.evidence }],
    });
  });

  test("a verdict naming a check task it did not read is re-asked, and one that never validates gives no verdict", async () => {
    const prompts: string[] = [];
    const ghost = { problems: [{ checkTasks: ["ghost"], kind: "contradiction", problem: "p", evidence: "e" }] };
    const reviewer = new SuiteReviewer({ llm: scripted([ghost], prompts), source: source() });

    await expect(reviewer.review(TASK)).rejects.toBeInstanceOf(StructuredOutputExhausted);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain('names check task "ghost"');
  });

  test("an answer that is not the schema is never read as a clean review", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ verdict: "looks fine" }]), source: source() });
    await expect(reviewer.review(TASK)).rejects.toThrow();
  });

  test("an unfinished check task fails the review instead of passing what it did not read", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }]), source: source("Pending") });
    await expect(reviewer.review(TASK)).rejects.toMatchObject({ name: "SuitesUnreadable" });
  });

  test("an Abandoned check task is set aside and the other suites are reviewed", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }]), source: source("Abandoned") });
    expect(await reviewer.review(TASK)).toEqual({ kind: "clean", reviewed: [CHECK_A], setAside: [CHECK_B] });
  });

  test("a review task with no vision items is refused before any model call", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source() });
    await expect(reviewer.review({ ...TASK, taskSpec: { origin: "review" } })).rejects.toMatchObject({ name: "SuitesUnreadable" });
    expect(prompts).toEqual([]);
  });

  test("a refused model call propagates as the refusal", async () => {
    const refusal = new PreCallRefusal("budget_cap: refused");
    const reviewer = new SuiteReviewer({ llm: scripted([refusal]), source: source() });
    await expect(reviewer.review(TASK)).rejects.toBe(refusal);
  });
});
