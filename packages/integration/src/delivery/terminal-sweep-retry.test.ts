import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { CoreLoop, DEFAULT_CONFIG, ProjectHaltRepository } from "@ashara/delivery";
import { idleProjectRepo, inertWorkItemRepo } from "@ashara/delivery/testing";
import type { CoreLoopDeps } from "@ashara/delivery";
import { ClientMessageRepository, ClientStops, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import type { AcceptanceSweep } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createTerminalSweepStore } from "@ashara/server/acceptance-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { terminalReportsOf } from "../server/terminal-reports.js";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";

// A stop's or a halt's terminal sweep that faults is retried in later cycles, and the report waits
// for it: a transient fault does not cost the report its evidence, and only a sweep whose retries are
// exhausted is recorded with no check run, naming the fault, so the report is told with every
// guarantee unjudged. Each cycle runs on a loop composed afresh, as after a restart: the faults are
// counted in Postgres, and the report is told once. The sweep's run on cells is Quality's and is stood
// in here; every record is real Postgres. Every row belongs to a project this suite creates under a
// unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `terminal-sweep-retry-test-${randomUUID().slice(0, 8)}`;
const MAIN = "a7".repeat(20);
const TENDER = "A key store. Clients put and get keys.";
/** Vision v1: G1, decided by the goal task's one stored check, and G2, decided by none. */
const VISION: Parameters<VisionRepository["create"]>[1] = {
  visionText: TENDER,
  summary: "A key store.",
  inferences: [],
  contract: {
    interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY", source: { kind: "tender", quote: "Clients put and get keys." } }],
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
        statement: "A get of a key never put exits non-zero.",
        observable: { interface: ["I1"], observation: "exit-status" },
        refutedBy: ["a get of an unknown key exits 0"],
        source: { kind: "tender", quote: "Clients put and get keys." },
      },
    ],
    exclusions: [],
  },
};

const budgetCap = {
  category: "budget_cap",
  errorClass: SPEND_CAP_ERROR_CLASS.project,
  reason: "project cap $5 reached",
  spend: { capUsd: 1, spentUsd: 0.5, inFlightUsd: 0, nextCallUsd: 0.6 },
} as const;

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

interface Planned {
  readonly projectId: ProjectId;
  readonly goal: string;
  readonly checkTask: string;
}

/** A planned project with a workspace whose goal task is Completed with one stored check, deciding G1. */
async function plannedProject(): Promise<Planned> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, VISION);
  await db.execute(sql`WITH planned AS (INSERT INTO project_plans (project_id, first_planned_at) VALUES (${project.id}, now())) UPDATE projects SET workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const task = async (title: string, spec: unknown): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO work_items (id, level, status, title, task_spec, project_id) VALUES (${id}, 'Task', 'Completed', ${title}, ${JSON.stringify(spec)}::jsonb, ${project.id})`);
    return id;
  };
  const goal = await task("Store keys", { origin: "decomposition" });
  const checkTask = await task("Checks for Store keys", { origin: "check", checksFor: goal });
  await db.execute(sql`
    INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
    VALUES (${project.id}, ${goal}, ${checkTask}, 1, 'works', 'sh checks/run.sh', '[]'::jsonb, ${"e".repeat(64)}, '["G1"]'::jsonb)`);
  return { projectId: project.id, goal, checkTask };
}

/** A sweep that ran on MAIN, the goal task's one check passing. */
function ranSweep(planned: Planned): AcceptanceSweep {
  return {
    kind: "ran",
    passed: true,
    mainCommit: MAIN,
    environmentVersion: "v1",
    checkedTasks: [planned.goal],
    uncheckedTasks: [],
    publicInterface: { kind: "not-placeholder" },
    placeholder: { kind: "not-searched" as const },
    checkOutcomes: [{ taskId: planned.goal, revision: 1, checkTaskId: planned.checkTask, name: "works", command: "sh checks/run.sh", decides: ["G1"], outcome: "passed" }],
    failedChecks: [],
    details: "all suites passed",
  };
}

/** A sweep whose own machinery faulted after reading main, as Quality returns one. */
function faultedSweep(projectId: ProjectId): AcceptanceSweep {
  const error = Object.assign(new Error(`the acceptance sweep of project ${projectId} could not run: run checks failed: spawn EMFILE`), {
    name: "AcceptanceSweepFault",
    projectId,
    step: "run checks",
  });
  return { kind: "faulted", mainCommit: MAIN, error };
}

