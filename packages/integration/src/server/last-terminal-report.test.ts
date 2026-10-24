import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";
import { parseProjectId } from "@ashara/shared";

// The verdicts of a project's last terminal report, as run-report and the trust ledger read them:
// the last terminal report is the newest message that tells a terminal, whether or not it carries a
// verdict row, and an older report's rows never stand in for its own. Every row belongs to a
// project this suite creates; afterAll deletes it.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `last-terminal-report-test-${randomUUID().slice(0, 8)}`;
const IdRowSchema = z.object({ id: z.string() });

let db: Database;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM guarantee_verdicts WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

async function report(at: string, reportsOn: string | null): Promise<string> {
  const rows = await db.execute(sql`
    INSERT INTO client_messages (project_id, direction, kind, body, reports_on, created_at)
    VALUES (${projectId}, 'outbound', 'report', 'scripted report', ${reportsOn}, ${at}) RETURNING id`);
  return IdRowSchema.parse(rows.rows[0]).id;
}

async function unjudged(reportId: string, guaranteeId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO guarantee_verdicts (project_id, report_id, sweep_id, vision_version, guarantee_id, verdict, reason, basis, evidence_class)
    VALUES (${projectId}, ${reportId}, NULL, 1, ${guaranteeId}, 'unjudged', 'no-sweep-on-commit', 'client-stated', 'none')`);
}

describe("lastReportGuaranteeVerdictsOf", () => {
  test("reads the last terminal report's rows, and says so when it carries none, never pairing an older report's", async () => {
    expect(await lastReportGuaranteeVerdictsOf(db, projectId)).toEqual({ kind: "no-terminal-report" });

    // A halt's report, with its verdicts.
    await new ProjectHaltRepository(db).block(parseProjectId(projectId, "test project"), { category: "fault", errorClass: "TestBlock", reason: "blocked by the test" });
    const halt = await report("2026-10-18T00:01:00Z", null);
    await db.execute(sql`INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id)
      SELECT 'project-blocked', b.id, b.project_id, ${halt} FROM project_blocks b WHERE b.project_id = ${projectId}`);
    await unjudged(halt, "G1");
    const haltRows = { kind: "verdicts", reportId: halt, rows: [{ reportId: halt, guaranteeId: "G1", verdict: "unjudged", reason: "no-sweep-on-commit", evidenceClass: "none" }] };
    expect(await lastReportGuaranteeVerdictsOf(db, projectId)).toEqual(haltRows);

    // A later report that tells no terminal (a burn warning, say) is not the last terminal report.
    await report("2026-10-18T00:02:00Z", null);
    expect(await lastReportGuaranteeVerdictsOf(db, projectId)).toEqual(haltRows);

    // The client's stop report, with no verdict row stored beside it, is: the halt's rows do not stand in for it.
    const stop = await report("2026-10-18T00:03:00Z", "client-stop");
    expect(await lastReportGuaranteeVerdictsOf(db, projectId)).toEqual({ kind: "no-verdicts", reportId: stop });
  });
});
