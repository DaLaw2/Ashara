import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ClientMessageRepository,
  ClientRepository,
  createDb,
  createProjectWithTender,
  DEFAULT_DATABASE_URL,
  EventStoreRepository,
  ProjectRepository,
  WorkItemRepository,
} from "@ashara/db";
import { ClientStops, DeliveredReports } from "@ashara/engagement";
import type { DeliveredReportStore } from "@ashara/engagement";
import type { AcceptanceStore } from "@ashara/orchestrator";
import { runAcceptanceSweeps } from "@ashara/orchestrator";
import { RUN_SCOPE_AD_HOC, type ProjectId } from "@ashara/shared";
import { createAcceptanceStore, createDeliveredReportStore } from "@ashara/server/acceptance-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";

// Story s-independent-verify-m1 W7 (design P11, §2.8; eighth run E3): a project whose goal tasks are
// all done is swept on main once; a pass makes it Accepted with one delivered report rendered from
// the records, a failure is a defect repaired like any task given up. The sweep itself (cells, main)
// is Development's and is stood in here; every record is real Postgres. Every row belongs to a
// project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME_PREFIX = `acceptance-test-${randomUUID().slice(0, 8)}`;
const MERGE_A = "a1".repeat(20);
const MAIN = "c3".repeat(20);

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

interface Delivered {
  readonly projectId: ProjectId;
  readonly goals: readonly string[];
  /** The product scaffold, Completed and checked only by the substrate: no stored check. */
  readonly scaffold: string;
}

/**
 * A planned project whose every task is Completed: "Store keys" merged as MERGE_A, "Delete keys"
 * already delivered on MERGE_A, each with a check set whose author traces one vision item, and a
 * review recording three vision items, the third of which no check traces.
 */
async function deliveredProject(): Promise<Delivered> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build a key store.");
  ourProjects.add(project.id);
  await db.execute(sql`UPDATE projects SET first_planned_at = now(), workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const task = async (title: string, spec: unknown): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, task_spec, run_scope, project_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${JSON.stringify(spec)}::jsonb, ${RUN_SCOPE_AD_HOC}, ${project.id})`);
    return id;
  };
  const scaffold = await task("Set up the module root", { origin: "product-scaffold", checkedBy: "substrate" });
  const store = await task("Store keys", { origin: "decomposition", visionItems: ["Keys can be stored and read"] });
  const remove = await task("Delete keys", { origin: "decomposition", visionItems: ["Keys can be deleted"] });
  const checksOfStore = await task("Checks for Store keys", { origin: "check", checksFor: store, visionItems: ["Keys can be stored and read"] });
  const checksOfRemove = await task("Checks for Delete keys", { origin: "check", checksFor: remove, visionItems: ["Keys can be deleted"] });
  await task("Review the plan's checks", {
    origin: "review",
    visionItems: ["Keys can be stored and read", "Keys can be deleted", "Two writers never corrupt the store"],
  });
  const workItems = new WorkItemRepository(db);
  await workItems.recordMergeCommit(store, MERGE_A, "merged");
  await workItems.recordMergeCommit(remove, MERGE_A, "already_delivered");
  for (const [taskId, checkTaskId] of [[store, checksOfStore], [remove, checksOfRemove]] as const) {
    await db.execute(sql`
      INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version)
      VALUES (${project.id}, ${taskId}, ${checkTaskId}, 1, 'works', 'sh checks/run.sh', '[]'::jsonb, ${"e".repeat(64)})`);
  }
  return { projectId: project.id, goals: [store, remove], scaffold };
}

function acceptanceStore(): AcceptanceStore {
  const store = createAcceptanceStore(db);
  return { ...store, readyForAcceptance: async () => (await store.readyForAcceptance()).filter((ready) => ourProjects.has(ready.projectId)) };
}

function deliveredReports(): DeliveredReports {
  const store = createDeliveredReportStore(db);
  const ours: DeliveredReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((due) => ourProjects.has(due.projectId)) };
  return new DeliveredReports(ours);
}

function sweepDeps(passed: boolean, details: string, ran: { readonly checked: readonly string[]; readonly unchecked: readonly string[] } = { checked: [], unchecked: [] }) {
  const projects = new ProjectRepository(db);
  return {
    acceptance: acceptanceStore(),
    acceptanceSweeper: {
      sweepForAcceptance: async () => ({
        kind: "ran" as const,
        passed,
        mainCommit: MAIN,
        environmentVersion: "v1",
        checkedTasks: ran.checked,
        uncheckedTasks: ran.unchecked,
        details,
      }),
    },
    projectRepo: { block: projects.block.bind(projects) },
    eventStore: new EventStoreRepository(db),
  };
}

async function statusOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT status FROM projects WHERE id = ${projectId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status ?? "(none)";
}

