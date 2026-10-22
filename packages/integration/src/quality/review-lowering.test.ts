import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { ProjectHaltRepository, runAcceptanceSweeps, WorkItemRowRepository } from "@ashara/delivery";
import type { AcceptanceStore } from "@ashara/delivery";
import { createProjectWithTender, VisionRepository } from "@ashara/engagement";
import type { VisionSource } from "@ashara/engagement";
import { SecondOpinionUnavailable } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
import { SuiteReviewJudgementRepository, suiteReviewClaimsOf } from "@ashara/quality";
import type { SuiteReviewSource } from "@ashara/quality";
import { suiteReviewerFor } from "@ashara/quality/testing";
import { parseProjectId, parseWorkItemId } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createAcceptanceStore } from "@ashara/server/acceptance-store";
import { projectState } from "../simulator/project-state.js";

// A suite review's finding that a check task's checks may not decide a guarantee lowers only the
// checks that check task wrote, so a guarantee other passing checks decide is still judged pass; a
// finding that a check asks more than the vision lowers nothing; and a later review whose second
// opinion confirms an item on its check task clears what an earlier one left undecided there. Each
// case is a suite review recorded and an acceptance sweep judged over real Postgres; the sweep's
// cells are stood in. Every row belongs to a project this suite creates; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `review-lowering-test-${randomUUID().slice(0, 8)}`;
const MERGE = "a1".repeat(20);
const MAIN = "c3".repeat(20);
const TENDER = "A key store. Clients put and get keys. A deleted key is gone.";
const COMMAND = "sh checks/run.sh";

let db: ReturnType<typeof createDb>;
let clientId: string;

const G1: VisionSource = { type: "guarantee", id: "G1", text: "A get returns the value of the last put of its key.", observation: "output", interface: ["I1"], refutedBy: ["a get after a put prints another value"] };
const G2: VisionSource = { type: "guarantee", id: "G2", text: "A deleted key is gone.", observation: "exit-status", interface: ["I1"], refutedBy: ["a get after a delete exits 0"] };

/** A planned project in the guarantees form: each goal task Completed and merged, each with its own check task and one stored check ("works") deciding G1 and G2. */
interface ContractProject {
  readonly projectId: ProjectId;
  readonly goals: readonly string[];
  readonly checkTasks: readonly string[];
  readonly reviewTask: WorkItemId;
}

async function contractProject(goals: number): Promise<ContractProject> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  const quote = (text: string) => ({ kind: "tender" as const, quote: text });
  await new VisionRepository(db).create(project.id, {
    visionText: TENDER,
    summary: "A key store.",
    inferences: [],
    contract: {
      interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY; kv delete KEY", source: quote("Clients put and get keys.") }],
      guarantees: [
        { id: "G1", statement: G1.text, observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get after a put prints another value"], source: quote("Clients put and get keys.") },
        { id: "G2", statement: G2.text, observable: { interface: ["I1"], observation: "exit-status" }, refutedBy: ["a get after a delete exits 0"], source: quote("A deleted key is gone.") },
      ],
      exclusions: [],
    },
  });
  await db.execute(sql`WITH planned AS (INSERT INTO project_plans (project_id, first_planned_at) VALUES (${project.id}, now())) UPDATE projects SET workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const task = async (title: string, spec: unknown): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, task_spec, project_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${JSON.stringify(spec)}::jsonb, ${project.id})`);
    return id;
  };
  const workItems = new WorkItemRowRepository(db);
  const goalIds: string[] = [];
  const checkTaskIds: string[] = [];
  for (let n = 0; n < goals; n++) {
    const goal = await task(`Goal ${n + 1}`, { origin: "decomposition" });
    const checks = await task(`Checks for Goal ${n + 1}`, { origin: "check", checksFor: goal, visionItems: [G1.text, G2.text], sources: [G1, G2] });
    await workItems.recordMergeCommit(goal, MERGE, n === 0 ? "merged" : "already_delivered");
    await db.execute(sql`
      INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
      VALUES (${project.id}, ${goal}, ${checks}, 1, 'works', ${COMMAND}, '[]'::jsonb, ${"e".repeat(64)}, '["G1","G2"]'::jsonb)`);
    goalIds.push(goal);
    checkTaskIds.push(checks);
  }
  const reviewTask = await task("Review the plan's checks", { origin: "review", visionItems: [G1.text, G2.text], sources: [G1, G2] });
  return { projectId: parseProjectId(project.id, "test project"), goals: goalIds, checkTasks: checkTaskIds, reviewTask: parseWorkItemId(reviewTask, "test review task") };
}

