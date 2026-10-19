import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { CoreLoop, DEFAULT_CONFIG, ProjectHaltRepository, concurrentTaskLanes, runAcceptanceSweeps } from "@ashara/delivery";
import type { CoreLoopDeps } from "@ashara/delivery";
import { ClientMessageRepository, ClientStops, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import type { AcceptanceSweep } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared";
import { createAcceptanceStore, createTerminalSweepStore } from "@ashara/server/acceptance-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";

// Every sweep of main records the outcome of each stored check it ran and one evidence row per
// guarantee of the vision version in force, a guarantee no check decides included with no check; and
// a project the client stops gets its one terminal sweep in the cycle that takes the stop. The sweep's
// run on cells is Quality's and is stood in here; every record is real Postgres. Every row belongs to
// a project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `guarantee-evidence-test-${randomUUID().slice(0, 8)}`;
const MAIN = "d4".repeat(20);
const TENDER = "A key store. Clients put and get keys. A deleted key is gone.";
/** Vision v1 in the guarantees form: G1 and G2, both observed at I1. */
const VISION: Parameters<VisionRepository["create"]>[1] = {
  visionText: TENDER,
  summary: "A key store.",
  inferences: [],
  contract: {
    interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY; kv delete KEY", source: { kind: "tender", quote: "Clients put and get keys." } }],
    guarantees: [
      {
        id: "G1",
        statement: "A get returns the value of the last put of its key.",
        observable: { interface: ["I1"], observation: "output" },
        refutedBy: ["a get after a put prints another value"],
        source: { kind: "tender", quote: "Clients put and get keys." },
      },
      {
        id: "G2",
        statement: "A deleted key is gone.",
        observable: { interface: ["I1"], observation: "exit-status" },
        refutedBy: ["a get after a delete exits 0"],
        source: { kind: "tender", quote: "A deleted key is gone." },
      },
    ],
    exclusions: [],
  },
};

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

interface Planned {
  readonly projectId: ProjectId;
  readonly goal: string;
  readonly checkTask: string;
  /** The stored check of the goal task, which decides G1 only. */
  readonly taskCheckId: string;
}

/**
 * A planned project whose one goal task, "Store keys", is Completed with one stored check ("works",
 * revision 1) that decides G1; G2, the vision's other guarantee, no check decides.
 */
async function plannedProject(): Promise<Planned> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, VISION);
  await db.execute(sql`UPDATE projects SET first_planned_at = now(), workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const task = async (title: string, spec: unknown): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, task_spec, project_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${JSON.stringify(spec)}::jsonb, ${project.id})`);
    return id;
  };
  const goal = await task("Store keys", { origin: "decomposition" });
  const checkTask = await task("Checks for Store keys", { origin: "check", checksFor: goal });
  const inserted = await db.execute(sql`
    INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
    VALUES (${project.id}, ${goal}, ${checkTask}, 1, 'works', 'sh checks/run.sh', '[]'::jsonb, ${"e".repeat(64)}, '["G1"]'::jsonb)
    RETURNING id`);
  const [row] = z
    .array(z.object({ id: z.string() }))
    .length(1)
    .parse(inserted.rows);
  if (row === undefined) throw new Error("the stored check was not inserted");
  return { projectId: project.id, goal, checkTask, taskCheckId: row.id };
}

/** A sweep that ran on MAIN with the goal task's one check ending as `outcome`. */
function ranSweep(planned: Planned, outcome: "passed" | "failed"): AcceptanceSweep {
  return {
    kind: "ran",
    passed: outcome === "passed",
    mainCommit: MAIN,
    environmentVersion: "v1",
    checkedTasks: [planned.goal],
    uncheckedTasks: [],
    publicInterface: { kind: "not-placeholder" },
    checkOutcomes: [
      { taskId: planned.goal, revision: 1, checkTaskId: planned.checkTask, name: "works", command: "sh checks/run.sh", decides: ["G1"], outcome },
    ],
    failedChecks: outcome === "failed" ? [{ taskId: planned.goal, checkTaskId: planned.checkTask, name: "works" }] : [],
    details: outcome === "failed" ? `1 failure(s) on main:\n- check "works" exited 1` : "all suites passed",
  };
}

