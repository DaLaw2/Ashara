import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ProjectHaltRepository } from "@ashara/delivery";
import { BurnWarnings, listProjectBurns, postBurnWarning, readRiskRecords } from "@ashara/engagement";
import type { ProjectId } from "@ashara/shared";
import { createWorkItemId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { checkReports, readReportRecords } from "../simulator/client-reports.js";

// The work ledger's yellow and red zones are each told
// once per project and plan revision, from the ledger's own rows, and a restart (a new BurnWarnings
// over a new store, nothing in memory carried over) tells neither again. Every row belongs to a
// project this suite creates; the listing is narrowed to them, and afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

// 20 requests with a 25% reserve: 5 set aside, 15 the project's work may draw; yellow from 8, red from 12.
const BUDGETS = { perTaskRequests: 50, perProjectRequests: 20, verificationReservePercent: 25 };

let db: Database;
let clientId: string;
const ourProjects = new Set<string>();

/** A fresh process's step: a new store and a new BurnWarnings, over the database alone. */
function restarted(): BurnWarnings {
  const store: ConstructorParameters<typeof BurnWarnings>[0] = {
    projectBurns: async () => (await listProjectBurns(db)).filter((burn) => ourProjects.has(burn.projectId)),
    postWarning: (warning) => postBurnWarning(db, warning),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
  return new BurnWarnings(store, BUDGETS, memoryStepContainment(() => false));
}

async function newProject(): Promise<ProjectId> {
  const project = await new ProjectHaltRepository(db).create(`burn-warning-test-${randomUUID().slice(0, 8)}`, clientId);
  ourProjects.add(project.id);
  return project.id;
}

/** The plan: four implementation tasks, one Completed; a check task and a superseded task, neither of which counts. */
async function plan(projectId: ProjectId): Promise<void> {
  const task = (status: string, workKind: string, blockedReason: unknown = null) => sql`
    (${createWorkItemId()}, 'Task', ${status}, ${`task ${randomUUID().slice(0, 6)}`}, ${projectId}, ${workKind}, ${randomUUID()}, ${blockedReason === null ? null : JSON.stringify(blockedReason)}::jsonb)`;
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, blocked_reason) VALUES
    ${task("Completed", "implementation")}, ${task("Pending", "implementation")}, ${task("Pending", "implementation")}, ${task("InProgress", "implementation")},
    ${task("Completed", "check")},
    ${task("Abandoned", "implementation", { source: "superseded", revision: 1, reason: "replaced" })}`);
}

async function draw(projectId: ProjectId, requests: number): Promise<void> {
  const calls = new LlmCallRepository(db);
  for (let i = 0; i < requests; i++) {
    await calls.admit({ id: randomUUID(), projectId, taskId: null, callSite: "agent-runner", provider: "stub", model: "m", estimatedCostUsd: 0.01, traceId: "test-trace" });
  }
}

const WarningRows = z.array(
  z.object({
    zone: z.string(),
    planRevision: z.number(),
    drawn: z.number(),
    upstream: z.number(),
    reserve: z.number(),
    planned: z.number(),
    completed: z.number(),
    operator: z.string().nullable(),
  }),
);

async function warningsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT zone, plan_revision AS "planRevision", drawn_requests AS drawn, upstream_requests AS upstream, reserve_requests AS reserve,
           planned_tasks AS planned, completed_tasks AS completed, operator_report AS operator
    FROM work_burn_warnings WHERE project_id = ${projectId} ORDER BY created_at, zone`);
  return WarningRows.parse(result.rows);
}

async function reportsOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' ORDER BY created_at, id`);
  return z.array(z.object({ body: z.string() })).parse(result.rows).map((row) => row.body);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`burn-warning-test-${randomUUID()}`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  for (const id of ourProjects) {
    await db.execute(sql`DELETE FROM work_burn_warnings WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM work_items WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a project whose model requests run ahead of its plan", () => {
  test("is warned yellow once and red once, each recorded with its figures, and a restart repeats neither", async () => {
    const projectId = await newProject();
    await plan(projectId);
    await draw(projectId, 7);

    expect(await restarted().runPending()).toEqual([]);

    await draw(projectId, 1);
    expect(await restarted().runPending()).toEqual([{ kind: "posted", projectId, zone: "yellow" }]);
    expect(await restarted().runPending()).toEqual([]);
    expect(await warningsOf(projectId)).toEqual([
      { zone: "yellow", planRevision: 1, drawn: 8, upstream: 15, reserve: 5, planned: 4, completed: 1, operator: null },
    ]);

    await draw(projectId, 4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await restarted().runPending()).toEqual([{ kind: "posted", projectId, zone: "red" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[work_burn] work_burn red: project ${projectId} (plan revision 1) has drawn 12 of the 15`));
    await draw(projectId, 2);
    expect(await restarted().runPending()).toEqual([]);

    const recorded = await warningsOf(projectId);
    expect(recorded.map((row) => [row.zone, row.drawn])).toEqual([
      ["yellow", 8],
      ["red", 12],
    ]);
    expect(recorded[1]?.operator).toContain("12 of the 15 model requests its upstream work may draw (budget 20, verification reserve 5)");
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toContain("So far 8 model requests have been sent, of the 15 model requests this project's work may use before it pauses.");
    expect(reports[0]).toContain("1 of the 4 building tasks of the current plan are finished.");
    expect(reports[1]).toContain("Ashara has told its operator.");

    // A yellow posted after red, a retry or a racing post, records and tells nothing.
    const late = { projectId, planRevision: 1, zone: "yellow" as const, figures: { drawnRequests: 14, budgetRequests: 20, reserveRequests: 5, upstreamRequests: 15, plannedTasks: 4, completedTasks: 1 }, body: "late", operatorText: null };
    expect(await postBurnWarning(db, late)).toBe("already-posted");
    expect(await reportsOf(projectId)).toHaveLength(2);

    // I4 holds the posted reports to the rows they were recorded with.
    const keys = checkReports(await readReportRecords(db, projectId), { status: "active" }, [], new Set()).map((each) => each.key);
    expect(keys).toEqual([]);
  });
});
