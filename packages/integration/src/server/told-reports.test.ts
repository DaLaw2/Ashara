import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, MIGRATIONS_DIR, ProjectRepository, createDb, createPgPool, resolveTestDatabaseUrl, runMigrations } from "@ashara/db";
import type { PoolFactory } from "@ashara/db";
import { ProjectHaltRepository, endHaltOnStop, listDuePlanRevisionReports } from "@ashara/delivery";
import {
  ClientMessageRepository,
  listDueBlockReports,
  listDueDeliveredReports,
  postDeliveredReport,
  postPlanReport,
  postPlanRevisionReport,
  postProjectBlockReport,
  recordClientStop,
} from "@ashara/engagement";
import { readSweepOutcome } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";

// Each report the Liaison tells of another context's subject (a halt and its resumption, a passed
// sweep, a plan revision) is recorded on Engagement's own told record in the transaction that posts
// it, keyed by the subject: told once across a restart, and, on a database whose told reports were
// kept on the other contexts' rows, told once after the migration that moves them. The client's stop
// ends a halt through Delivery's own write in the stop's transaction, with no trigger behind it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const TOLD_MIGRATION = "015_told_reports.sql";

type Db = ReturnType<typeof createDb>;

/** A database handle whose pool this suite ends, so a "restart" is a new pool over the same rows. */
function connect(url: string): { readonly db: Db; readonly end: () => Promise<void> } {
  const pools: Array<ReturnType<PoolFactory>> = [];
  const factory: PoolFactory = (config) => {
    const pool = createPgPool(config);
    pools.push(pool);
    return pool;
  };
  return { db: createDb(url, factory), end: async () => void (await Promise.all(pools.map((pool) => pool.end()))) };
}

const noReview = async (): Promise<null> => null;
const IdRows = z.array(z.object({ id: z.string() }));
const CountRows = z.array(z.object({ n: z.number() })).length(1);

async function idOf(db: Db, statement: ReturnType<typeof sql>): Promise<string> {
  const [row] = IdRows.length(1).parse((await db.execute(statement)).rows);
  if (row === undefined) throw new Error("the statement returned no id");
  return row.id;
}

async function countOf(db: Db, statement: ReturnType<typeof sql>): Promise<number> {
  const [row] = CountRows.parse((await db.execute(statement)).rows);
  if (row === undefined) throw new Error("the count returned no row");
  return row.n;
}

async function outboundReports(db: Db, projectId: string): Promise<number> {
  return countOf(db, sql`SELECT count(*)::int AS n FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound'`);
}

/** The subjects each listing names: halts and resumptions, passed sweeps, plan revisions. */
async function dueSubjects(db: Db): Promise<{ halts: string[]; resumptions: string[]; sweeps: string[]; revisions: string[] }> {
  const blocks = await listDueBlockReports(db, noReview);
  const episodes = (subject: "project-blocked" | "project-resumed") =>
    blocks.flatMap((due) => ("subject" in due && due.subject === subject ? [due.episodeId] : "id" in due && due.id.startsWith(`${subject}:`) ? [due.id.slice(subject.length + 1)] : []));
  return {
    halts: episodes("project-blocked"),
    resumptions: episodes("project-resumed"),
    sweeps: (await listDueDeliveredReports(db, readSweepOutcome)).map((due) => due.sweepId),
    revisions: (await listDuePlanRevisionReports(db)).map((due) => ("revisionId" in due ? due.revisionId : due.id)),
  };
}

const fault = { category: "fault", errorClass: "ToldReportsTestFault", reason: "halted by the told-reports test" } as const;