const sweepRow = z.object({ id: z.string(), purpose: z.string(), passed: z.boolean(), stopId: z.string().nullable(), checkOutcomes: z.unknown() });
const evidenceRow = z.object({
  guaranteeId: z.string(),
  visionVersion: z.number(),
  mainCommit: z.string().nullable(),
  checks: z.unknown(),
  reviewLowers: z.boolean(),
});

async function sweepsOf(projectId: ProjectId): Promise<Array<z.infer<typeof sweepRow>>> {
  const result = await db.execute(sql`
    SELECT id, purpose, passed, stop_id AS "stopId", check_outcomes AS "checkOutcomes"
    FROM acceptance_sweeps WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(sweepRow).parse(result.rows);
}

async function evidenceOf(sweepId: string): Promise<Array<z.infer<typeof evidenceRow>>> {
  const result = await db.execute(sql`
    SELECT guarantee_id AS "guaranteeId", vision_version AS "visionVersion", main_commit AS "mainCommit", checks, review_lowers AS "reviewLowers"
    FROM guarantee_evidence WHERE sweep_id = ${sweepId} ORDER BY guarantee_id`);
  return z.array(evidenceRow).parse(result.rows);
}

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/** The loop with every step inert but the client's stops and the terminal sweeps, both over Postgres and this suite's projects. */
function loopDeps(sweep: (projectId: ProjectId) => AcceptanceSweep): CoreLoopDeps {
  const containment = memoryStepContainment(() => false);
  const stops = createClientStopStore(db);
  const terminal = createTerminalSweepStore(db);
  return {
    config: { ...DEFAULT_CONFIG, workdirBase: `/tmp/${NAME_PREFIX}-unused` },
    cycleLog: { emit: () => {} },
    logger: recordingLogger(),
    containment,
    workItemRepo: {
      create: notExercised("create"),
      findById: notExercised("findById"),
      listByProject: notExercised("listByProject"),
      findByProjectAndStatus: notExercised("findByProjectAndStatus"),
      projectIdsWithStatus: notExercised("projectIdsWithStatus"),
      listIdsByStatus: notExercised("listIdsByStatus"),
      save: notExercised("save"),
      incrementDispatchCount: notExercised("incrementDispatchCount"),
      recordInfrastructureFault: notExercised("recordInfrastructureFault"),
      saveRefundedOverflow: notExercised("saveRefundedOverflow"),
      recordCrashOrphan: notExercised("recordCrashOrphan"),
      saveOrphanExit: notExercised("saveOrphanExit"),
      saveRefunded: notExercised("saveRefunded"),
      recordMergeCommit: notExercised("recordMergeCommit"),
      addDependency: notExercised("addDependency"),
      getDependencies: notExercised("getDependencies"),
      findChildren: notExercised("findChildren"),
      listDependenciesByProject: notExercised("listDependenciesByProject"),
      withTransaction: notExercised("withTransaction"),
    },
    eventStore: { publish: notExercised("publish") },
    failedApproachRepo: { record: notExercised("record") },
    projectRepo: {
      get: notExercised("get"),
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: async () => [],
      block: notExercised("block"),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
      listWithWorkspace: async () => [],
    },
    dispatchService: { execute: notExercised("execute") },
    failureRouter: { route: notExercised("route") },
    spendCap: { deploymentStop: async () => null, refusalOf: () => null },
    clientStops: new ClientStops({ ...stops, openStops: async () => (await stops.openStops()).filter((stop) => ourProjects.has(stop.projectId)) }, containment),
    clientChanges: { runPending: async () => [] },
    stackChoices: { runPending: async () => [] },
    liaisonIntake: { runPending: async () => [] },
    liaisonAnswers: { runPending: async () => [] },
    rosterDerivation: { runPending: async () => [] },
    firstPlanning: { runPending: async () => [] },
    replanning: { runPending: async () => [] },
    planReports: { runPending: async () => [] },
    checkDisputes: { record: notExercised("checkDisputes") },
    suiteReviewFindings: { record: notExercised("suiteReviewFindings") },
    checkSetFreeze: { freezeFor: async () => [] },
    blockReports: { runPending: async () => [] },
    burnWarnings: { runPending: async () => [] },
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    heldCells: { release: async () => {} },
    environmentOwner: notExercised("environmentOwner"),
    taskLanes: concurrentTaskLanes,
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    acceptance: {
      readyForAcceptance: async () => [],
      recordAccepted: notExercised("recordAccepted"),
      recordSweepFault: notExercised("recordSweepFault"),
      recordDefect: notExercised("recordDefect"),
    },
    terminalSweeper: { sweepForTerminal: async (projectId) => sweep(projectId) },
    terminalSweeps: { ...terminal, dueTerminalSweeps: async () => (await terminal.dueTerminalSweeps()).filter((due) => ourProjects.has(due.projectId)) },
    deliveredReports: { runPending: async () => [] },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("every sweep records each check's outcome and one evidence row per guarantee", () => {
  test("a sweep whose one check fails records it failed for the guarantee it decides, and the guarantee no check decides with no check", async () => {
    const planned = await plannedProject();
    const store = createAcceptanceStore(db);
    const projects = new ProjectHaltRepository(db);
    const swept = await runAcceptanceSweeps({
      acceptance: { ...store, readyForAcceptance: async () => (await store.readyForAcceptance()).filter((ready) => ready.projectId === planned.projectId) },
      acceptanceSweeper: { sweepForAcceptance: async () => ranSweep(planned, "failed") },
      projectRepo: { block: projects.block.bind(projects) },
      eventStore: new EventStoreRepository(db),
      containment: memoryStepContainment(() => false),
      logger: recordingLogger(),
    });
    expect(swept).toBe(0);

    const [sweep, ...more] = await sweepsOf(planned.projectId);
    expect(more).toEqual([]);
    expect(sweep).toMatchObject({
      purpose: "acceptance",
      passed: false,
      checkOutcomes: [{ taskCheckId: planned.taskCheckId, taskId: planned.goal, name: "works", command: "sh checks/run.sh", outcome: "failed" }],
    });
    expect(await evidenceOf(sweep?.id ?? "")).toEqual([
      {
        guaranteeId: "G1",
        visionVersion: 1,
        mainCommit: MAIN,
        checks: [{ taskCheckId: planned.taskCheckId, outcome: "failed", class: "implementer-visible" }],
        reviewLowers: false,
      },
      { guaranteeId: "G2", visionVersion: 1, mainCommit: MAIN, checks: [], reviewLowers: false },
    ]);
  });

  test("the client's stop, taken by the contractor loop, records one terminal sweep with each guarantee's evidence in the same cycle", async () => {
    const planned = await plannedProject();
    const stop = await new ClientMessageRepository(db).insertInbound({ projectId: planned.projectId, kind: "stop", body: "Stop here.", inReplyTo: null });
    const swept: ProjectId[] = [];
    const loop = new CoreLoop(
      loopDeps((projectId) => {
        swept.push(projectId);
        return ranSweep(planned, "passed");
      }),
    );

    await loop.runCycle();

    expect(swept).toEqual([planned.projectId]);
    const [sweep, ...more] = await sweepsOf(planned.projectId);
    expect(more).toEqual([]);
    expect(sweep).toMatchObject({
      purpose: "terminal",
      passed: false,
      stopId: stop.id,
      checkOutcomes: [{ taskCheckId: planned.taskCheckId, taskId: planned.goal, name: "works", command: "sh checks/run.sh", outcome: "passed" }],
    });
    expect(await evidenceOf(sweep?.id ?? "")).toEqual([
      {
        guaranteeId: "G1",
        visionVersion: 1,
        mainCommit: MAIN,
        checks: [{ taskCheckId: planned.taskCheckId, outcome: "passed", class: "implementer-visible" }],
        reviewLowers: false,
      },
      { guaranteeId: "G2", visionVersion: 1, mainCommit: MAIN, checks: [], reviewLowers: false },
    ]);

    // One terminal sweep per stop: the next cycle owes none.
    await loop.runCycle();
    expect(swept).toEqual([planned.projectId]);
    expect(await sweepsOf(planned.projectId)).toHaveLength(1);
  });
});
