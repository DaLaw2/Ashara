import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { DevSessionRepository } from "@ashara/workplace";
import type { DbTransaction, Database } from "@ashara/db";
import { PlanReports } from "@ashara/engagement";
import type { PlanReportStore } from "@ashara/engagement";
import { reconcileWorkItemsOnStartup, FailureRouter, PlanningService, adaptWorkItemRepo, failWorkItem, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import type { WorkItemRepository as WorkItemPort } from "@ashara/delivery";
import { parseWorkItemId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { ProjectId } from "@ashara/shared";
import { createPlanReportStore } from "@ashara/server/plan-report-store";
import { projectState } from "../simulator/project-state.js";

// One project's bad record blocks that project, with
// the cause on its row, and the other projects proceed. Every row belongs to a
// project this suite creates under a unique name; afterAll deletes them. A
// corrupt jsonb row is only ever written inside a transaction rolled back at the
// end of its test: committed, it would fail other suites' reads of work_items.
// Every step is narrowed to this suite's projects, so no other project is read,
// reported on or blocked.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `project-block-test-${randomUUID().slice(0, 8)}`;

type Handle = Database | DbTransaction;

let db: Database;
let clientId: string;
const ourProjects = new Set<string>();

interface TaskRow {
  readonly status?: string;
  readonly taskSpec?: unknown;
  readonly successCriteria?: unknown;
  readonly blockedReason?: unknown;
}

/** The environment task every reportable first plan holds. */
const SPRINT0: TaskRow = { taskSpec: { origin: "sprint0", checkedBy: "substrate" } };
/** The check task a reportable first plan holds for each decomposed task. */
const CHECKS: TaskRow = { taskSpec: { origin: "check" } };
/** The review of every check task a reportable first plan holds. */
const REVIEW: TaskRow = { taskSpec: { origin: "review" } };
/** The product scaffold every reportable first plan holds. */
const SCAFFOLD: TaskRow = { taskSpec: { origin: "product-scaffold", checkedBy: "substrate" } };

const jsonb = (value: unknown) => (value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`);

/** A project with one epic and one task per row given; planned when `planned`. */
async function projectWith(handle: Handle, tasks: readonly TaskRow[], planned: boolean) {
  const project = await new ProjectHaltRepository(handle).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  ourProjects.add(project.id);
  const epicId = randomUUID();
  await handle.execute(sql`
    INSERT INTO work_items (id, level, title, project_id)
    VALUES (${epicId}, 'Epic', 'Epic', ${project.id})`);
  const taskIds: string[] = [];
  for (const task of tasks) {
    const taskId = randomUUID();
    taskIds.push(taskId);
    await handle.execute(sql`
      INSERT INTO work_items (id, level, status, parent_id, title, task_spec, success_criteria, blocked_reason, project_id)
      VALUES (${taskId}, 'Task', ${task.status ?? "Pending"}, ${epicId}, ${`Task ${taskId}`}, ${jsonb(task.taskSpec)},
              ${jsonb(task.successCriteria)}, ${jsonb(task.blockedReason)}, ${project.id})`);
  }
  if (planned) {
    await handle.execute(sql`
      INSERT INTO project_plans (project_id, first_planned_at, plan_dropped_dependencies) VALUES (${project.id}, now(), '[]'::jsonb)`);
  }
  return { projectId: project.id, taskIds };
}

const ProjectStateSchema = z.array(
  z.object({ status: z.string(), errorClass: z.string().nullable(), reason: z.string().nullable() }),
);

async function stateOf(handle: Handle, projectId: ProjectId) {
  const result = await handle.execute(sql`
    SELECT ${projectState} AS status, (SELECT b.error_class FROM project_blocks b WHERE b.project_id = projects.id AND b.ended_at IS NULL) AS "errorClass", (SELECT b.reason FROM project_blocks b WHERE b.project_id = projects.id AND b.ended_at IS NULL) AS "reason" FROM projects WHERE id = ${projectId}`);
  return ProjectStateSchema.parse(result.rows)[0];
}

async function statusOf(handle: Handle, itemId: string) {
  const result = await handle.execute(sql`SELECT status FROM work_items WHERE id = ${itemId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status;
}

/** The gate's view of project status, narrowed to this suite's projects. */
function ourActiveProjects(handle: Handle) {
  const projects = new ProjectHaltRepository(handle);
  return {
    listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)),
    block: projects.block.bind(projects),
  };
}

function reports(handle: Handle): PlanReports {
  const store = createPlanReportStore(handle);
  const ours: PlanReportStore = {
    ...store,
    dueReports: async () => (await store.dueReports()).filter((r) => ourProjects.has(r.projectId)),
    dueRevisionReports: async () => (await store.dueRevisionReports()).filter((r) => ourProjects.has(r.projectId)),
  };
  return new PlanReports(ours, memoryStepContainment(() => true));
}

async function gate(handle: Handle) {
  return (await PlanningService.gate(adaptWorkItemRepo(new WorkItemRowRepository(handle)), ourActiveProjects(handle), { publish: async () => {} }, memoryStepContainment(() => true), recordingLogger())).available;
}

/** Rolls the probe transaction back once its assertions have run. */
class ProbeRollback extends Error {
  constructor() {
    super("probe transaction rolled back on purpose");
    this.name = "ProbeRollback";
  }
}

async function inRolledBackTransaction(fn: (tx: DbTransaction) => Promise<void>): Promise<void> {
  const probe = db.transaction(async (tx) => {
    await fn(tx);
    throw new ProbeRollback();
  });
  await expect(probe).rejects.toBeInstanceOf(ProbeRollback);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("one project's bad record in a cycle", () => {
  test("an unfounded first plan blocks only its project; the healthy project is reported and gated in the same cycle", async () => {
    const healthy = await projectWith(db, [{ taskSpec: { origin: "decomposition" } }, CHECKS, SPRINT0, SCAFFOLD, REVIEW], true);
    // A task with no recorded origin: the Liaison cannot report the plan truthfully.
    const bad = await projectWith(db, [{ taskSpec: { goal: "Set up the studio list." } }, SPRINT0], true);

    // The cycle's order: the Liaison's reports, then gating.
    const outcomes = await reports(db).runPending();
    const eligible = await gate(db);

    expect(outcomes).toHaveLength(2);
    expect(outcomes).toContainEqual({ kind: "posted", projectId: healthy.projectId, subject: "first-plan" });
    expect(outcomes).toContainEqual({
      kind: "project-blocked",
      projectId: bad.projectId,
      cause: { category: "fault", errorClass: "PlanReportUnfounded", reason: expect.stringMatching(/^PlanReportUnfounded: /) },
    });
    expect(await stateOf(db, bad.projectId)).toEqual({
      status: "blocked",
      errorClass: "PlanReportUnfounded",
      reason: expect.stringMatching(/1 task\(s\) of unrecorded origin/),
    });
    expect(await stateOf(db, healthy.projectId)).toEqual({ status: "active", errorClass: null, reason: null });

    // Both tasks are Pending Tasks with no dependencies: only the project's status keeps one out.
    const eligibleIds = eligible.map((item) => item.id);
    expect(eligibleIds).toContain(healthy.taskIds[0]);
    expect(eligibleIds).not.toContain(bad.taskIds[0]);

    // A blocked project is not reported on again, so it is not re-blocked every cycle.
    expect(await reports(db).runPending()).toEqual([]);
  });

  test.each([
    ["task_spec", { taskSpec: { origin: 7 } }],
    ["success_criteria", { successCriteria: [1] }],
    ["blocked_reason", { blockedReason: { source: "no-such-producer" } }],
  ] as const)("a corrupt %s row blocks only its project in gating", async (column, corrupt) => {
    await inRolledBackTransaction(async (tx) => {
      const healthy = await projectWith(tx, [{}], false);
      const bad = await projectWith(tx, [{}, corrupt], false);

      const eligible = await gate(tx);

      expect(eligible.map((item) => item.id)).toEqual([healthy.taskIds[0]]);
      expect(await stateOf(tx, bad.projectId)).toEqual({
        status: "blocked",
        errorClass: "WorkItemRowCorrupt",
        reason: expect.stringContaining(`work item ${bad.taskIds[1]} (project ${bad.projectId}): ${column} does not parse`),
      });
      expect(await stateOf(tx, healthy.projectId)).toMatchObject({ status: "active" });
    });
  });

  test("a corrupt row in a planned project blocks it at reporting instead of failing every project's reports", async () => {
    await inRolledBackTransaction(async (tx) => {
      const founded = await projectWith(tx, [{ taskSpec: { origin: "decomposition" } }, CHECKS, SPRINT0, SCAFFOLD, REVIEW], true);
      const corrupt = await projectWith(tx, [{ taskSpec: { origin: "decomposition" }, successCriteria: "not a list" }], true);

      const outcomes = await reports(tx).runPending();

      expect(outcomes).toHaveLength(2);
      expect(outcomes).toContainEqual({ kind: "posted", projectId: founded.projectId, subject: "first-plan" });
      expect(outcomes).toContainEqual({
        kind: "project-blocked",
        projectId: corrupt.projectId,
        cause: { category: "fault", errorClass: "WorkItemRowCorrupt", reason: expect.stringContaining("success_criteria does not parse") },
      });
    });
  });

  test("a Pending task of a blocked project is never admitted by the gate", async () => {
    const project = await projectWith(db, [{ taskSpec: { origin: "decomposition" } }], false);
    expect((await gate(db)).map((item) => item.id)).toEqual(project.taskIds);

    await new ProjectHaltRepository(db).block(project.projectId, { category: "fault", errorClass: "TestBlock", reason: "blocked by the test" });

    expect(await gate(db)).toEqual([]);
  });
});

describe("one project's bad record at startup", () => {
  test("a corrupt InProgress row blocks only its project; the other project's orphan is requeued", async () => {
    await inRolledBackTransaction(async (tx) => {
      const bad = await projectWith(tx, [{ status: "InProgress" }, { status: "InProgress", successCriteria: { not: "a list" } }], false);
      const healthy = await projectWith(tx, [{ status: "InProgress" }], false);
      const repo = adaptWorkItemRepo(new WorkItemRowRepository(tx));
      const ours: WorkItemPort = {
        ...repo,
        projectIdsWithStatus: async (status) => (await repo.projectIdsWithStatus(status)).filter((id) => ourProjects.has(id)),
      };

      const summary = await reconcileWorkItemsOnStartup({
        logger: recordingLogger(),
        workItemRepo: ours,
        projects: new ProjectHaltRepository(tx),
        eventStore: { publish: async () => undefined },
        failureRouter: new FailureRouter(3),
        devSessionStore: { dispatchEvidence: (taskId, by) => new DevSessionRepository(db).dispatchEvidence(taskId, by) },
        workdirBase: `/nonexistent-${NAME_PREFIX}`,
      });

      expect(summary).toMatchObject({ orphansRequeued: 1, orphansCompleted: 0, orphansBlocked: 0, projectsBlocked: 1 });
      expect(await statusOf(tx, healthy.taskIds[0] ?? "")).toBe("Pending");
      // The blocked project's items are left as they were for an operator to repair.
      expect(await statusOf(tx, bad.taskIds[0] ?? "")).toBe("InProgress");
      expect(await stateOf(tx, bad.projectId)).toEqual({
        status: "blocked",
        errorClass: "WorkItemRowCorrupt",
        reason: expect.stringContaining("success_criteria does not parse"),
      });
      expect(await stateOf(tx, healthy.projectId)).toMatchObject({ status: "active" });
    });
  });
});

// Quality's verdict across a restart: the verdict is saved with the
// Failed transition and a parked Failed item is routed by it.
describe("a parked Failed item at startup is routed by the verdict saved with its Failed transition", () => {
  const VerdictRowSchema = z.array(z.object({ status: z.string(), dispatchCount: z.number(), failureVerdict: z.unknown() }));

  async function rowOf(handle: Handle, itemId: string) {
    const result = await handle.execute(sql`
      SELECT status, dispatch_count AS "dispatchCount", failure_verdict AS "failureVerdict" FROM work_items WHERE id = ${itemId}`);
    return VerdictRowSchema.parse(result.rows)[0];
  }

  /** Fails an InProgress task as the dispatch path does, through the repository's save, after one counted dispatch. */
  async function failWith(handle: Handle, itemId: string, verdict: Parameters<typeof failWorkItem>[2]): Promise<void> {
    await handle.execute(sql`UPDATE work_items SET dispatch_count = 1 WHERE id = ${itemId}`);
    const repo = adaptWorkItemRepo(new WorkItemRowRepository(handle));
    const item = await repo.findById(parseWorkItemId(itemId, "test"));
    if (item === null) throw new Error(`task ${itemId} not found`);
    failWorkItem(item, { source: "task_failed", reason: "task_failed" }, verdict);
    await repo.save(item, "InProgress");
  }

  test("non-retryable is given up with no retry spent, retryable and verdict-less rows are replanned, an unreadable verdict blocks its project", async () => {
    await inRolledBackTransaction(async (tx) => {
      const healthy = await projectWith(tx, [{ status: "InProgress" }, { status: "InProgress" }, { status: "Failed" }], false);
      const corrupt = await projectWith(tx, [{ status: "InProgress" }], false);
      const [nonRetryable = "", retryable = "", legacy = ""] = healthy.taskIds;
      const unreadable = corrupt.taskIds[0] ?? "";
      await failWith(tx, nonRetryable, { kind: "non-retryable", ground: "conflict-markers-left" });
      await failWith(tx, retryable, { kind: "retryable", ground: "merge-conflict" });
      await failWith(tx, unreadable, { kind: "retryable", ground: "work" });
      await tx.execute(sql`UPDATE work_items SET failure_verdict = '{"kind":"maybe","ground":"work"}'::jsonb WHERE id = ${unreadable}`);
      expect(await rowOf(tx, nonRetryable)).toEqual({ status: "Failed", dispatchCount: 1, failureVerdict: { kind: "non-retryable", ground: "conflict-markers-left" } });
      expect((await rowOf(tx, legacy))?.failureVerdict).toBeNull();

      const repo = adaptWorkItemRepo(new WorkItemRowRepository(tx));
      const summary = await reconcileWorkItemsOnStartup({
        logger: recordingLogger(),
        workItemRepo: { ...repo, projectIdsWithStatus: async (status) => (await repo.projectIdsWithStatus(status)).filter((id) => ourProjects.has(id)) },
        projects: new ProjectHaltRepository(tx),
        eventStore: { publish: async () => undefined },
        failureRouter: new FailureRouter(3),
        devSessionStore: { dispatchEvidence: (taskId, by) => new DevSessionRepository(db).dispatchEvidence(taskId, by) },
        workdirBase: `/nonexistent-${NAME_PREFIX}`,
      });

      expect(summary).toMatchObject({ failedAbandoned: 1, failedReplanned: 2, failedHeld: 1, failedErrored: 0 });
      // The exit from Failed clears the stored verdict; the dispatch count is the router's, untouched.
      expect(await rowOf(tx, nonRetryable)).toEqual({ status: "Abandoned", dispatchCount: 1, failureVerdict: null });
      expect(await rowOf(tx, retryable)).toEqual({ status: "Pending", dispatchCount: 1, failureVerdict: null });
      expect((await rowOf(tx, legacy))?.status).toBe("Pending");
      expect((await rowOf(tx, unreadable))?.status).toBe("Failed");
      expect(await stateOf(tx, corrupt.projectId)).toEqual({
        status: "blocked",
        errorClass: "StoredFailureVerdictCorrupt",
        reason: expect.stringContaining("failure_verdict stored with its Failed transition does not parse"),
      });
      expect(await stateOf(tx, healthy.projectId)).toMatchObject({ status: "active" });
    });
  });

  test("a save into Failed with no verdict is refused, and the row stays as it was", async () => {
    await inRolledBackTransaction(async (tx) => {
      const project = await projectWith(tx, [{ status: "InProgress" }], false);
      const taskId = project.taskIds[0] ?? "";
      const save = new WorkItemRowRepository(tx).save(
        { id: taskId, status: "Failed", blockedReason: { source: "task_failed", reason: "task_failed" }, failureVerdict: null, updatedAt: new Date() },
        "InProgress",
      );

      await expect(save).rejects.toMatchObject({ name: "FailedWithoutVerdict" });
      expect((await rowOf(tx, taskId))?.status).toBe("InProgress");
    });
  });
});