/** The acceptance record of the one project a test sweeps: another test's project is never swept with its checks. */
function acceptanceStore(projectId: ProjectId): AcceptanceStore {
  const store = createAcceptanceStore(db);
  return { ...store, readyForAcceptance: async () => (await store.readyForAcceptance()).filter((ready) => ready.projectId === projectId) };
}

/** A stand-in sweep of the project's goal tasks on main: every stored check ran and passed. */
function passingSweep(project: ContractProject) {
  const projects = new ProjectHaltRepository(db);
  const checkOutcomes = project.goals.map((taskId, n) => ({
    taskId,
    revision: 1,
    checkTaskId: project.checkTasks[n] ?? "",
    name: "works",
    command: COMMAND,
    decides: ["G1", "G2"],
    outcome: "passed" as const,
  }));
  return {
    acceptance: acceptanceStore(project.projectId),
    containment: memoryStepContainment(() => true),
    acceptanceSweeper: {
      sweepForAcceptance: async () => ({
        kind: "ran" as const,
        passed: true,
        mainCommit: MAIN,
        environmentVersion: "v1",
        checkedTasks: project.goals,
        uncheckedTasks: [],
        publicInterface: { kind: "not-placeholder" as const },
        checkOutcomes,
        failedChecks: [],
        details: "all suites passed",
      }),
    },
    projectRepo: { block: projects.block.bind(projects) },
    eventStore: new EventStoreRepository(db),
    logger: recordingLogger(),
  };
}

async function statusOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT ${projectState} AS status FROM projects WHERE id = ${projectId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status ?? "(none)";
}

async function haltReasonOf(projectId: ProjectId): Promise<string | null> {
  const result = await db.execute(sql`SELECT reason FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ reason: z.string().nullable() })).parse(result.rows)[0]?.reason ?? null;
}

const storedCheck = z.object({ taskCheckId: z.string(), outcome: z.string(), class: z.string(), lowered: z.boolean() });

/** Whether each stored check the project's sweep recorded as deciding `guaranteeId` is lowered, in the order recorded. */
async function loweredOn(projectId: ProjectId, guaranteeId: string): Promise<boolean[]> {
  const result = await db.execute(sql`SELECT checks FROM guarantee_evidence WHERE project_id = ${projectId} AND guarantee_id = ${guaranteeId}`);
  const [row] = z.array(z.object({ checks: z.array(storedCheck) })).length(1).parse(result.rows);
  return (row?.checks ?? []).map((check) => check.lowered);
}

const undecidedRow = z.object({ checkTaskId: z.string(), itemId: z.string(), judgementId: z.string().nullable(), claimId: z.string().nullable(), clearedByClaimId: z.string().nullable() });

async function undecidedOf(projectId: ProjectId): Promise<Array<z.infer<typeof undecidedRow>>> {
  const result = await db.execute(sql`
    SELECT check_task_id AS "checkTaskId", item_id AS "itemId", judgement_id AS "judgementId", claim_id AS "claimId", cleared_by_claim_id AS "clearedByClaimId"
    FROM undecided_items WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(undecidedRow).parse(result.rows);
}

/**
 * An advisory undecided-item finding on G2 of one check task, as a first review whose second review
 * disagreed records it: the judgement and the undecided item it keeps.
 */
async function advisoryUndecided(project: ContractProject, checkTaskId: string): Promise<void> {
  const finding = JSON.stringify({ checkTasks: [checkTaskId], kind: "undecided-item", item: "G2", problem: "these checks send no invalid input", evidence: COMMAND });
  const judged = await db.execute(sql`
    INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
    VALUES (${project.projectId}, ${project.reviewTask}, ${checkTaskId}, NULL, 'advisory', 'second-opinion-disagreed', ${finding}::jsonb, '[]'::jsonb, 'p/opus', 'p/sonnet', 'same-family-other-model', '[]'::jsonb, 'Strong', 'Strong', 'equal', 'Frontier', 'Strong')
    RETURNING id`);
  const [judgement] = z.array(z.object({ id: z.string() })).length(1).parse(judged.rows);
  await db.execute(sql`
    INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text, judgement_id)
    VALUES (${project.projectId}, ${project.reviewTask}, ${checkTaskId}, 'G2', ${G2.text}, ${judgement?.id})`);
}

/** The project's one check task as the suite review reads it. */
function reviewSource(project: ContractProject, reviewReopens = 0): SuiteReviewSource {
  const [goal = "", checkTask = ""] = [project.goals[0], project.checkTasks[0]];
  return {
    checkTasksUnderReview: async () => [
      { id: checkTask, status: "Completed", checksFor: goal, visionItems: [G1.text, G2.text], sources: [G1, G2], checkedTitle: "Goal 1", reviewReopens, grade: "Strong", attemptModels: [] },
    ],
    latest: async () => ({ checkTaskId: checkTask, revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [{ name: "works", command: COMMAND, decides: ["G1", "G2"] }], files: [] }),
    frozen: async () => false,
  };
}

/** A review whose first answer is `first` and whose second opinion, from another model family, is `second`. */
function reviewed(first: readonly unknown[], second: readonly unknown[]): ContextualLlm {
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        const opinion = request.secondOpinion;
        if (opinion !== undefined && opinion.strength !== "other-family") throw new SecondOpinionUnavailable(opinion, request, []);
        const by = opinion === undefined ? { provider: "first", model: "strong-a" } : { provider: "second", model: "strong-b" };
        return { data: request.schema.parse({ problems: opinion === undefined ? first : second }), ...by, grade: "Frontier" as const };
      },
    }),
  };
}

