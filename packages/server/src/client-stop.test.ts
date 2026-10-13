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
  listDuePlanReports,
  listProjectsAwaitingFirstPlan,
  ProjectRepository,
  WorkItemRepository,
} from "@ashara/db";
import { ClientStops } from "@ashara/engagement";
import type { ClientStopStore } from "@ashara/engagement";
import { PlanningService } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createClientStopStore } from "./client-stop-store.js";
import { createIntakeStore } from "./intake-store.js";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

// Story s-client-channel-m1: a client's stop halts its project. Every row belongs
// to a project this suite creates under a unique name, and every step is
// narrowed to those projects; afterAll deletes them.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME_PREFIX = `client-stop-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

/**
 * A tendered project with one Epic and one Task per entry, `[title, status]`,
 * plus, for `merged` entries, the dev session a merge closes Completed.
 */
async function projectWith(tasks: ReadonlyArray<readonly [string, string, "merged"?]>) {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build it.");
  ourProjects.add(project.id);
  const epicId = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, title, run_scope, project_id)
    VALUES (${epicId}, 'Epic', 'Epic', ${RUN_SCOPE_AD_HOC}, ${project.id})`);
  const taskIds: string[] = [];
  for (const [title, status, merged] of tasks) {
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, parent_id, title, run_scope, project_id)
      VALUES (${taskId}, 'Task', ${status}, ${epicId}, ${title}, ${RUN_SCOPE_AD_HOC}, ${project.id})`);
    if (merged) {
      await db.execute(sql`INSERT INTO dev_sessions (id, task_id, phase) VALUES (${randomUUID()}, ${taskId}, 'Completed')`);
    }
  }
  return { projectId: project.id, taskIds };
}

async function sendStop(projectId: ProjectId, body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body, inReplyTo: null });
}

function liaison(): ClientStops {
  const store = createClientStopStore(db);
  const ours: ClientStopStore = {
    ...store,
    openStops: async () => (await store.openStops()).filter((stop) => ourProjects.has(stop.projectId)),
  };
  return new ClientStops(ours);
}

function gate() {
  const projects = new ProjectRepository(db);
  return PlanningService.gate(adaptWorkItemRepo(new WorkItemRepository(db)), {
    listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)),
    block: projects.block.bind(projects),
  });
}

const ProjectRowSchema = z.array(
  z.object({ status: z.string(), errorClass: z.string().nullable(), reason: z.string().nullable() }),
);

