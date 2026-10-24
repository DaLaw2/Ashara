import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { ClientStops, ClientMessageRepository, TERMINAL_KINDS, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import type { ClientStopStore } from "@ashara/engagement";
import { PlanningService, adaptWorkItemRepo, createFirstPlanStore, listDuePlanReports, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { projectState } from "../simulator/project-state.js";
import { terminalReportsOf } from "./terminal-reports.js";
import { sweepTerminalsOf } from "./terminal-sweeps.js";

// A client's stop halts its project. Every row belongs
// to a project this suite creates under a unique name, and every step is
// narrowed to those projects; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `client-stop-test-${randomUUID().slice(0, 8)}`;

let db: Database;
let clientId: string;
const ourProjects = new Set<string>();

/**
 * A tendered project with one Epic and one Task per entry, `[title, status]`. A `merged` entry
 * has its merge commit recorded by the production writer, and its dev session left in Preparing,
 * as a failed fail-soft terminal write leaves it; a `session-only` entry has a dev session closed
 * Completed and no merge record (a check task completes so, merging nothing).
 */
async function projectWith(tasks: ReadonlyArray<readonly [string, string, ("merged" | "session-only")?]>) {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build it.");
  ourProjects.add(project.id);
  const epicId = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, title, project_id)
    VALUES (${epicId}, 'Epic', 'Epic', ${project.id})`);
  const taskIds: string[] = [];
  for (const [title, status, merged] of tasks) {
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, parent_id, title, project_id)
      VALUES (${taskId}, 'Task', ${status}, ${epicId}, ${title}, ${project.id})`);
    if (merged === "merged") {
      await new WorkItemRowRepository(db).recordMergeCommit(taskId, randomBytes(20).toString("hex"), "merged");
      await db.execute(sql`INSERT INTO dev_sessions (id, task_id, phase) VALUES (${randomUUID()}, ${taskId}, 'Preparing')`);
    }
    if (merged === "session-only") {
      await db.execute(sql`INSERT INTO dev_sessions (id, task_id, phase) VALUES (${randomUUID()}, ${taskId}, 'Completed')`);
    }
  }
  return { projectId: project.id, taskIds };
}

async function sendStop(projectId: ProjectId, body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body, inReplyTo: null });
}

/** The Liaison's stop step over the projects `ours` admits. */
function stopsOf(ours: (projectId: string) => boolean, escapes: boolean): ClientStops {
  const store = createClientStopStore(db);
  const scoped: ClientStopStore = { ...store, openStops: async () => (await store.openStops()).filter((stop) => ours(stop.projectId)) };
  return new ClientStops(scoped, memoryStepContainment(() => escapes));
}

/** One cycle's stop steps over this suite's projects: the stops taken, then the terminal messages due after the terminal sweeps. */
async function stopSteps() {
  const ours = (projectId: string) => ourProjects.has(projectId);
  return [...(await stopsOf(ours, true).runPending()), ...(await terminalReportsOf(db, ours).runPending(TERMINAL_KINDS))];
}

/** The stops and terminal messages of one project with no terminal sweep run first: what is due when a stop's sweep could not be recorded. */
function unsweptReports(projectId: ProjectId, escapes: boolean) {
  const ours = (id: string) => id === projectId;
  const stops = stopsOf(ours, escapes);
  const terminals = terminalReportsOf(db, ours, { escapes, unswept: true });
  return { runPending: () => stops.runPending(), tellPending: () => terminals.runPending(TERMINAL_KINDS) };
}

/** Vision v1 in the guarantees form: G1 and G2, both observed at I1 and quoted from the tender. */
async function writeContract(projectId: ProjectId): Promise<void> {
  const quote = (text: string) => ({ kind: "tender" as const, quote: text });
  await new VisionRepository(db).create(projectId, {
    visionText: "A key store. Clients put and get keys. A deleted key is gone.",
    summary: "A key store.",
    inferences: [],
    contract: {
      interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY; kv delete KEY", source: quote("Clients put and get keys.") }],
      guarantees: [
        { id: "G1", statement: "A get returns the value of the last put of its key.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get after a put prints another value"], source: quote("Clients put and get keys.") },
        { id: "G2", statement: "A deleted key is gone.", observable: { interface: ["I1"], observation: "exit-status" }, refutedBy: ["a get after a delete exits 0"], source: quote("A deleted key is gone.") },
      ],
      exclusions: [],
    },
  });
}

