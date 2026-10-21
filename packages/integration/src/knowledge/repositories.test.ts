import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { failedApproaches, knowledgeEntries } from "@ashara/db/schema/knowledge";
import type { Database } from "@ashara/db";
import { FailedApproachRepository, KnowledgeRepository } from "@ashara/knowledge";
import type { ProjectId } from "@ashara/shared";
import { WorkItemRowRepository } from "@ashara/delivery";

// Knowledge's repositories against real Postgres: one insert -> read round trip each, and the
// project scoping of their reads.

let db: Database;

const createdWorkItemIds: string[] = [];
const createdKnowledgeIds: string[] = [];
const createdFailedApproachTaskIds: string[] = [];

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

// Every work item needs a project; this suite owns one.
let testProjectId: ProjectId;
let testClientId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const nonce = randomUUID().slice(0, 8);
  testClientId = (await new ClientRepository(db).create(`knowledge-intg-${nonce}`)).id;
  testProjectId = (await new ProjectRepository(db).create(`knowledge-intg-${nonce}`, testClientId)).id;
});

afterAll(async () => {
  for (const taskId of createdFailedApproachTaskIds) {
    await db.execute(sql`DELETE FROM failed_approaches WHERE task_id = ${taskId}`);
  }
  for (const id of createdKnowledgeIds) {
    await db.execute(sql`DELETE FROM knowledge_entries WHERE id = ${id}`);
  }
  // Reverse creation order so children are gone before parents.
  for (const id of [...createdWorkItemIds].reverse()) {
    await db.execute(sql`DELETE FROM work_items WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM projects WHERE id = ${testProjectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
  await db.$client.end();
});

// ---------------------------------------------------------------------------
// 1. KnowledgeRepository
// ---------------------------------------------------------------------------

describe("KnowledgeRepository", () => {
  let repo: KnowledgeRepository;
  const epicId = randomUUID();
  const taskId = randomUUID();

  beforeAll(async () => {
    repo = new KnowledgeRepository(db);

    const wiRepo = new WorkItemRowRepository(db);
    await wiRepo.create({
      id: epicId,
      level: "Epic",
      status: "Pending",
      title: "Knowledge Test Epic",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Completed",
      parentId: epicId,
      title: "Knowledge Test Task",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(taskId);
  });

  test("storeKnowledgeFinding inserts a finding and it can be read back", async () => {
    await repo.storeKnowledgeFinding(
      testProjectId,
      taskId,
      epicId,
      "Test Finding Title",
      "This is a test finding content for integration tests",
      ["test", "integration"],
    );

    const rows = await db
      .select()
      .from(knowledgeEntries)
      .where(sql`${knowledgeEntries.sourceTaskId} = ${taskId} AND ${knowledgeEntries.kind} = 'finding'`);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    createdKnowledgeIds.push(row.id);

    expect(row.title).toBe("Test Finding Title");
    expect(row.content).toBe("This is a test finding content for integration tests");
    expect(row.epicId).toBe(epicId);
    expect(row.sourceTaskId).toBe(taskId);
    expect(row.tags).toEqual(["test", "integration"]);
  });
});

// ---------------------------------------------------------------------------
// 2. FailedApproachRepository
// ---------------------------------------------------------------------------

describe("FailedApproachRepository", () => {
  let repo: FailedApproachRepository;
  const taskId = randomUUID();
  const epicId = randomUUID();

  beforeAll(async () => {
    repo = new FailedApproachRepository(db);

    const wiRepo = new WorkItemRowRepository(db);
    await wiRepo.create({
      id: epicId,
      level: "Epic",
      status: "Pending",
      title: "FailedApproach Test Epic",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(epicId);

    await wiRepo.create({
      id: taskId,
      level: "Task",
      status: "Pending",
      parentId: epicId,
      title: "FailedApproach Test Task",
      projectId: testProjectId,
    });
    createdWorkItemIds.push(taskId);
  });

  test("record inserts a failed approach and it can be read back", async () => {
    await repo.record(
      testProjectId,
      taskId,
      epicId,
      "Bad Architecture Choice",
      "Over-engineering, latency issues",
      "Keep it simple for solo projects",
    );
    createdFailedApproachTaskIds.push(taskId);

    const rows = await db
      .select()
      .from(failedApproaches)
      .where(sql`${failedApproaches.taskId} = ${taskId}`);

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.epicId).toBe(epicId);
    expect(row.title).toBe("Bad Architecture Choice");
    expect(row.failureReason).toBe("Over-engineering, latency issues");
    expect(row.learned).toBe("Keep it simple for solo projects");
    expect(row.projectId).toBe(testProjectId);
  });
});

// ---------------------------------------------------------------------------
// 3. Two projects on one database
// ---------------------------------------------------------------------------

describe("project-scoped knowledge", () => {
  const projectTasks = new Map<ProjectId, string>();
  let otherProjectId: ProjectId;

  beforeAll(async () => {
    otherProjectId = (await new ProjectRepository(db).create(`knowledge-intg-other-${randomUUID().slice(0, 8)}`, testClientId)).id;
    const wiRepo = new WorkItemRowRepository(db);
    for (const projectId of [testProjectId, otherProjectId]) {
      const taskId = randomUUID();
      await wiRepo.create({ id: taskId, level: "Task", status: "Pending", title: "Scoped Task", projectId });
      createdWorkItemIds.push(taskId);
      projectTasks.set(projectId, taskId);
    }
  });

  afterAll(async () => {
    for (const projectId of projectTasks.keys()) {
      await db.execute(sql`DELETE FROM knowledge_entries WHERE project_id = ${projectId}`);
      await db.execute(sql`DELETE FROM failed_approaches WHERE project_id = ${projectId}`);
    }
    const otherTask = projectTasks.get(otherProjectId);
    if (otherTask !== undefined) await db.execute(sql`DELETE FROM work_items WHERE id = ${otherTask}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${otherProjectId}`);
  });

  function taskOf(projectId: ProjectId): string {
    const taskId = projectTasks.get(projectId);
    if (taskId === undefined) throw new Error(`test setup: no task for project ${projectId}`);
    return taskId;
  }

  test("each project's read returns only its own findings and failed approaches", async () => {
    const knowledge = new KnowledgeRepository(db);
    const approaches = new FailedApproachRepository(db);
    for (const projectId of projectTasks.keys()) {
      const taskId = taskOf(projectId);
      await knowledge.storeKnowledgeFinding(projectId, taskId, null, `finding of ${projectId}`, "shared words", []);
      await approaches.record(projectId, taskId, null, `approach of ${projectId}`, "shared words", "l");
    }

    for (const projectId of projectTasks.keys()) {
      const findings = await knowledge.recentFindingsScoped(projectId, null, "shared words", 50);
      expect(findings.map((f) => f.title)).toEqual([`finding of ${projectId}`]);
      const failed = await approaches.failedApproachesScoped(projectId, null, "shared words", 50);
      expect(failed.map((f) => f.title)).toEqual([`approach of ${projectId}`]);
    }
  });
});