async function projectRow(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT status, blocked_error_class AS "errorClass", blocked_reason AS "reason" FROM projects WHERE id = ${projectId}`);
  return ProjectRowSchema.parse(result.rows)[0];
}

async function stopReports(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT body FROM client_messages
    WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report'`);
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
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (SELECT id FROM work_items WHERE project_id IN (${ours}))`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  // Reports reply to the stop they answer: delete replies before what they reply to.
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a client's stop", () => {
  test("stops only its project, is consumed, is reported once with the merged titles; the project's Pending task is never gated", async () => {
    const stopped = await projectWith([
      ["Count words in a file", "Completed", "merged"],
      ["Marked done by hand", "Completed"],
      ["Count lines too", "Pending"],
    ]);
    const other = await projectWith([["Parse the config", "Pending"]]);
    expect((await gate()).map((item) => item.id).sort()).toEqual([stopped.taskIds[2], other.taskIds[0]].sort());
    const stop = await sendStop(stopped.projectId, "Budget moved to another project.");

    const outcomes = await liaison().runPending();

    expect(outcomes).toEqual([
      { kind: "stopped", reported: true, merged: 1, stopId: stop.id, projectId: stopped.projectId },
    ]);
    expect(await projectRow(stopped.projectId)).toEqual({ status: "stopped", errorClass: null, reason: null });
    expect(await projectRow(other.projectId)).toEqual({ status: "active", errorClass: null, reason: null });
    expect((await new ClientMessageRepository(db).findById(stop.id))?.consumedAt).toBeInstanceOf(Date);

    const reports = await stopReports(stopped.projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("stopped at your request");
    expect(reports[0]).toContain('"Count words in a file"');
    expect(reports[0]).not.toContain("Count lines too");
    expect(reports[0]).not.toContain("Marked done by hand");
    expect(reports[0]).not.toMatch(/plan (is )?complete/i);
    expect(await stopReports(other.projectId)).toEqual([]);

    // Never dispatched afterwards, and its open tender is never taken in.
    expect((await gate()).map((item) => item.id)).toEqual([other.taskIds[0]]);
    const openTenders = (await createIntakeStore(db).openTenders()).map((tender) => tender.projectId);
    expect(openTenders).not.toContain(stopped.projectId);
    expect(openTenders).toContain(other.projectId);

    // A second stop is consumed and not answered.
    const again = await sendStop(stopped.projectId, "Stop.");
    expect(await liaison().runPending()).toEqual([
      { kind: "already-stopped", stopId: again.id, projectId: stopped.projectId },
    ]);
    expect((await new ClientMessageRepository(db).findById(again.id))?.consumedAt).toBeInstanceOf(Date);
    expect(await stopReports(stopped.projectId)).toHaveLength(1);
    expect(await liaison().runPending()).toEqual([]);
  });

  test("a stop not yet consumed already keeps its project out of gating, intake, first planning and reports", async () => {
    // Each reader is shown a project it would admit, so each exclusion is the stop's doing.
    const dispatchable = await projectWith([["Write the parser", "Pending"]]);
    const { project: awaiting } = await createProjectWithTender(
      db,
      clientId,
      `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`,
      "Plan it.",
    );
    ourProjects.add(awaiting.id);
    await db.execute(sql`
      INSERT INTO vision_documents (project_id, version, vision_text, summary) VALUES (${awaiting.id}, 1, 'v', 'v')`);
    const planned = await projectWith([["Ship it", "Pending"]]);
    await db.execute(sql`UPDATE projects SET first_planned_at = now() WHERE id = ${planned.projectId}`);

    const gated = async () => (await gate()).map((item) => item.id);
    const tenders = async () => (await createIntakeStore(db).openTenders()).map((tender) => tender.projectId);
    const toPlan = async () => (await listProjectsAwaitingFirstPlan(db)).map((row) => row.projectId);
    const toReport = async () => (await listDuePlanReports(db)).map((row) => row.projectId);
    expect(await gated()).toContain(dispatchable.taskIds[0]);
    expect(await tenders()).toContain(awaiting.id);
    expect(await toPlan()).toContain(awaiting.id);
    expect(await toReport()).toContain(planned.projectId);

    for (const projectId of [dispatchable.projectId, awaiting.id, planned.projectId]) {
      await sendStop(projectId, "Stop now.");
    }

    expect(await gated()).not.toContain(dispatchable.taskIds[0]);
    expect(await tenders()).not.toContain(awaiting.id);
    expect(await toPlan()).not.toContain(awaiting.id);
    expect(await toReport()).not.toContain(planned.projectId);

    // The next cycle's stop step then stops all three.
    expect((await liaison().runPending()).map((outcome) => outcome.kind)).toEqual(["stopped", "stopped", "stopped"]);
  });

  test("a blocked project the client stops keeps its blocked cause; nothing merged is said plainly", async () => {
    const project = await projectWith([["Set up the studio list", "Pending"]]);
    await new ProjectRepository(db).block(project.projectId, { errorClass: "TestBlock", reason: "blocked by the test" });
    await sendStop(project.projectId, "Never mind.");

    const [outcome] = await liaison().runPending();

    expect(outcome).toMatchObject({ kind: "stopped", reported: true, merged: 0 });
    expect(await projectRow(project.projectId)).toEqual({
      status: "stopped",
      errorClass: "TestBlock",
      reason: "blocked by the test",
    });
    const reports = await stopReports(project.projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("No merged work is on record for this project.");
  });
});