const StoredVerdictsSchema = z.array(z.object({ guaranteeId: z.string(), sweepId: z.string().nullable(), verdict: z.string(), reason: z.string().nullable() }));

async function gate() {
  const projects = new ProjectHaltRepository(db);
  const gated = await PlanningService.gate(
    adaptWorkItemRepo(new WorkItemRowRepository(db)),
    {
      listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)),
      block: projects.block.bind(projects),
    },
    new EventStoreRepository(db),
    memoryStepContainment(() => true),
    recordingLogger(),
  );
  return gated.available;
}

const ProjectRowSchema = z.array(
  z.object({ status: z.string(), errorClass: z.string().nullable(), reason: z.string().nullable() }),
);

async function projectRow(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT ${projectState} AS status, (SELECT b.error_class FROM project_blocks b WHERE b.project_id = projects.id ORDER BY b.blocked_at DESC LIMIT 1) AS "errorClass",
      (SELECT b.reason FROM project_blocks b WHERE b.project_id = projects.id ORDER BY b.blocked_at DESC LIMIT 1) AS "reason" FROM projects WHERE id = ${projectId}`);
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
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${ours})`);
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
      ["Write the checks", "Completed", "session-only"],
      ["Merged, then cancelled", "Abandoned", "merged"],
      ["Count lines too", "Pending"],
    ]);
    const other = await projectWith([["Parse the config", "Pending"]]);
    expect((await gate()).map((item) => item.id).sort()).toEqual([stopped.taskIds[4], other.taskIds[0]].sort());
    const stop = await sendStop(stopped.projectId, "Budget moved to another project.");

    const outcomes = await stopSteps();

    expect(outcomes).toEqual([
      { kind: "stopped", reportDue: true, stopId: stop.id, projectId: stopped.projectId },
      { kind: "posted", projectId: stopped.projectId, terminal: "stopped" },
    ]);
    expect(await projectRow(stopped.projectId)).toEqual({ status: "stopped", errorClass: null, reason: null });
    expect(await projectRow(other.projectId)).toEqual({ status: "active", errorClass: null, reason: null });
    expect((await new ClientMessageRepository(db).findById(stop.id))?.consumedAt).toBeInstanceOf(Date);

    const reports = await stopReports(stopped.projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("stopped at your request");
    // Exactly the tasks whose merge commit is on record: not the attempt log, not task status.
    expect(reports[0]).toContain('"Count words in a file"');
    expect(reports[0]).toContain('"Merged, then cancelled"');
    expect(reports[0]).not.toContain("Count lines too");
    expect(reports[0]).not.toContain("Marked done by hand");
    expect(reports[0]).not.toContain("Write the checks");
    expect(reports[0]).not.toMatch(/plan (is )?complete/i);
    // The table of the stop's terminal sweep closes it: this project has no contract on record.
    expect(reports[0]).toMatch(/\n\nNo contract is on record for this project at sweep [0-9a-f-]{36}, so no guarantee is judged\.$/);
    expect(await stopReports(other.projectId)).toEqual([]);

    // Never dispatched afterwards, and its open tender is never taken in.
    expect((await gate()).map((item) => item.id)).toEqual([other.taskIds[0]]);
    const openTenders = (await createIntakeStore(db).openTenders()).map((tender) => tender.projectId);
    expect(openTenders).not.toContain(stopped.projectId);
    expect(openTenders).toContain(other.projectId);

    // A second stop is consumed and not answered.
    const again = await sendStop(stopped.projectId, "Stop.");
    expect(await stopSteps()).toEqual([
      { kind: "already-stopped", stopId: again.id, projectId: stopped.projectId },
    ]);
    expect((await new ClientMessageRepository(db).findById(again.id))?.consumedAt).toBeInstanceOf(Date);
    expect(await stopReports(stopped.projectId)).toHaveLength(1);
    expect(await stopSteps()).toEqual([]);
  });

  test("a stop not yet consumed already keeps its project out of gating, intake, roster, first planning and reports", async () => {
    // Each reader is shown a project it would admit, so each exclusion is the stop's doing.
    const dispatchable = await projectWith([["Write the parser", "Pending"]]);
    const withVision = async (): Promise<ProjectId> => {
      const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Plan it.");
      ourProjects.add(project.id);
      await db.execute(sql`
        INSERT INTO vision_documents (project_id, version, vision_text, summary) VALUES (${project.id}, 1, 'v', 'v')`);
      return project.id;
    };
    const unstaffed = await withVision();
    const awaiting = await withVision();
    await db.execute(sql`
      INSERT INTO roster_roles (project_id, revision, role_id, name, responsibility, capabilities, vision_version)
      VALUES (${awaiting}, 1, ${randomUUID()}, 'Implementer', 'Builds it.', ARRAY['write-source'], 1)`);
    const planned = await projectWith([["Ship it", "Pending"]]);
    await db.execute(sql`INSERT INTO project_plans (project_id, first_planned_at) VALUES (${planned.projectId}, now())`);

    const gated = async () => (await gate()).map((item) => item.id);
    const tenders = async () => (await createIntakeStore(db).openTenders()).map((tender) => tender.projectId);
    const toStaff = async () => (await createRosterStore(db).projectsAwaitingRoster()).map((row) => row.projectId);
    const toPlan = async () => (await createFirstPlanStore(db).projectsAwaitingPlan()).map((row) => row.projectId);
    const toReport = async () => (await listDuePlanReports(db)).map((row) => row.projectId);
    expect(await gated()).toContain(dispatchable.taskIds[0]);
    expect(await tenders()).toContain(awaiting);
    expect(await toStaff()).toContain(unstaffed);
    expect(await toPlan()).toContain(awaiting);
    expect(await toReport()).toContain(planned.projectId);

    for (const projectId of [dispatchable.projectId, unstaffed, awaiting, planned.projectId]) {
      await sendStop(projectId, "Stop now.");
    }

    expect(await gated()).not.toContain(dispatchable.taskIds[0]);
    expect(await tenders()).not.toContain(awaiting);
    expect(await toStaff()).not.toContain(unstaffed);
    expect(await toPlan()).not.toContain(awaiting);
    expect(await toReport()).not.toContain(planned.projectId);

    // The next cycle's stop step then stops all four.
    expect((await stopSteps()).map((outcome) => outcome.kind)).toEqual([
      "stopped",
      "stopped",
      "stopped",
      "stopped",
      "posted",
      "posted",
      "posted",
      "posted",
    ]);
  });

  test("a blocked project the client stops keeps its blocked cause; nothing merged is said plainly", async () => {
    const project = await projectWith([["Set up the studio list", "Pending"]]);
    await new ProjectHaltRepository(db).block(project.projectId, { category: "fault", errorClass: "TestBlock", reason: "blocked by the test" });
    await sendStop(project.projectId, "Never mind.");

    const [outcome] = await stopSteps();

    expect(outcome).toMatchObject({ kind: "stopped", reportDue: true });
    expect(await projectRow(project.projectId)).toEqual({
      status: "stopped",
      errorClass: "TestBlock",
      reason: "blocked by the test",
    });
    const reports = await stopReports(project.projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("No merged work is on record for this project.");
    expect(reports[0]).toContain("Work on it was already paused when your request arrived.");
  });

  // The stop's report carries the table of the stop's terminal sweep when it is on record; a stop
  // whose sweep never was is still told, its table judged on no sweep.
  test("a stop whose terminal sweep is not on record is not told: its report waits for the sweep, then carries it", async () => {
    const { projectId } = await projectWith([]);
    await writeContract(projectId);
    const stop = await sendStop(projectId, "Stop, please.");
    const reports = unsweptReports(projectId, true);

    expect(await reports.runPending()).toEqual([{ kind: "stopped", reportDue: true, stopId: stop.id, projectId }]);
    expect(await reports.tellPending()).toEqual([]);
    expect(await stopReports(projectId)).toEqual([]);

    await sweepTerminalsOf(db, (id) => id === projectId);
    expect(await reports.tellPending()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    const [body = ""] = await stopReports(projectId);
    expect(body).toContain("Work on this project has stopped at your request.");
    expect(body).not.toContain("no sweep of main is on record for it");
    const stored = await db.execute(sql`
      SELECT guarantee_id AS "guaranteeId", sweep_id AS "sweepId", verdict, reason FROM guarantee_verdicts WHERE project_id = ${projectId} ORDER BY guarantee_id`);
    const verdicts = StoredVerdictsSchema.parse(stored.rows);
    expect(verdicts.map((verdict) => verdict.guaranteeId)).toEqual(["G1", "G2"]);
    expect(verdicts.every((verdict) => verdict.sweepId !== null)).toBe(true);
  });

  test("a stop whose sweep's guarantee records do not hold together is told once that its table cannot be read, never retried", async () => {
    const { projectId } = await projectWith([]);
    const stop = await sendStop(projectId, "Stop, please.");
    const reports = unsweptReports(projectId, false);
    await reports.runPending();
    await sweepTerminalsOf(db, (id) => id === projectId);
    // Evidence naming a vision version the project does not hold: the sweep's records cannot be read as a table.
    await db.execute(sql`
      INSERT INTO guarantee_evidence (project_id, sweep_id, vision_version, guarantee_id, main_commit, checks)
      SELECT ${projectId}, s.id, 7, 'G1', NULL, '[]'::jsonb FROM acceptance_sweeps s WHERE s.stop_id = ${stop.id}`);

    expect(await reports.tellPending()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    expect(await reports.tellPending()).toEqual([]);

    const posted = await stopReports(projectId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/Ashara's records of this project's guarantees at sweep [0-9a-f-]{36} do not hold together, so no guarantee is judged in this message/);
  });

  /** Ashara's proposal to narrow `key` of vision v1, written to vision_revisions; it awaits the client's confirmation. */
  async function proposeNarrowing(projectId: ProjectId, key: string, statement: string): Promise<void> {
    await new VisionRepository(db).propose(projectId, 1, {
      author: "ashara",
      sourceMessageId: null,
      approver: null,
      direction: "narrows",
      cause: "ashara-decision",
      ops: [{ target: "guarantee", action: "amend", key, direction: "narrows", labelled: null, read: null, statement }],
      pushback: null,
    });
  }

  test("a contract revision written to the database is told in the stop report's appendix", async () => {
    const { projectId } = await projectWith([]);
    await writeContract(projectId);
    await proposeNarrowing(projectId, "G1", "A get returns some value put for its key.");
    await sendStop(projectId, "Stop, please.");
    const reports = unsweptReports(projectId, false);
    await reports.runPending();
    await sweepTerminalsOf(db, (id) => id === projectId);

    expect(await reports.tellPending()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);

    const [body = ""] = await stopReports(projectId);
    const appendix = body.slice(body.indexOf("Appendix, how your contract has been revised:"));
    expect(appendix).toContain("Narrowings Ashara has proposed that you have not confirmed");
    expect(appendix).toContain(
      "- G1 (as it stands: A get returns the value of the last put of its key.) | Ashara proposes to amend it to: A get returns some value put for its key.",
    );
  });

  test("a contract revision naming a guarantee its version does not hold is told once as a table that cannot be read, never retried", async () => {
    const { projectId } = await projectWith([]);
    await writeContract(projectId);
    await proposeNarrowing(projectId, "G9", "A key lives for ever.");
    await sendStop(projectId, "Stop, please.");
    const reports = unsweptReports(projectId, false);
    await reports.runPending();
    await sweepTerminalsOf(db, (id) => id === projectId);

    expect(await reports.tellPending()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    expect(await reports.tellPending()).toEqual([]);

    const posted = await stopReports(projectId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/Ashara's records of this project's guarantees at sweep [0-9a-f-]{36} do not hold together, so no guarantee is judged in this message/);
  });
});
