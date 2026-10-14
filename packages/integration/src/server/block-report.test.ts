import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, postPlanReport, ProjectRepository, SuiteReviewFindingRepository } from "@ashara/db";
import { BlockReports } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";
import { RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createBlockReportStore } from "@ashara/server/block-report-store";

// Story s-loop-never-stop-m1, migrations 040 and 048: every project halt is told to the client
// once, in plain words, stating its cause, and its end (an operator's unblock, or the substrate
// probe passing after an infrastructure halt) is recorded and told once. Every row belongs to a project this
// suite creates; the Liaison's due list is narrowed to them, and afterAll deletes them.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

async function newProject(): Promise<ProjectId> {
  const project = await new ProjectRepository(db).create(`block-report-test-${randomUUID().slice(0, 8)}`, clientId);
  ourProjects.add(project.id);
  return project.id;
}

function reports(): BlockReports {
  const store = createBlockReportStore(db);
  const ours: BlockReportStore = {
    ...store,
    dueReports: async () => (await store.dueReports()).filter((r) => ourProjects.has(r.projectId)),
  };
  return new BlockReports(ours);
}

const MessagesSchema = z.array(z.object({ body: z.string() }));

async function messagesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' ORDER BY created_at, id`);
  return MessagesSchema.parse(result.rows).map((row) => row.body);
}

const EpisodesSchema = z.array(
  z.object({
    kind: z.string(),
    endKind: z.string().nullable(),
    unblockedBy: z.string().nullable(),
    unblockReason: z.string().nullable(),
    reported: z.boolean(),
    resumedReported: z.boolean(),
  }),
);

async function episodesOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT kind, end_kind AS "endKind", unblocked_by AS "unblockedBy", unblock_reason AS "unblockReason",
           report_id IS NOT NULL AS "reported", resumed_report_id IS NOT NULL AS "resumedReported"
      FROM project_blocks WHERE project_id = ${projectId} ORDER BY blocked_at, id`);
  return EpisodesSchema.parse(result.rows);
}

async function statusOf(projectId: ProjectId): Promise<string | undefined> {
  const result = await db.execute(sql`SELECT status FROM projects WHERE id = ${projectId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status;
}

const budgetCap = { category: "budget_cap", errorClass: "BudgetExceeded", reason: "project cap $5 reached" } as const;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`block-report-test-${randomUUID()}`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  for (const id of ourProjects) {
    await db.execute(sql`DELETE FROM project_blocks WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM suite_review_findings WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM work_items WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a blocked project is told once; an operator's unblock is recorded and told once", () => {
  test("block, report, unblock, resumed report, block again: one report per episode", async () => {
    const projectId = await newProject();
    const projects = new ProjectRepository(db);

    await projects.block(projectId, budgetCap);
    await reports().runPending();
    await reports().runPending();

    // The cause told is the recorded one (story s-independent-verify-m1 W7), not a sentence per kind.
    expect(await messagesOf(projectId)).toEqual([expect.stringContaining("The cause, as Ashara recorded it: BudgetExceeded: project cap $5 reached")]);
    expect((await messagesOf(projectId))[0]).toContain("The budget set for this project has to be raised");

    await projects.unblock(projectId, "operator-a", "raised the project cap to $10");
    expect(await statusOf(projectId)).toBe("active");
    await reports().runPending();
    await reports().runPending();

    expect(await messagesOf(projectId)).toEqual([expect.any(String), expect.stringContaining("has resumed")]);
    expect(await episodesOf(projectId)).toEqual([
      {
        kind: "budget_cap",
        endKind: "unblocked",
        unblockedBy: "operator-a",
        unblockReason: "raised the project cap to $10",
        reported: true,
        resumedReported: true,
      },
    ]);

    await projects.block(projectId, { category: "configuration", errorClass: "ModelUnpriced", reason: "no price" });
    await reports().runPending();

    expect(await messagesOf(projectId)).toHaveLength(3);
    expect((await episodesOf(projectId)).map((e) => [e.kind, e.reported])).toEqual([
      ["budget_cap", true],
      ["configuration", true],
    ]);
  });

  test("unblocking a project that is not blocked throws and writes nothing", async () => {
    const projectId = await newProject();
    await expect(new ProjectRepository(db).unblock(projectId, "operator-a", "nothing")).rejects.toThrow(/not 'blocked'/);
    expect(await episodesOf(projectId)).toEqual([]);
  });

  test("no way back to work but the recorded unblock: a bare status write is refused", async () => {
    const projectId = await newProject();
    await new ProjectRepository(db).block(projectId, budgetCap);

    await expect(
      db.execute(sql`UPDATE projects SET status = 'active', blocked_category = NULL, blocked_error_class = NULL, blocked_reason = NULL
        WHERE id = ${projectId}`),
    ).rejects.toThrow();
    expect(await statusOf(projectId)).toBe("blocked");
  });

  test("a stopped first planning is told by its planning-stopped report alone; a later stop after an unblock is told again", async () => {
    const projectId = await newProject();
    const stop = () =>
      db.execute(sql`UPDATE projects SET status = 'blocked', plan_stopped_at = now(), plan_attempts = 3, plan_last_error = 'x'
        WHERE id = ${projectId}`);

    await stop();
    await reports().runPending();
    expect(await messagesOf(projectId)).toEqual([]);
    expect(await postPlanReport(db, projectId, "planning-stopped", "planning stopped")).toBe("posted");

    await new ProjectRepository(db).unblock(projectId, "operator-a", "fixed the model routing");
    const reset = await db.execute(sql`SELECT plan_stopped_at, plan_attempts, plan_last_error FROM projects WHERE id = ${projectId}`);
    expect(reset.rows).toEqual([{ plan_stopped_at: null, plan_attempts: 0, plan_last_error: null }]);
    await reports().runPending();

    await stop();
    await reports().runPending();
    await reports().runPending();

    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toContain("has resumed");
    expect(bodies[2]).toContain("could not turn this project's vision into a plan");
    // first planning's last error is what the episode recorded (migration 040's trigger).
    expect(bodies[2]).toContain("The cause, as Ashara recorded it: x");
  });
});

async function workItem(projectId: ProjectId, title: string, taskSpec: unknown = null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, run_scope, project_id)
    VALUES (${id}, 'Task', 'Pending', ${title}, ${JSON.stringify(taskSpec)}::jsonb, ${RUN_SCOPE_AD_HOC}, ${projectId})`);
  return id;
}