/** The loop as production composes it over the test database, every step idle but the stops, the terminal sweeps and the terminal reports of this suite's projects. */
function loopDeps(sweep: (projectId: ProjectId) => AcceptanceSweep): CoreLoopDeps {
  const containment = memoryStepContainment(() => false);
  const stops = createClientStopStore(db);
  const terminal = createTerminalSweepStore(db);
  const ours = (projectId: string): boolean => ourProjects.has(projectId);
  return composedLoopOverTestDb(
    {
      db,
      config: { ...DEFAULT_CONFIG, workdirBase: `/tmp/${NAME_PREFIX}-unused` },
      logger: recordingLogger(),
      spendCap: { deploymentStop: async () => null, refusalOf: () => null },
      containment,
    },
    {
      loop: { workItemRepo: inertWorkItemRepo(), projectRepo: idleProjectRepo() },
      client: { clientStops: new ClientStops({ ...stops, openStops: async () => (await stops.openStops()).filter((stop) => ours(stop.projectId)) }, containment) },
      sweeps: {
        terminalSweeper: { sweepForTerminal: async (projectId) => sweep(projectId) },
        terminalSweeps: { ...terminal, dueTerminalSweeps: async () => (await terminal.dueTerminalSweeps()).filter((due) => ours(due.projectId)) },
      },
      // The cycle's own terminal sweep step records each sweep; the reports read only what it recorded.
      reporting: { terminalReports: terminalReportsOf(db, ours, { unswept: true, kinds: ["stopped", "halted"] }) },
    },
  );
}

/** One cycle on a loop composed afresh, as after a restart. */
async function cycleAfterRestart(sweep: (projectId: ProjectId) => AcceptanceSweep): Promise<void> {
  await new CoreLoop(loopDeps(sweep)).runCycle();
}

const MessageRows = z.array(
  z.object({
    body: z.string(),
    verdicts: z.array(z.object({ guaranteeId: z.string(), sweepId: z.string().nullable(), verdict: z.string(), reason: z.string().nullable() })),
  }),
);

