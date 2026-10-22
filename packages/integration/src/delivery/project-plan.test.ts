import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, MIGRATIONS_DIR, resolveTestDatabaseUrl, runMigrations, type Database } from "@ashara/db";
import { createFirstPlanStore, createReplanStore, ProjectHaltRepository } from "@ashara/delivery";
import { VisionRepository } from "@ashara/engagement";
import { recordAcceptanceSweepFault } from "@ashara/quality";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";

// Delivery's planning record (project_plans) through the writes that change it, Quality's count of
// acceptance sweeps that could not run, and the migration that moved both off the projects row.
// Every row here belongs to a project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `project-plan-test-${randomUUID().slice(0, 8)}`;
const PLAN_STATE_MIGRATION = "017_project_plan_state.sql";

let db: Database;
let clientId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

afterAll(async () => {
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${`${NAME_PREFIX}%`}`;
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${`${NAME_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

/** A project at work awaiting its first plan: a vision and a roster, no work items. */
async function awaitingFirstPlan(): Promise<ProjectId> {
  const project = await new ProjectHaltRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  const quote = { kind: "tender" as const, quote: "Clients put and get keys." };
  await new VisionRepository(db).create(project.id, {
    visionText: "A key store. Clients put and get keys.",
    summary: "A key store.",
    inferences: [],
    contract: {
      interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY", source: quote }],
      guarantees: [{ id: "G1", statement: "A get returns the value of the last put of its key.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get after a put prints another value"], source: quote }],
      exclusions: [],
    },
  });
  await db.execute(sql`
    INSERT INTO roster_roles (project_id, revision, role_id, name, responsibility, capabilities, vision_version)
    VALUES (${project.id}, 1, ${randomUUID()}, 'Implementer', 'Builds it.', ARRAY['write-source'], 1)`);
  return project.id;
}

const PlanRowSchema = z.object({
  planAttempts: z.number(),
  planLastError: z.string().nullable(),
  planned: z.boolean(),
  stopped: z.boolean(),
  replanAttempts: z.number(),
  replanLastError: z.string().nullable(),
  replanLastFailure: z.string().nullable(),
});

/** The project's planning record; null while it has none. */
async function planRecordOf(projectId: ProjectId): Promise<z.infer<typeof PlanRowSchema> | null> {
  const result = await db.execute(sql`
    SELECT plan_attempts AS "planAttempts", plan_last_error AS "planLastError", first_planned_at IS NOT NULL AS planned,
           plan_stopped_at IS NOT NULL AS stopped, replan_attempts AS "replanAttempts", replan_last_error AS "replanLastError",
           replan_last_failure AS "replanLastFailure"
    FROM project_plans WHERE project_id = ${projectId}`);
  return z.array(PlanRowSchema).max(1).parse(result.rows)[0] ?? null;
}

async function openEpisodeOf(projectId: ProjectId): Promise<{ readonly kind: string; readonly reason: string | null } | null> {
  const result = await db.execute(sql`SELECT kind, reason FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ kind: z.string(), reason: z.string().nullable() })).max(1).parse(result.rows)[0] ?? null;
}

/** A given-up task of the project whose repair it awaits. */
async function awaitRepair(projectId: ProjectId): Promise<string> {
  const taskId = randomUUID();
  await db.execute(sql`INSERT INTO work_items (id, level, status, title, project_id) VALUES (${taskId}, 'Task', 'Abandoned', 'Given up', ${projectId})`);
  await db.execute(sql`INSERT INTO plan_repairs (work_item_id, project_id) VALUES (${taskId}, ${projectId})`);
  return taskId;
}

describe("Delivery's planning record", () => {
  test("a project no planning event touched has no record, and is listed awaiting its first plan with no attempts", async () => {
    const projectId = await awaitingFirstPlan();
    expect(await planRecordOf(projectId)).toBeNull();
    const listed = (await createFirstPlanStore(db).projectsAwaitingPlan()).find((row) => row.projectId === projectId);
    expect(listed).toMatchObject({ projectId, planAttempts: 0, planLastError: null });
  });

  test("recordPlanFailure counts each failed first planning with its error; stopPlanning halts with the last one", async () => {
    const projectId = await awaitingFirstPlan();
    const store = createFirstPlanStore(db);
    expect(await store.recordFailedAttempt(projectId, "first error")).toBe(1);
    expect(await store.recordFailedAttempt(projectId, "second error")).toBe(2);
    expect(await planRecordOf(projectId)).toMatchObject({ planAttempts: 2, planLastError: "second error", planned: false, stopped: false });
    expect((await store.projectsAwaitingPlan()).find((row) => row.projectId === projectId)).toMatchObject({ planAttempts: 2, planLastError: "second error" });

    await store.stopPlanning(projectId);
    expect(await planRecordOf(projectId)).toMatchObject({ planAttempts: 2, stopped: true, planned: false });
    expect(await openEpisodeOf(projectId)).toEqual({ kind: "planning_stopped", reason: "second error" });
    // A project whose first planning has an outcome no longer awaits it: nothing more is counted or stamped.
    await expect(store.recordFailedAttempt(projectId, "late error")).rejects.toMatchObject({ name: "ProjectNotAwaitingPlan" });
    await expect(store.stopPlanning(projectId)).rejects.toMatchObject({ name: "ProjectNotAwaitingPlan" });
    expect(await planRecordOf(projectId)).toMatchObject({ planAttempts: 2, planLastError: "second error" });
  });

  test("planWritten stamps the first plan with its dropped ordering hints, once", async () => {
    const projectId = await awaitingFirstPlan();
    const roleId = z.array(z.object({ id: z.string() })).parse((await db.execute(sql`SELECT role_id AS id FROM roster_roles WHERE project_id = ${projectId}`)).rows)[0]?.id;
    if (roleId === undefined) throw new Error("the project has no roster role");
    const store = createFirstPlanStore(db);
    const write = {
      projectId,
      items: [
        { tempId: "epic-1", level: "Epic", title: "Epic" },
        { tempId: "task-1", level: "Task", title: "Task", parentId: "epic-1" },
      ],
      edges: [],
      owners: [{ tempId: "task-1", workKind: "implementation" as const, ownerRoleId: roleId }],
      droppedDependencies: [{ dependentTaskTitle: "Task", unresolvedRef: "ghost" }],
    };
    expect(await store.writeFirstPlan(write)).toEqual({ kind: "written", created: 2 });
    expect(await planRecordOf(projectId)).toMatchObject({ planned: true, stopped: false, planAttempts: 0 });
    const dropped = await db.execute(sql`SELECT plan_dropped_dependencies AS dropped FROM project_plans WHERE project_id = ${projectId}`);
    expect(dropped.rows).toEqual([{ dropped: [{ dependentTaskTitle: "Task", unresolvedRef: "ghost" }] }]);
    expect(await store.writeFirstPlan(write)).toEqual({ kind: "already-planned" });
    await expect(store.recordFailedAttempt(projectId, "after the plan")).rejects.toMatchObject({ name: "ProjectNotAwaitingPlan" });
  });

  test("recordReplanFailure counts a revision's failures with whose they were; one with no first plan is refused", async () => {
    const planned = await awaitingFirstPlan();
    await db.execute(sql`INSERT INTO project_plans (project_id, first_planned_at) VALUES (${planned}, now())`);
    await awaitRepair(planned);
    const store = createReplanStore(db, recordingLogger());
    expect(await store.recordFailedAttempt(planned, "provider down", "provider")).toBe(1);
    expect(await store.recordFailedAttempt(planned, "bad answer", "model")).toBe(2);
    expect(await planRecordOf(planned)).toMatchObject({ replanAttempts: 2, replanLastError: "bad answer", replanLastFailure: "model" });

    const unplanned = await awaitingFirstPlan();
    await awaitRepair(unplanned);
    await expect(store.recordFailedAttempt(unplanned, "provider down", "provider")).rejects.toMatchObject({ name: "PlanningRecordRefused" });
    expect(await planRecordOf(unplanned)).toBeNull();

    const notAwaiting = await awaitingFirstPlan();
    await db.execute(sql`INSERT INTO project_plans (project_id, first_planned_at) VALUES (${notAwaiting}, now())`);
    await expect(store.recordFailedAttempt(notAwaiting, "provider down", "provider")).rejects.toMatchObject({ name: "ProjectNotAwaitingReplan" });
  });

  test("revisionWritten resets the revision's failed attempts when a repair revision is written", async () => {
    const projectId = await awaitingFirstPlan();
    await db.execute(sql`INSERT INTO project_plans (project_id, first_planned_at) VALUES (${projectId}, now())`);
    const repaired = await awaitRepair(projectId);
    const store = createReplanStore(db, recordingLogger());
    await store.recordFailedAttempt(projectId, "provider down", "provider");

    const written = await store.writeRevision({
      projectId,
      revision: 2,
      visionVersion: 1,
      corrections: null,
      repaired: [repaired],
      superseded: [],
      plan: { projectId, items: [], edges: [], owners: [], droppedDependencies: [] },
      existingEdges: [],
      regated: [],
      events: [],
      summary: { newTasks: [], newCheckTasks: 0, newReviewTasks: 0, newEnvironmentTask: false, supersededTasks: [], supersededOther: 0, keptCompleted: 0, repaired: ["Given up"] },
    });
    expect(written).toBe("written");
    expect(await planRecordOf(projectId)).toMatchObject({ replanAttempts: 0, replanLastError: null, replanLastFailure: null, planned: true });
  });

  test("resetOnUnblock: the operator's unblock runs a stopped first planning again from no attempts and resets a revision's", async () => {
    const stopped = await awaitingFirstPlan();
    const first = createFirstPlanStore(db);
    await first.recordFailedAttempt(stopped, "only error");
    await first.stopPlanning(stopped);
    const halts = new ProjectHaltRepository(db);
    await halts.unblock(stopped, "operator", "fixed the routing");
    expect(await planRecordOf(stopped)).toMatchObject({ planAttempts: 0, planLastError: null, stopped: false, planned: false });
    expect(await openEpisodeOf(stopped)).toBeNull();
    expect((await first.projectsAwaitingPlan()).map((row) => row.projectId)).toContain(stopped);

    const revising = await awaitingFirstPlan();
    await db.execute(sql`INSERT INTO project_plans (project_id, first_planned_at, replan_attempts, replan_last_error, replan_last_failure)
      VALUES (${revising}, now(), 3, 'gave up', 'model')`);
    await halts.block(revising, { category: "replan_stopped", errorClass: "ReplanStopped", reason: "gave up" });
    await halts.unblock(revising, "operator", "raised the bound");
    expect(await planRecordOf(revising)).toMatchObject({ replanAttempts: 0, replanLastError: null, replanLastFailure: null, planned: true, stopped: false });
  });

  test("the halt's cause lives on its episode alone: a planning_stopped episode needs its planning record stamped", async () => {
    const projectId = await awaitingFirstPlan();
    await expect(db.execute(sql`INSERT INTO project_blocks (project_id, kind, reason) VALUES (${projectId}, 'planning_stopped', 'x')`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/halted on planning_stopped while its planning record has no plan_stopped_at/) },
    });
    await expect(db.execute(sql`INSERT INTO project_blocks (project_id, kind) VALUES (${projectId}, 'fault')`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/halted on fault with no cause recorded on its episode/) },
    });
    await expect(db.execute(sql`INSERT INTO project_plans (project_id, plan_stopped_at, plan_attempts, plan_last_error) VALUES (${projectId}, now(), 1, 'x')`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/records its first planning stopped but has no open block episode/) },
    });
  });
  test("planning stops only on a project that is active or that the client stopped", async () => {
    const insertProject = async (lifecycle: string): Promise<string> => {
      const result = await db.execute(sql`INSERT INTO projects (name, client_id, lifecycle) VALUES (${`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`}, ${clientId}, ${lifecycle}) RETURNING id`);
      return z.array(z.object({ id: z.string() })).length(1).parse(result.rows)[0]?.id ?? "";
    };
    const accepted = await insertProject("accepted");
    await expect(db.execute(sql`INSERT INTO project_plans (project_id, plan_stopped_at, plan_attempts, plan_last_error) VALUES (${accepted}, now(), 1, 'x')`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/records its first planning stopped while its lifecycle is accepted/) },
    });
    const stopped = await insertProject("stopped");
    await db.execute(sql`INSERT INTO project_plans (project_id, plan_stopped_at, plan_attempts, plan_last_error) VALUES (${stopped}, now(), 1, 'x')`);
    await expect(db.execute(sql`UPDATE projects SET lifecycle = 'accepted' WHERE id = ${stopped}`)).rejects.toThrow();
  });
});

describe("Quality's count of acceptance sweeps that could not run", () => {
  test("each fault is counted on its own row, durably; a project that does not exist is refused", async () => {
    const projectId = await awaitingFirstPlan();
    expect(await recordAcceptanceSweepFault(db, projectId)).toBe(1);
    expect(await recordAcceptanceSweepFault(db, projectId)).toBe(2);
    const counted = await db.execute(sql`SELECT faults FROM acceptance_sweep_faults WHERE project_id = ${projectId}`);
    expect(counted.rows).toEqual([{ faults: 2 }]);
    await expect(recordAcceptanceSweepFault(db, parseProjectId(randomUUID(), "test"))).rejects.toMatchObject({ name: "AcceptanceFaultProjectMissing" });
  });
});

describe("the migration that moves per-context state off the projects row", () => {
  const name = `${new URL(DATABASE_URL).pathname.slice(1)}_plan_${randomBytes(6).toString("hex")}`;
  const fresh = new URL(DATABASE_URL);
  fresh.pathname = `/${name}`;
  let dir = "";

  beforeAll(async () => {
    await db.execute(sql.raw(`CREATE DATABASE ${name}`));
    dir = mkdtempSync(join(tmpdir(), "ashara-plan-state-"));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < PLAN_STATE_MIGRATION)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    await runMigrations(fresh.toString(), dir);
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("every project's counters, stamps and faults are carried over as they stood; system_settings and the moved columns are gone", async () => {
    const before = createDb(fresh.toString());
    const seeded = new Map<string, Record<string, unknown>>();
    try {
      const idOf = async (query: ReturnType<typeof sql>): Promise<string> => z.array(z.object({ id: z.string() })).length(1).parse((await before.execute(query)).rows)[0]?.id ?? "";
      const client = await idOf(sql`INSERT INTO clients (name) VALUES ('plan-state-migration') RETURNING id`);
      const project = () => idOf(sql`INSERT INTO projects (name, client_id) VALUES (${randomUUID()}, ${client}) RETURNING id`);

      const untouched = await project();
      seeded.set(untouched, { plan_attempts: 0, plan_last_error: null, planned: false, stopped: false, dropped: null, replan_attempts: 0, replan_last_error: null, replan_last_failure: null, faults: null });

      const revising = await project();
      await before.execute(sql`UPDATE projects SET plan_attempts = 2, plan_last_error = 'early', first_planned_at = now(),
        plan_dropped_dependencies = '[{"dependentTaskTitle":"T","unresolvedRef":"r"}]'::jsonb, replan_attempts = 1,
        replan_last_error = 'late', replan_last_failure = 'provider', acceptance_faults = 3 WHERE id = ${revising}`);
      seeded.set(revising, { plan_attempts: 2, plan_last_error: "early", planned: true, stopped: false, dropped: [{ dependentTaskTitle: "T", unresolvedRef: "r" }], replan_attempts: 1, replan_last_error: "late", replan_last_failure: "provider", faults: 3 });

      const stopped = await project();
      await before.transaction(async (tx) => {
        await tx.execute(sql`UPDATE projects SET plan_attempts = 3, plan_last_error = 'gave up', plan_stopped_at = now() WHERE id = ${stopped}`);
        await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, reason) VALUES (${stopped}, 'planning_stopped', 'gave up')`);
      });
      seeded.set(stopped, { plan_attempts: 3, plan_last_error: "gave up", planned: false, stopped: true, dropped: null, replan_attempts: 0, replan_last_error: null, replan_last_failure: null, faults: null });

      const halted = await project();
      await before.transaction(async (tx) => {
        await tx.execute(sql`UPDATE projects SET blocked_category = 'fault', blocked_error_class = 'KeptFault', blocked_reason = 'kept' WHERE id = ${halted}`);
        await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${halted}, 'fault', 'KeptFault', 'kept')`);
      });
      seeded.set(halted, { plan_attempts: 0, plan_last_error: null, planned: false, stopped: false, dropped: null, replan_attempts: 0, replan_last_error: null, replan_last_failure: null, faults: null });

      // Halts whose cause the projects row alone carried: the episode takes what it lacks from that row.
      const causedOnRow = async (episodeErrorClass: string | null, episodeReason: string | null): Promise<void> => {
        const projectId = await project();
        await before.transaction(async (tx) => {
          await tx.execute(sql`UPDATE projects SET blocked_category = 'infrastructure', blocked_error_class = 'RowFault', blocked_reason = 'on the row' WHERE id = ${projectId}`);
          await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${projectId}, 'infrastructure', ${episodeErrorClass}, ${episodeReason})`);
        });
        seeded.set(projectId, { plan_attempts: 0, plan_last_error: null, planned: false, stopped: false, dropped: null, replan_attempts: 0, replan_last_error: null, replan_last_failure: null, faults: null });
      };
      await causedOnRow(null, null);
      await causedOnRow("EpisodeFault", null);
    } finally {
      await before.$client.end();
    }

    copyFileSync(join(MIGRATIONS_DIR, PLAN_STATE_MIGRATION), join(dir, PLAN_STATE_MIGRATION));
    expect((await runMigrations(fresh.toString(), dir)).applied).toEqual([PLAN_STATE_MIGRATION]);

    const after = createDb(fresh.toString());
    try {
      const carried = await after.execute(sql`
        SELECT p.id, pp.plan_attempts, pp.plan_last_error, pp.first_planned_at IS NOT NULL AS planned, pp.plan_stopped_at IS NOT NULL AS stopped,
               pp.plan_dropped_dependencies AS dropped, pp.replan_attempts, pp.replan_last_error, pp.replan_last_failure, f.faults
        FROM projects p JOIN project_plans pp ON pp.project_id = p.id LEFT JOIN acceptance_sweep_faults f ON f.project_id = p.id`);
      const byId = new Map(z.array(z.object({ id: z.string() }).passthrough()).parse(carried.rows).map(({ id, ...rest }) => [id, rest]));
      expect(byId).toEqual(seeded);

      const episodes = await after.execute(sql`SELECT kind, error_class AS "errorClass", reason FROM project_blocks WHERE ended_at IS NULL ORDER BY kind, error_class`);
      expect(episodes.rows).toEqual([
        { kind: "fault", errorClass: "KeptFault", reason: "kept" },
        { kind: "infrastructure", errorClass: "EpisodeFault", reason: "on the row" },
        { kind: "infrastructure", errorClass: "RowFault", reason: "on the row" },
        { kind: "planning_stopped", errorClass: null, reason: "gave up" },
      ]);
      // The rewritten consistency trigger accepts every carried halt when a write re-checks it.
      await after.execute(sql`UPDATE project_blocks SET reason = reason WHERE ended_at IS NULL`);
      const columns = await after.execute(sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' ORDER BY column_name`);
      expect(z.array(z.object({ name: z.string() })).parse(columns.rows).map((row) => row.name)).toEqual(["client_id", "created_at", "id", "lifecycle", "name", "workspace_path"]);
      const settings = await after.execute(sql`SELECT to_regclass('public.system_settings') IS NULL AS gone`);
      expect(settings.rows).toEqual([{ gone: true }]);
    } finally {
      await after.$client.end();
    }
  }, 120_000);
});

