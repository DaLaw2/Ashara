import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { PlanningService, WorkItemRowRepository, adaptWorkItemRepo, exitSuiteReview } from "@ashara/delivery";
import type { ContextualLlm } from "@ashara/finance";
import { suiteReviewerFor } from "@ashara/quality/testing";
import type { SuiteReviewSource } from "@ashara/quality";
import { parseProjectId, parseWorkItemId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";

// A check that requires what a guarantee its task cites lists as refuting it is a suite-review
// finding of its own kind, and the review's exit reopens that check task on it: Quality's review
// read with a stand-in model, Delivery's exit against Postgres. Every row belongs to a project this
// suite creates, and afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `suite-review-reopen-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: ProjectId;

const GUARANTEE = {
  type: "guarantee" as const,
  id: "G16",
  text: "The overdue report lists every loan past its due date",
  observation: "output" as const,
  interface: ["I3"],
  refutedBy: ["The report includes a non-overdue loan"],
};

async function task(title: string, status: string, spec: unknown): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, task_spec, work_kind, owner_role_id)
    VALUES (${id}, 'Task', ${status}, ${title}, ${projectId}, ${JSON.stringify(spec)}::jsonb, 'check', ${randomUUID()})`);
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = parseProjectId((await new ProjectRepository(db).create(NAME, clientId)).id, "test project");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a check that breaks the contract", () => {
  test("a review that finds a check requiring what a cited guarantee's refutedBy names reopens that check task (Completed -> Pending)", async () => {
    const impl = randomUUID();
    const checkTask = await task("Write the checks for the overdue report", "Completed", { origin: "check", checksFor: impl, visionItems: [GUARANTEE.text], sources: [GUARANTEE] });
    const reviewTask = await task("Review the plan's checks together against the vision", "InProgress", { origin: "review", visionItems: [GUARANTEE.text], sources: [GUARANTEE] });
    const source: SuiteReviewSource = {
      checkTasksUnderReview: async () => [
        { id: checkTask, status: "Completed", checksFor: impl, visionItems: [GUARANTEE.text], sources: [GUARANTEE], checkedTitle: "Report overdue loans", reviewReopens: 0, grade: "Strong", attemptModels: [] },
      ],
      latest: async () => ({
        checkTaskId: checkTask,
        revision: 1,
        environmentVersion: "v1",
        baselineCommit: null,
        checks: [{ name: "returned-late", command: "php overdue_report.php returned_late", decides: ["G16"] }],
        files: [],
      }),
      frozen: async () => false,
    };
    const breach = {
      checkTasks: [checkTask],
      kind: "breaks-contract",
      check: "returned-late",
      item: "G16",
      clause: "includes a non-overdue loan",
      problem: "returned-late requires a loan already returned to be listed",
      evidence: "php overdue_report.php returned_late",
    };
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => ({
          data: request.schema.parse({ problems: [breach] }),
          ...(request.secondOpinion === undefined ? { provider: "first", model: "strong-a", grade: "Frontier" as const } : { provider: "second", model: "strong-b", grade: "Frontier" as const }),
        }),
      }),
    };
    const reviewer = suiteReviewerFor({ llm, source, publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: { record: async () => {} } });

    const outcome = await reviewer.review({ id: parseWorkItemId(reviewTask, "test"), projectId, taskSpec: { origin: "review", visionItems: [GUARANTEE.text], sources: [GUARANTEE] } }, "/unused");
    if (outcome.kind !== "problems") return expect.unreachable("an agreed breach of the contract is routed");

    const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
    const review = await PlanningService.findWorkItem(repo, parseWorkItemId(reviewTask, "test"));
    const check = await PlanningService.findWorkItem(repo, parseWorkItemId(checkTask, "test"));
    if (review === null || check === null) return expect.unreachable("both tasks were written");
    const exit = exitSuiteReview(review, new Map([[check.id, check]]), { problems: outcome.problems, timesNamed: new Map([[check.id, 1]]) });
    expect(exit).toMatchObject({ kind: "reopened" });
    await PlanningService.saveWorkItem(repo, check, "Completed");
    await PlanningService.saveWorkItem(repo, review, "InProgress");

    const reopened = await PlanningService.findWorkItem(repo, parseWorkItemId(checkTask, "test"));
    expect(reopened?.status).toBe("Pending");
    const brief = reopened?.blockedReason?.source === "replan" ? reopened.blockedReason.replanContext.detail : "";
    expect(brief).toContain("a check that requires what a cited item rules out");
    expect(brief).toContain(`Check "returned-late" requires what cited item G16 rules out, "includes a non-overdue loan"`);
    expect((await PlanningService.findWorkItem(repo, parseWorkItemId(reviewTask, "test")))?.status).toBe("Pending");
  });
});