describe("a report on another context's subject is told once across a restart", () => {
  let session: ReturnType<typeof connect>;
  let clientId: string;
  const ours: string[] = [];

  async function newProject(): Promise<ProjectId> {
    const project = await new ProjectRepository(session.db).create(`told-reports-${randomUUID().slice(0, 8)}`, clientId);
    ours.push(project.id);
    return project.id;
  }

  async function restart(): Promise<void> {
    await session.end();
    session = connect(DATABASE_URL);
  }

  beforeAll(async () => {
    session = connect(DATABASE_URL);
    clientId = (await new ClientRepository(session.db).create(`told-reports-test-${randomUUID()}`)).id;
  });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    for (const id of ours) {
      for (const table of ["told_reports", "delivered_report_attempts", "guarantee_verdicts", "client_messages", "project_blocks", "acceptance_sweeps", "plan_revisions"]) {
        await session.db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${id}`);
      }
      await session.db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
    }
    await session.db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
    await session.end();
  });

  test("a halt's report and its resumption's", async () => {
    const projectId = await newProject();
    const halts = new ProjectHaltRepository(session.db);
    await halts.block(projectId, fault);
    const [episode] = IdRows.parse((await session.db.execute(sql`SELECT id FROM project_blocks WHERE project_id = ${projectId}`)).rows);
    if (episode === undefined) throw new Error("the halt opened no episode");

    expect((await dueSubjects(session.db)).halts).toContain(episode.id);
    expect(await postProjectBlockReport(session.db, episode.id, "blocked", "Work on this project is paused.", null)).toBe("posted");
    await restart();
    expect((await dueSubjects(session.db)).halts).not.toContain(episode.id);
    expect(await postProjectBlockReport(session.db, episode.id, "blocked", "Work on this project is paused.", null)).toBe("already-posted");

    await new ProjectHaltRepository(session.db).unblock(projectId, "operator-a", "cleared");
    expect((await dueSubjects(session.db)).resumptions).toContain(episode.id);
    expect(await postProjectBlockReport(session.db, episode.id, "resumed", "Work on this project has resumed.", null)).toBe("posted");
    await restart();
    expect((await dueSubjects(session.db)).resumptions).not.toContain(episode.id);
    expect(await postProjectBlockReport(session.db, episode.id, "resumed", "Work on this project has resumed.", null)).toBe("already-posted");
    expect(await outboundReports(session.db, projectId)).toBe(2);
  });

  test("a passed sweep's delivered report", async () => {
    const projectId = await newProject();
    const sweepId = await idOf(
      session.db,
      sql`INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
          VALUES (${projectId}, ${"a".repeat(40)}, 'env-1', '[]'::jsonb, '[]'::jsonb, true, 'told-reports sweep') RETURNING id`,
    );
    await session.db.execute(sql`UPDATE projects SET lifecycle = 'accepted', workspace_path = '/nonexistent/told-reports' WHERE id = ${projectId}`);

    expect((await dueSubjects(session.db)).sweeps).toContain(sweepId);
    expect(await postDeliveredReport(session.db, sweepId, "Your project is delivered.", { sweepId, verdicts: [] })).toBe("posted");
    await restart();
    expect((await dueSubjects(session.db)).sweeps).not.toContain(sweepId);
    expect(await postDeliveredReport(session.db, sweepId, "Your project is delivered.", { sweepId, verdicts: [] })).toBe("already-posted");
    expect(await outboundReports(session.db, projectId)).toBe(1);
  });

  test("a plan revision's report, and a revision the first-plan report describes", async () => {
    const projectId = await newProject();
    await session.db.execute(sql`UPDATE projects SET first_planned_at = now() WHERE id = ${projectId}`);
    const revision = async (n: number) =>
      idOf(session.db, sql`INSERT INTO plan_revisions (project_id, revision, vision_version, kind, summary) VALUES (${projectId}, ${n}, 1, 'repair', '{}'::jsonb) RETURNING id`);
    const folded = await revision(2);

    expect(await postPlanReport(session.db, projectId, "first-plan", "The plan.", [folded], null)).toBe("posted");
    await restart();
    expect((await dueSubjects(session.db)).revisions).not.toContain(folded);
    expect(await postPlanRevisionReport(session.db, { revisionId: folded, projectId, requestedBy: null }, "The revision.")).toBe("already-posted");

    const later = await revision(3);
    expect((await dueSubjects(session.db)).revisions).toContain(later);
    expect(await postPlanRevisionReport(session.db, { revisionId: later, projectId, requestedBy: null }, "The revision.")).toBe("posted");
    await restart();
    expect((await dueSubjects(session.db)).revisions).not.toContain(later);
    expect(await postPlanRevisionReport(session.db, { revisionId: later, projectId, requestedBy: null }, "The revision.")).toBe("already-posted");
    expect(await outboundReports(session.db, projectId)).toBe(2);
  });

  test("the client's stop ends the halt it finds through Delivery's write; no trigger ends it", async () => {
    expect(await countOf(session.db, sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'projects_stop_ends_halt'`)).toBe(0);
    const projectId = await newProject();
    await new ProjectHaltRepository(session.db).block(projectId, fault);
    const stop = async () => (await new ClientMessageRepository(session.db).insertInbound({ projectId, kind: "stop", body: "Stop.", inReplyTo: null })).id;

    // A stop whose port ends nothing leaves a stopped project halted, which the commit refuses.
    const ignored = await stop();
    await expect(recordClientStop(session.db, { id: ignored, projectId }, async () => {})).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/halted while its lifecycle is stopped/) },
    });
    await session.db.execute(sql`DELETE FROM client_messages WHERE id = ${ignored}`);

    const stopId = await stop();
    expect(await recordClientStop(session.db, { id: stopId, projectId }, endHaltOnStop)).toEqual({ kind: "stopped", reportDue: true });
    const episodes = z
      .array(z.object({ endKind: z.string().nullable() }))
      .parse((await session.db.execute(sql`SELECT end_kind AS "endKind" FROM project_blocks WHERE project_id = ${projectId}`)).rows);
    expect(episodes).toEqual([{ endKind: "client_stop" }]);
  });
});

