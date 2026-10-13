import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, postPlanReport, ProjectRepository } from "@ashara/db";
import { BlockReports } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";
import { RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createBlockReportStore } from "./block-report-store.js";

// Story s-loop-never-stop-m1, migration 040: every block is told to the client once, in plain
// words, and an operator's unblock is recorded and told once. Every row belongs to a project this
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
    await db.execute(sql`DELETE FROM blocked_task_reports WHERE work_item_id IN (SELECT id FROM work_items WHERE project_id = ${id})`);
    await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${id}`);
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

    expect(await messagesOf(projectId)).toEqual([expect.stringContaining("the budget set for it has been reached")]);
    expect((await messagesOf(projectId))[0]).not.toContain("BudgetExceeded");

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
    expect(bodies[2]).toContain("again could not turn this project's vision into a plan");
  });
});

describe("a blocked task is told once per time it is blocked", () => {
  async function blockedTask(projectId: ProjectId, blockedReason: unknown): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, blocked_reason, run_scope, project_id)
      VALUES (${id}, 'Task', 'Blocked', 'Add the export button', ${JSON.stringify(blockedReason)}::jsonb, ${RUN_SCOPE_AD_HOC}, ${projectId})`);
    return id;
  }

  test("reported once; unblocked and blocked again, reported again", async () => {
    const projectId = await newProject();
    const taskId = await blockedTask(projectId, { source: "environment_change_needed", paths: ["environment/x"], reason: "edited" });

    await reports().runPending();
    await reports().runPending();
    expect(await messagesOf(projectId)).toEqual([expect.stringContaining("The team is waiting on its operator")]);

    await db.execute(sql`UPDATE work_items SET status = 'Pending', blocked_reason = NULL WHERE id = ${taskId}`);
    await db.execute(sql`UPDATE work_items SET status = 'Blocked',
      blocked_reason = '{"source":"environment_undefined","reason":"no statement"}'::jsonb WHERE id = ${taskId}`);
    await reports().runPending();
    await reports().runPending();

    const bodies = await messagesOf(projectId);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("resumes by itself once the project's build and test environment is ready");
  });

  test("the report counts the open work that depends on the task, through any chain (third run N10)", async () => {
    const projectId = await newProject();
    const blocked = await blockedTask(projectId, { source: "environment_change_needed", paths: ["main.go"], reason: "edited" });
    const task = async (status: string): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO work_items (id, level, status, title, run_scope, project_id)
        VALUES (${id}, 'Task', ${status}, 'Dependent', ${RUN_SCOPE_AD_HOC}, ${projectId})`);
      return id;
    };
    const dependsOn = (from: string, to: string) => db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${from}, ${to})`);
    const direct = await task("Pending");
    const transitive = await task("Pending");
    const done = await task("Completed");
    await dependsOn(direct, blocked);
    await dependsOn(transitive, direct);
    await dependsOn(done, blocked);
    // A cycle back to the blocked task ends the walk and is not counted twice.
    await dependsOn(blocked, transitive);

    await reports().runPending();

    const [body] = await messagesOf(projectId);
    expect(body).toContain("2 other tasks depend on it, directly or through other tasks, and wait until it goes on.");
    expect(body).not.toContain("The rest of the project goes on");
  });

  test("a blocked project's tasks wait for its own report; an unreadable blocked task blocks its project", async () => {
    const quiet = await newProject();
    await blockedTask(quiet, { source: "api" });
    await new ProjectRepository(db).block(quiet, budgetCap);
    await reports().runPending();
    expect(await messagesOf(quiet)).toEqual([expect.stringContaining("budget")]);

    const corrupt = await newProject();
    await blockedTask(corrupt, { source: "no-such-source" });
    await reports().runPending();
    expect(await statusOf(corrupt)).toBe("blocked");
    await reports().runPending();
    expect(await messagesOf(corrupt)).toEqual([expect.stringContaining("Ashara found a problem on its own side")]);
  });
});