async function review(project: ContractProject, llm: ContextualLlm, reviewReopens = 0) {
  const reviewer = suiteReviewerFor({ llm, source: reviewSource(project, reviewReopens), publicInterface: { at: async () => ({ kind: "absent" }) }, judgements: new SuiteReviewJudgementRepository(db) });
  return reviewer.review({ id: project.reviewTask, projectId: project.projectId, taskSpec: { origin: "review", visionItems: [G1.text, G2.text], sources: [G1, G2] } }, "/unused");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM undecided_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM suite_review_findings WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a suite review lowers a guarantee only on the checks its finding speaks of", () => {
  // An advisory finding that one check task's checks send no invalid input is about those checks;
  // twenty-one other passing checks still decide the guarantee.
  test("an advisory undecided item on one check task, with 21 other passing checks deciding the guarantee, leaves it pass and the project accepted", async () => {
    const project = await contractProject(22);
    await advisoryUndecided(project, project.checkTasks[0] ?? "");
    expect(await runAcceptanceSweeps(passingSweep(project))).toBe(1);
    expect(await statusOf(project.projectId)).toBe("accepted");
    const g2 = await loweredOn(project.projectId, "G2");
    expect(g2).toHaveLength(22);
    expect(g2.filter((lowered) => lowered)).toEqual([true]);
    expect(g2[0]).toBe(true);
    expect(await loweredOn(project.projectId, "G1")).toEqual(Array.from({ length: 22 }, () => false));
  });

  // Fail closed: with no other passing check to decide it, the finding still holds the guarantee back.
  test("the same finding on the one check task deciding the guarantee leaves it unjudged, lowered by review, and the project halted", async () => {
    const project = await contractProject(1);
    await advisoryUndecided(project, project.checkTasks[0] ?? "");
    expect(await runAcceptanceSweeps(passingSweep(project))).toBe(0);
    expect(await haltReasonOf(project.projectId)).toContain("G2 (unjudged, lowered-by-review)");
  });

  // A passing check that asks more than the vision proves more of its guarantee, never less.
  test("a second review's finding that a check asks more than the vision writes no undecided item, is kept advisory, and the guarantee passes", async () => {
    const project = await contractProject(1);
    const asksMore = {
      kind: "outside-vision",
      checkTasks: [project.checkTasks[0]],
      check: "works",
      judgedItems: ["G2"],
      missingClause: "the key's name in the error",
      problem: "works requires the key's name in the error, which no cited item asks for",
      evidence: COMMAND,
    };
    const outcome = await review(project, reviewed([], [asksMore]));
    expect(outcome).toMatchObject({ kind: "clean", undecided: [], claim: { basis: "second-opinion-clean", unconfirmed: [] } });
    expect(outcome.advisory).toEqual([expect.objectContaining({ kind: "outside-vision", checkTaskIds: [project.checkTasks[0]] })]);
    expect(await undecidedOf(project.projectId)).toEqual([]);
    const [claim] = await suiteReviewClaimsOf(db, project.projectId);
    expect(claim).toMatchObject({ basis: "second-opinion-clean", unverified: [], second: { kind: "answered", findings: [asksMore] } });

    expect(await runAcceptanceSweeps(passingSweep(project))).toBe(1);
    expect(await statusOf(project.projectId)).toBe("accepted");
    expect(await loweredOn(project.projectId, "G2")).toEqual([false]);
  });

  // The review that reopens a check task leaves an advisory item undecided on it; the review of the
  // rewritten checks, confirmed by its second opinion, clears it.
  test("an item left undecided by a review that reopened its check task is cleared by the later clean review, and the guarantee passes", async () => {
    const project = await contractProject(1);
    const checkTask = project.checkTasks[0] ?? "";
    const undecided = (item: string) => ({ kind: "undecided-item", checkTasks: [checkTask], item, problem: `no check decides ${item}`, evidence: COMMAND });
    const first = await review(project, reviewed([undecided("G1"), undecided("G2")], [undecided("G1")]));
    expect(first).toMatchObject({ kind: "problems", problems: [expect.objectContaining({ kind: "undecided-item", checkTaskIds: [checkTask] })] });
    expect(await undecidedOf(project.projectId)).toEqual([expect.objectContaining({ checkTaskId: checkTask, itemId: "G2", clearedByClaimId: null })]);

    const later = await review(project, reviewed([], []), 1);
    expect(later).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-clean", unconfirmed: [] } });
    const [claim] = z.array(z.object({ id: z.string() })).parse((await db.execute(sql`SELECT id FROM suite_review_claims WHERE project_id = ${project.projectId}`)).rows);
    expect(await undecidedOf(project.projectId)).toEqual([expect.objectContaining({ checkTaskId: checkTask, itemId: "G2", clearedByClaimId: claim?.id })]);

    expect(await runAcceptanceSweeps(passingSweep(project))).toBe(1);
    expect(await statusOf(project.projectId)).toBe("accepted");
    expect(await loweredOn(project.projectId, "G2")).toEqual([false]);
  });

  // The state machine is total: standing, cleared, standing again; a cleared row changes no more.
  test("a cleared item left undecided again stands on a new row, each claim reads its items once, and nothing but a clearing ever changes a row", async () => {
    const project = await contractProject(1);
    const checkTask = project.checkTasks[0] ?? "";
    const doubt = { kind: "undecided-item", checkTasks: [checkTask], item: "G2", problem: "no check deletes a key", evidence: COMMAND };
    await review(project, reviewed([], [doubt]));
    await review(project, reviewed([], []));
    await review(project, reviewed([], [doubt]));
    const rows = await undecidedOf(project.projectId);
    expect(rows.map((row) => [row.itemId, row.clearedByClaimId === null])).toEqual([
      ["G2", false],
      ["G2", true],
    ]);
    const claims = await suiteReviewClaimsOf(db, project.projectId);
    expect(claims.map((claim) => [claim.basis, claim.unverified.map((item) => item.itemId)])).toEqual([
      ["second-opinion-found", ["G2"]],
      ["second-opinion-clean", []],
      ["second-opinion-found", ["G2"]],
    ]);

    await expect(db.execute(sql`UPDATE undecided_items SET item_text = 'another text' WHERE project_id = ${project.projectId}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE undecided_items SET cleared_at = now() WHERE project_id = ${project.projectId} AND cleared_by_claim_id IS NOT NULL`)).rejects.toThrow();
    // A second standing row for the same check task and item is refused.
    await expect(advisoryUndecided(project, checkTask)).rejects.toThrow();

    expect(await runAcceptanceSweeps(passingSweep(project))).toBe(0);
    expect(await haltReasonOf(project.projectId)).toContain("G2 (unjudged, lowered-by-review)");
  });
});