describe("after the migration that moves the told record, no subject already told is told again", () => {
  const name = `${new URL(DATABASE_URL).pathname.slice(1)}_told_${randomBytes(6).toString("hex")}`;
  const fresh = new URL(DATABASE_URL);
  fresh.pathname = `/${name}`;
  let server: ReturnType<typeof connect>;
  let dir = "";

  beforeAll(async () => {
    server = connect(DATABASE_URL);
    await server.db.execute(sql.raw(`CREATE DATABASE ${name}`));
    dir = mkdtempSync(join(tmpdir(), "ashara-told-"));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < TOLD_MIGRATION)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    await runMigrations(fresh.toString(), dir);
  }, 60_000);

  afterAll(async () => {
    await server.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await server.end();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("every halt, resumption, delivered sweep and plan revision told on the old columns stays told; the untold stay due", async () => {
    const before = connect(fresh.toString());
    const db = before.db;
    const told = new Map<string, string>();
    const untold = new Map<string, string>();
    try {
      const clientId = await idOf(db, sql`INSERT INTO clients (name) VALUES ('told-migration') RETURNING id`);
      const project = async (extra: ReturnType<typeof sql> = sql``) =>
        idOf(db, sql`INSERT INTO projects (name, client_id) VALUES (${randomUUID()}, ${clientId}) RETURNING id ${extra}`);
      const report = async (projectId: string) =>
        idOf(db, sql`INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'outbound', 'report', 'kept report') RETURNING id`);
      const halted = async (reported: boolean) => {
        const projectId = await project();
        await db.transaction(async (tx) => {
          await tx.execute(sql`UPDATE projects SET blocked_category = 'fault', blocked_error_class = 'KeptFault', blocked_reason = 'x' WHERE id = ${projectId}`);
          await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${projectId}, 'fault', 'KeptFault', 'x')`);
        });
        const episode = await idOf(db, sql`SELECT id FROM project_blocks WHERE project_id = ${projectId}`);
        if (reported) await db.execute(sql`UPDATE project_blocks SET report_id = ${await report(projectId)} WHERE id = ${episode}`);
        return episode;
      };
      told.set("halt", await halted(true));
      untold.set("halt", await halted(false));

      const resumedProject = await project();
      const resumed = await idOf(
        db,
        sql`INSERT INTO project_blocks (project_id, kind, error_class, reason, ended_at, end_kind, unblocked_by, unblock_reason, report_id, resumed_report_id)
            VALUES (${resumedProject}, 'fault', 'KeptFault', 'x', now(), 'unblocked', 'operator', 'cleared', ${await report(resumedProject)}, ${await report(resumedProject)})
            RETURNING id`,
      );
      told.set("resumption", resumed);

      const accepted = async (reported: boolean) => {
        const projectId = await project();
        const reportId = reported ? await report(projectId) : null;
        const sweepId = await idOf(
          db,
          sql`INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, report_id,
                report_failures, report_interface_read_failures, report_record_failures, report_last_error, report_retry_at)
              VALUES (${projectId}, ${"b".repeat(40)}, 'env-1', '[]'::jsonb, '[]'::jsonb, true, 'kept sweep', ${reportId},
                2, 1, 1, 'kept error', ${reported ? null : sql`now() - interval '1 minute'`}) RETURNING id`,
        );
        await db.execute(sql`UPDATE projects SET lifecycle = 'accepted', workspace_path = '/nonexistent/told-migration' WHERE id = ${projectId}`);
        return sweepId;
      };
      told.set("sweep", await accepted(true));
      untold.set("sweep", await accepted(false));

      const planned = await project();
      await db.execute(sql`UPDATE projects SET first_planned_at = now() WHERE id = ${planned}`);
      await db.execute(sql`INSERT INTO client_messages (project_id, direction, kind, body, reports_on) VALUES (${planned}, 'outbound', 'report', 'first plan', 'first-plan')`);
      told.set(
        "revision",
        await idOf(db, sql`INSERT INTO plan_revisions (project_id, revision, vision_version, kind, summary, report_id) VALUES (${planned}, 2, 1, 'repair', '{}'::jsonb, ${await report(planned)}) RETURNING id`),
      );
      untold.set("revision", await idOf(db, sql`INSERT INTO plan_revisions (project_id, revision, vision_version, kind, summary) VALUES (${planned}, 3, 1, 'repair', '{}'::jsonb) RETURNING id`));
    } finally {
      await before.end();
    }

    copyFileSync(join(MIGRATIONS_DIR, TOLD_MIGRATION), join(dir, TOLD_MIGRATION));
    expect((await runMigrations(fresh.toString(), dir)).applied).toEqual([TOLD_MIGRATION]);

    const after = connect(fresh.toString());
    try {
      const due = await dueSubjects(after.db);
      expect(due.halts).not.toContain(told.get("halt"));
      expect(due.halts).toContain(untold.get("halt"));
      expect(due.resumptions).not.toContain(told.get("resumption"));
      expect(due.sweeps).not.toContain(told.get("sweep"));
      expect(due.sweeps).toContain(untold.get("sweep"));
      expect(due.revisions).not.toContain(told.get("revision"));
      expect(due.revisions).toContain(untold.get("revision"));

      const reports = await countOf(after.db, sql`SELECT count(*)::int AS n FROM client_messages WHERE direction = 'outbound'`);
      const halt = told.get("halt");
      const resumption = told.get("resumption");
      const sweep = told.get("sweep");
      const revision = told.get("revision");
      if (halt === undefined || resumption === undefined || sweep === undefined || revision === undefined) throw new Error("a told subject was not seeded");
      expect(await postProjectBlockReport(after.db, halt, "blocked", "again", null)).toBe("already-posted");
      expect(await postProjectBlockReport(after.db, resumption, "resumed", "again", null)).toBe("already-posted");
      expect(await postDeliveredReport(after.db, sweep, "again", { sweepId: sweep, verdicts: [] })).toBe("already-posted");
      const revisionProject = await idOf(after.db, sql`SELECT project_id AS id FROM plan_revisions WHERE id = ${revision}`);
      expect(await postPlanRevisionReport(after.db, { revisionId: revision, projectId: revisionProject, requestedBy: null }, "again")).toBe("already-posted");
      expect(await countOf(after.db, sql`SELECT count(*)::int AS n FROM client_messages WHERE direction = 'outbound'`)).toBe(reports);

      // The failed attempts of a delivered report are kept on Engagement's own record.
      const attempts = z
        .array(z.object({ failures: z.number(), interfaceReadFailures: z.number(), recordFailures: z.number(), lastError: z.string().nullable() }))
        .parse(
          (
            await after.db.execute(sql`SELECT failures, interface_read_failures AS "interfaceReadFailures", record_failures AS "recordFailures", last_error AS "lastError"
              FROM delivered_report_attempts WHERE sweep_id = ${sweep}`)
          ).rows,
        );
      expect(attempts).toEqual([{ failures: 2, interfaceReadFailures: 1, recordFailures: 1, lastError: "kept error" }]);
      expect(await countOf(after.db, sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'projects_stop_ends_halt'`)).toBe(0);
    } finally {
      await after.end();
    }
  }, 120_000);
});