describe("the migration on a halt whose cause neither its episode nor its projects row carries", () => {
  const name = `${new URL(DATABASE_URL).pathname.slice(1)}_uncaused_${randomBytes(6).toString("hex")}`;
  const fresh = new URL(DATABASE_URL);
  fresh.pathname = `/${name}`;
  let dir = "";

  beforeAll(async () => {
    await db.execute(sql.raw(`CREATE DATABASE ${name}`));
    dir = mkdtempSync(join(tmpdir(), "ashara-plan-uncaused-"));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < PLAN_STATE_MIGRATION)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    await runMigrations(fresh.toString(), dir);
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("refuses to drop the projects row's cause, naming the project, and leaves the schema as it stood", async () => {
    const before = createDb(fresh.toString());
    let projectId = "";
    try {
      const idOf = async (query: ReturnType<typeof sql>): Promise<string> => z.array(z.object({ id: z.string() })).length(1).parse((await before.execute(query)).rows)[0]?.id ?? "";
      const client = await idOf(sql`INSERT INTO clients (name) VALUES ('plan-state-uncaused') RETURNING id`);
      projectId = await idOf(sql`INSERT INTO projects (name, client_id) VALUES (${randomUUID()}, ${client}) RETURNING id`);
      // The old rule took the row's cause for any halt; a planning_stopped episode with no plan_stopped_at has none the new one reads.
      await before.transaction(async (tx) => {
        await tx.execute(sql`UPDATE projects SET blocked_category = 'fault', blocked_error_class = 'RowFault', blocked_reason = 'on the row' WHERE id = ${projectId}`);
        await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, reason) VALUES (${projectId}, 'planning_stopped', 'x')`);
      });
    } finally {
      await before.$client.end();
    }

    copyFileSync(join(MIGRATIONS_DIR, PLAN_STATE_MIGRATION), join(dir, PLAN_STATE_MIGRATION));
    await expect(runMigrations(fresh.toString(), dir)).rejects.toThrow(
      `halted projects whose cause is on neither their open episode nor their projects row: ${projectId} (planning_stopped)`,
    );
    const after = createDb(fresh.toString());
    try {
      const kept = await after.execute(sql`SELECT blocked_error_class AS "errorClass" FROM projects WHERE id = ${projectId}`);
      expect(kept.rows).toEqual([{ errorClass: "RowFault" }]);
    } finally {
      await after.$client.end();
    }
  }, 120_000);
});