// Story s-loop-never-stop-m1 W6 (design P15, P17): the halt is told once, and it ends by itself.
describe("an infrastructure halt is told once with its cause, resumes by itself when the probe passes, and is told once again", () => {
  test("halt, report naming the task, probe resume with evidence, resumed report", async () => {
    const projectId = await newProject();
    const projects = new ProjectRepository(db);
    const task = await workItem(projectId, "Write the lock checks");
    await db.execute(sql`UPDATE work_items SET infrastructure_faults = 4 WHERE id = ${task}`);

    await projects.block(projectId, { category: "infrastructure", errorClass: "InfrastructureFaultBudgetSpent", reason: "task cell unavailable" });
    expect(await projects.listInfrastructureHalted()).not.toContain(projectId);
    await reports().runPending();
    await reports().runPending();
    expect(await projects.listInfrastructureHalted()).toContain(projectId);

    const [halted] = await messagesOf(projectId);
    // The recorded cause, not a sentence fixed for every infrastructure halt (M2 trial M3).
    expect(halted).toContain("The cause, as Ashara recorded it: InfrastructureFaultBudgetSpent: task cell unavailable");
    expect(halted).toContain("resumes this project by itself");

    expect(await projects.resumeFromInfrastructureHalt(projectId, "substrate answered: version 5.4")).toBe("resumed");
    expect(await statusOf(projectId)).toBe("active");
    expect(await projects.listInfrastructureHalted()).not.toContain(projectId);
    expect(await projects.resumeFromInfrastructureHalt(projectId, "again")).toBe("moved");
    const evidence = await db.execute(sql`SELECT end_kind, resume_evidence FROM project_blocks WHERE project_id = ${projectId}`);
    expect(evidence.rows).toEqual([{ end_kind: "probe_passed", resume_evidence: "substrate answered: version 5.4" }]);

    await reports().runPending();
    await reports().runPending();
    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("the machines Ashara runs the work on work again");
    expect(await episodesOf(projectId)).toEqual([expect.objectContaining({ kind: "infrastructure", endKind: "probe_passed", reported: true, resumedReported: true })]);
  });

  test("in the core loop's order, a halt the probe could end at once is still told before it resumes", async () => {
    const projectId = await newProject();
    const projects = new ProjectRepository(db);
    const task = await workItem(projectId, "Start the task cell");
    await db.execute(sql`UPDATE work_items SET infrastructure_faults = 4 WHERE id = ${task}`);
    await projects.block(projectId, { category: "infrastructure", errorClass: "InfrastructureFaultBudgetSpent", reason: "task cell unavailable" });

    // Next cycle: the probe passes before the reports run.
    expect(await projects.listInfrastructureHalted()).not.toContain(projectId);
    expect(await projects.resumeFromInfrastructureHalt(projectId, "substrate answered")).toBe("unreported");
    expect(await statusOf(projectId)).toBe("blocked");
    await reports().runPending();

    // The cycle after: the halt is told, so it resumes and that is told too.
    expect(await projects.listInfrastructureHalted()).toContain(projectId);
    expect(await projects.resumeFromInfrastructureHalt(projectId, "substrate answered")).toBe("resumed");
    await reports().runPending();

    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("InfrastructureFaultBudgetSpent: task cell unavailable");
    expect(bodies[1]).toContain("the machines Ashara runs the work on work again");
  });

  test("a probe never ends any other halt", async () => {
    const projectId = await newProject();
    const projects = new ProjectRepository(db);
    await projects.block(projectId, budgetCap);
    expect(await projects.listInfrastructureHalted()).not.toContain(projectId);
    expect(await projects.resumeFromInfrastructureHalt(projectId, "probe passed")).toBe("moved");
    expect(await statusOf(projectId)).toBe("blocked");
    await expect(db.execute(sql`UPDATE project_blocks SET ended_at = now(), end_kind = 'probe_passed', resume_evidence = 'x' WHERE project_id = ${projectId}`)).rejects.toThrow();
  });
});