async function reportsOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report' ORDER BY created_at, id`);
  return z.array(z.object({ body: z.string() })).parse(result.rows).map((row) => row.body);
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
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("acceptance on main", () => {
  test("a passing sweep makes the project accepted, stops its dispatch, and posts one delivered report from the records", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    const projects = new ProjectRepository(db);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([{ projectId, workspacePath: `/tmp/${NAME_PREFIX}`, goalTaskIds: goals }]);

    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [scaffold] }))).toBe(1);

    expect(await statusOf(projectId)).toBe("accepted");
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);

    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    expect(await deliveredReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(1);
    const [body] = reports;
    expect(body.split("\n\n")[0]).toContain(`the environment's test and the stored checks of 2 completed tasks passed together on main, commit ${MAIN}`);
    // The scaffold, checked only by the substrate, is done but listed apart from what passed.
    expect(body).toContain(`not checked by a stored check: none was written for them, so nothing in the run above confirms them:\n- "Set up the module root"`);
    expect(body).toContain(`"Store keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store keys".`);
    // The vision item no stored check traces, stated as not checked.
    expect(body).toContain("not checked");
    expect(body).toContain("- Two writers never corrupt the store");
    expect(body).not.toContain("- Keys can be deleted");
  });

  test("only a passed sweep makes a project accepted, and only the client's stop ends it, with the merges named", async () => {
    const { projectId } = await deliveredProject();
    await expect(db.execute(sql`UPDATE projects SET status = 'accepted' WHERE id = ${projectId}`)).rejects.toThrow();
    await runAcceptanceSweeps(sweepDeps(true, "all suites passed"));
    await expect(db.execute(sql`UPDATE projects SET status = 'active' WHERE id = ${projectId}`)).rejects.toThrow();
    expect(await statusOf(projectId)).toBe("accepted");

    await new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body: "Thanks, done.", inReplyTo: null });
    const store = createClientStopStore(db);
    const outcomes = await new ClientStops({ ...store, openStops: async () => (await store.openStops()).filter((stop) => stop.projectId === projectId) }).runPending();
    expect(outcomes).toEqual([expect.objectContaining({ kind: "stopped", reported: true, merged: 2 })]);
    expect(await statusOf(projectId)).toBe("stopped");
    const stopReport = (await reportsOf(projectId)).find((body) => body.includes("stopped at your request"));
    expect(stopReport).toContain(`- "Store keys": merged, commit ${MERGE_A}`);
    expect(stopReport).toContain(`- "Delete keys": already delivered on commit ${MERGE_A}, nothing of its own merged`);
  });

  test("a failing sweep is never accepted: it opens a defect given up with the run, whose repair the plan awaits", async () => {
    const { projectId } = await deliveredProject();
    const details = `1 failure(s) on main:\n- task x's checks: check "delete" exited 1`;

    expect(await runAcceptanceSweeps(sweepDeps(false, details))).toBe(0);

    expect(await statusOf(projectId)).toBe("active");
    const defects = await db.execute(sql`
      SELECT w.status, w.blocked_reason->>'source' AS source, w.blocked_reason->>'reason' AS reason, w.blocked_reason->>'mainCommit' AS "mainCommit",
             w.task_spec->>'origin' AS origin, r.plan_revision_id IS NULL AS awaited, s.passed
      FROM acceptance_sweeps s JOIN work_items w ON w.id = s.defect_item_id JOIN plan_repairs r ON r.work_item_id = w.id
      WHERE s.project_id = ${projectId}`);
    expect(defects.rows).toEqual([
      { status: "Abandoned", source: "acceptance_failed", reason: details, mainCommit: MAIN, origin: "acceptance", awaited: true, passed: false },
    ]);
    // The repair holds dispatch and readiness; nothing is reported as delivered.
    expect(await new ProjectRepository(db).listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
    expect(await deliveredReports().runPending()).toEqual([]);
  });

  test("a sweep that keeps faulting is counted on the project, durably, and halts it as undeliverable past the budget", async () => {
    const { projectId } = await deliveredProject();
    const projects = new ProjectRepository(db);
    const fault = Object.assign(new Error("the acceptance sweep could not run: read main failed: fatal: bad object HEAD"), {
      name: "AcceptanceSweepFault",
      projectId,
      step: "read main",
    });
    const deps = {
      ...sweepDeps(false, "unused"),
      acceptanceSweeper: { sweepForAcceptance: async () => ({ kind: "faulted" as const, mainCommit: null, error: fault }) },
    };
    await runAcceptanceSweeps(deps);
    // A fault that is not the substrate's is a defect given up with the recorded fault, main unread.
    const first = await db.execute(sql`
      SELECT p.acceptance_faults AS faults, s.main_commit AS "mainCommit", w.blocked_reason->>'reason' AS reason
      FROM projects p JOIN acceptance_sweeps s ON s.project_id = p.id JOIN work_items w ON w.id = s.defect_item_id
      WHERE p.id = ${projectId}`);
    expect(first.rows).toEqual([{ faults: 1, mainCommit: null, reason: expect.stringContaining("fatal: bad object HEAD") }]);
    // Each later round finds the project ready again (its repair done); past the budget it halts.
    for (let round = 2; round <= 4; round++) {
      await db.execute(sql`DELETE FROM plan_repairs WHERE project_id = ${projectId}`);
      await runAcceptanceSweeps(deps);
    }
    expect(await statusOf(projectId)).toBe("blocked");
    const block = await db.execute(sql`
      SELECT p.acceptance_faults AS faults, p.blocked_category AS category, b.error_class AS "errorClass"
      FROM projects p JOIN project_blocks b ON b.project_id = p.id WHERE p.id = ${projectId} ORDER BY b.blocked_at DESC LIMIT 1`);
    expect(block.rows).toEqual([{ faults: 4, category: "fault", errorClass: "AcceptanceFaultBudgetSpent" }]);
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
  });
});