/** The project's outbound terminal reports, oldest first, each with the verdicts stored beside it. */
async function reportsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT m.body, COALESCE((SELECT jsonb_agg(jsonb_build_object('guaranteeId', v.guarantee_id, 'sweepId', v.sweep_id, 'verdict', v.verdict, 'reason', v.reason) ORDER BY v.guarantee_id)
      FROM guarantee_verdicts v WHERE v.report_id = m.id), '[]'::jsonb) AS verdicts
    FROM client_messages m WHERE m.project_id = ${projectId} AND m.direction = 'outbound' AND m.kind = 'report' ORDER BY m.created_at, m.id`);
  return MessageRows.parse(result.rows);
}

const SweepRows = z.array(z.object({ id: z.string(), mainCommit: z.string().nullable(), details: z.string() }));

async function terminalSweepsOf(projectId: ProjectId) {
  const result = await db.execute(sql`SELECT id, main_commit AS "mainCommit", details FROM acceptance_sweeps WHERE project_id = ${projectId} AND purpose = 'terminal' ORDER BY created_at, id`);
  return SweepRows.parse(result.rows);
}

async function faultsOf(projectId: ProjectId): Promise<number[]> {
  const result = await db.execute(sql`SELECT faults FROM terminal_sweep_faults WHERE project_id = ${projectId} ORDER BY id`);
  return z
    .array(z.object({ faults: z.number() }))
    .parse(result.rows)
    .map((row) => row.faults);
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
  for (const table of ["guarantee_verdicts", "told_reports", "guarantee_evidence", "acceptance_sweeps", "terminal_sweep_faults", "task_checks", "work_items", "vision_documents"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id IN (${ours})`);
  }
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  for (const table of ["project_blocks", "project_plans"]) await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a stop's or a halt's report waits for its terminal sweep's bounded retries", () => {
  test("a stop whose sweep faults once and then runs is told once, carrying the verdicts of the sweep that ran", async () => {
    const planned = await plannedProject();
    await new ClientMessageRepository(db).insertInbound({ projectId: planned.projectId, kind: "stop", body: "Stop here.", inReplyTo: null });
    let attempts = 0;
    const sweep = (projectId: ProjectId): AcceptanceSweep => {
      attempts += 1;
      return attempts === 1 ? faultedSweep(projectId) : ranSweep(planned);
    };

    await cycleAfterRestart(sweep);
    // The fault is counted and nothing is recorded: the stop's report is not told on no sweep.
    expect(await faultsOf(planned.projectId)).toEqual([1]);
    expect(await terminalSweepsOf(planned.projectId)).toEqual([]);
    expect(await reportsOf(planned.projectId)).toEqual([]);

    await cycleAfterRestart(sweep);
    const [swept, ...moreSweeps] = await terminalSweepsOf(planned.projectId);
    expect(moreSweeps).toEqual([]);
    expect(swept?.mainCommit).toBe(MAIN);
    const [report, ...more] = await reportsOf(planned.projectId);
    expect(more).toEqual([]);
    expect(report?.body).toContain(`judged on main at commit ${MAIN}, sweep ${swept?.id}`);
    expect(report?.verdicts.map((verdict) => ({ guaranteeId: verdict.guaranteeId, sweepId: verdict.sweepId, verdict: verdict.verdict }))).toEqual([
      { guaranteeId: "G1", sweepId: swept?.id, verdict: "pass" },
      { guaranteeId: "G2", sweepId: swept?.id, verdict: "unjudged" },
    ]);
    expect(report?.verdicts.some((verdict) => verdict.reason === "no-sweep-on-commit")).toBe(false);

    await cycleAfterRestart(sweep);
    expect(attempts).toBe(2);
    expect(await reportsOf(planned.projectId)).toHaveLength(1);
  });

  test("a halt whose sweep keeps faulting is told only once its retries are exhausted, every guarantee unjudged, its sweep naming the fault", async () => {
    const planned = await plannedProject();
    await new ProjectHaltRepository(db).block(planned.projectId, budgetCap);
    let attempts = 0;
    const sweep = (projectId: ProjectId): AcceptanceSweep => {
      attempts += 1;
      return faultedSweep(projectId);
    };

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await cycleAfterRestart(sweep);
      expect(await faultsOf(planned.projectId)).toEqual([cycle]);
      expect(await terminalSweepsOf(planned.projectId)).toEqual([]);
      expect(await reportsOf(planned.projectId)).toEqual([]);
    }

    await cycleAfterRestart(sweep);
    const [swept, ...moreSweeps] = await terminalSweepsOf(planned.projectId);
    expect(moreSweeps).toEqual([]);
    expect(swept?.mainCommit).toBeNull();
    expect(swept?.details).toContain("could not run in 4 attempts");
    expect(swept?.details).toContain(`on main at commit ${MAIN}`);
    expect(swept?.details).toContain("spawn EMFILE");
    const [report, ...more] = await reportsOf(planned.projectId);
    expect(more).toEqual([]);
    expect(report?.body).toContain(`why is in Ashara's record of that attempt, sweep ${swept?.id}`);
    expect(report?.verdicts).toEqual([
      { guaranteeId: "G1", sweepId: swept?.id, verdict: "unjudged", reason: "no-sweep-on-commit" },
      { guaranteeId: "G2", sweepId: swept?.id, verdict: "unjudged", reason: "no-sweep-on-commit" },
    ]);

    await cycleAfterRestart(sweep);
    expect(attempts).toBe(4);
    expect(await reportsOf(planned.projectId)).toHaveLength(1);
  });

  test("a stop whose sweep cannot be recorded, its vision unreadable, is told once its retries are exhausted, its sweep naming the fault", async () => {
    const planned = await plannedProject();
    await db.execute(sql`UPDATE vision_documents SET guarantees = '[{"bad":1}]'::jsonb WHERE project_id = ${planned.projectId}`);
    await new ClientMessageRepository(db).insertInbound({ projectId: planned.projectId, kind: "stop", body: "Stop here.", inReplyTo: null });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await cycleAfterRestart(() => ranSweep(planned));
      expect(await faultsOf(planned.projectId)).toEqual([cycle]);
      expect(await terminalSweepsOf(planned.projectId)).toEqual([]);
      expect(await reportsOf(planned.projectId)).toEqual([]);
    }

    await cycleAfterRestart(() => ranSweep(planned));
    const [swept, ...moreSweeps] = await terminalSweepsOf(planned.projectId);
    expect(moreSweeps).toEqual([]);
    expect(swept?.mainCommit).toBeNull();
    expect(swept?.details).toContain("could not run in 4 attempts");
    expect(swept?.details).toContain("threw");
    const [report, ...more] = await reportsOf(planned.projectId);
    expect(more).toEqual([]);
    expect(report?.verdicts).toEqual([]);

    await cycleAfterRestart(() => ranSweep(planned));
    expect(await reportsOf(planned.projectId)).toHaveLength(1);
  });
});