// Story s-loop-never-stop-m1 W6 (migration 048): every give-up opens a plan repair; R = 2 then one undeliverable report.
describe("every task given up opens a plan repair, and the undeliverable halt names each and why", () => {
  async function giveUp(id: string, reason: unknown): Promise<void> {
    await db.execute(sql`UPDATE work_items SET status = 'Abandoned', blocked_reason = ${JSON.stringify(reason)}::jsonb WHERE id = ${id}`);
  }

  test("each cause but a supersession opens one repair row; the halt's report states each cause in plain words", async () => {
    const projectId = await newProject();
    const disputed = await workItem(projectId, "Compact the log");
    const review = await workItem(projectId, "Review the plan's checks", { origin: "review" });
    const attempts = await workItem(projectId, "Lock the data directory");
    const superseded = await workItem(projectId, "Replaced work");
    await giveUp(disputed, { source: "check_disputed", checkTaskId: randomUUID(), checkName: "compacts", reason: "past the bound" });
    await giveUp(review, { source: "suite_review_unresolved", checkTaskIds: [randomUUID()], reason: "past the bound" });
    await giveUp(attempts, { source: "failure_router", reason: "max_attempts" });
    await giveUp(superseded, { source: "superseded", planRevision: 2, requestedBy: null, repairOf: [attempts], reason: "replaced" });

    const repairs = await db.execute(sql`SELECT work_item_id FROM plan_repairs WHERE project_id = ${projectId} ORDER BY work_item_id`);
    expect(repairs.rows.map((row) => row["work_item_id"]).sort()).toEqual([disputed, review, attempts].sort());

    await new ProjectRepository(db).block(projectId, { category: "plan_repair", errorClass: "PlanRepairBoundReached", reason: "repaired twice" });
    await reports().runPending();
    await reports().runPending();

    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("cannot deliver it as planned");
    // Each cause as its blocked_reason recorded it (story s-independent-verify-m1 W7).
    expect(bodies[0]).toContain(`"Compact the log", after 0 attempts. As recorded: check "compacts" disputed: past the bound`);
    expect(bodies[0]).toContain(`"Review the plan's checks", after 0 attempts. As recorded: past the bound`);
    expect(bodies[0]).toContain(`"Lock the data directory", after 0 attempts. As recorded: max_attempts`);
    expect(bodies[0]).not.toContain("Replaced work");
  });
});

// ADR-074 addendum 2 d71 c (fifth run N20): a suite_review halt recorded before migration 048 is
// still told once, with the last review's problems.
describe("a suite review halt recorded before migration 048 is told once", () => {
  test("the counts per check task survive in the record, and the block's report states the last review's problems", async () => {
    const projectId = await newProject();
    const review = await workItem(projectId, "Review the plan's checks", { origin: "review" });
    const checkA = await workItem(projectId, "Write the checks for a", { origin: "check" });
    const checkB = await workItem(projectId, "Write the checks for b", { origin: "check" });
    const findings = new SuiteReviewFindingRepository(db);
    const problem = "the checks of a print a column count that the checks of b forbid on stdout";

    expect(
      await findings.record({ projectId, reviewTaskId: review, problems: [{ checkTaskIds: [checkA], kind: "outside-vision", problem: "first", evidence: "e" }] }),
    ).toEqual(new Map([[checkA, 1]]));
    await findings.record({ projectId, reviewTaskId: review, problems: [{ checkTaskIds: [checkA], kind: "outside-vision", problem: "second", evidence: "e" }] });
    const third = await findings.record({
      projectId,
      reviewTaskId: review,
      problems: [{ checkTaskIds: [checkA, checkB], kind: "contradiction", problem, evidence: "wc -l; test -z" }],
    });
    expect(third).toEqual(new Map([[checkA, 3], [checkB, 1]]));

    await new ProjectRepository(db).block(projectId, { category: "suite_review", errorClass: "SuiteReviewBoundReached", reason: "named 3 times" });
    await reports().runPending();
    await reports().runPending();

    expect(await statusOf(projectId)).toBe("blocked");
    expect(await episodesOf(projectId)).toEqual([expect.objectContaining({ kind: "suite_review", reported: true })]);
    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("after 3 reviews");
    expect(bodies[0]).toContain(`- ${problem}`);
    expect(bodies[0]).not.toContain("first");
    expect(bodies[0]).not.toContain(checkA);
  });
});
