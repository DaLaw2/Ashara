import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { composedAgain, storedVerdicts } from "./run-state.js";

// The replay's reading of today's reports: which violation keys are about a text composed again, and
// the verdicts stored beside each report, a message no sweep was on record for among them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `run-state-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("composedAgain", () => {
  const planningStopped = { table: "client_messages", subject: "planning-stopped", id: "m1", projectId: "p1", reportId: "m1" } as const;
  const stopped = { table: "client_messages", subject: "client-stop", id: "m2", projectId: "p1", reportId: "m2" } as const;

  test("the planning-stopped report's table is composed again when its kept report was set aside and posted again", () => {
    expect(composedAgain("guarantee-table:planning-stopped", "p1", [planningStopped])).toBe(true);
    expect(composedAgain("guarantee-table:planning-stopped", "p1", [stopped])).toBe(false);
    expect(composedAgain("guarantee-table:planning-stopped", "p2", [planningStopped])).toBe(false);
  });

  test("the stop report and its table are composed again when its kept report was set aside and posted again", () => {
    expect(composedAgain("guarantee-table:stop", "p1", [stopped])).toBe(true);
    expect(composedAgain("stop-merges", "p1", [stopped])).toBe(true);
    expect(composedAgain("guarantee-table:stop", "p1", [planningStopped])).toBe(false);
  });
});

describe("storedVerdicts", () => {
  test("reads a verdict of a message no sweep was on record for, its sweep null", async () => {
    const [report] = (
      await db.execute(sql`
        INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'outbound', 'report', 'Work on this project is paused.')
        RETURNING id`)
    ).rows;
    const reportId = String(report?.["id"]);
    await db.execute(sql`
      INSERT INTO guarantee_verdicts (project_id, report_id, sweep_id, vision_version, guarantee_id, verdict, reason, basis, evidence_class)
      VALUES (${projectId}, ${reportId}, NULL, 1, 'G1', 'unjudged', 'no-sweep-on-commit', 'client-stated', 'none')`);

    expect(await storedVerdicts(db, projectId)).toEqual([
      { reportId, sweepId: null, visionVersion: 1, guaranteeId: "G1", verdict: "unjudged", reason: "no-sweep-on-commit", evidenceClass: "none" },
    ]);
  });
});
