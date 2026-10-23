import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import type { Clock, ProjectId } from "@ashara/shared";
import { createTerminalReportStore } from "@ashara/server/terminal-report-store";
import { dueProjectOf } from "./terminal-reports.js";

// A failed delivered report waits out its backoff on the injected clock, the time the cycle runs on,
// never the database's: the retry is set from that clock and falls due only once that clock passes it,
// whatever the database's own clock reads. The fake clock reads a time far from the database's, so a
// backoff set or read on the database's clock is told apart.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `delivered-retry-clock-test-${randomUUID().slice(0, 8)}`;
const T0 = Date.UTC(2001, 0, 1);

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

/** A project accepted on a passed acceptance sweep on main, as Quality's acceptance records them; the sweep's id. */
async function acceptedSweep(): Promise<{ readonly projectId: ProjectId; readonly sweepId: string }> {
  const project = await new ProjectHaltRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  ourProjects.add(project.id);
  const inserted = await db.execute(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
    VALUES (${project.id}, ${"d".repeat(40)}, 'env-1', '[]'::jsonb, '[]'::jsonb, true, 'delivered-retry-clock sweep') RETURNING id`);
  await db.execute(sql`UPDATE projects SET lifecycle = 'accepted', workspace_path = '/nonexistent/delivered-retry-clock' WHERE id = ${project.id}`);
  const [row] = inserted.rows;
  const sweepId = row?.["id"];
  if (typeof sweepId !== "string") throw new Error("the acceptance sweep insert returned no id");
  return { projectId: project.id, sweepId };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

afterAll(async () => {
  for (const id of ourProjects) {
    for (const table of ["told_reports", "delivered_report_attempts", "acceptance_sweeps"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${id}`);
    }
    await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a delivered report's retry", () => {
  test("is set and falls due on the injected clock, not the database's", async () => {
    const { projectId, sweepId } = await acceptedSweep();
    let now = T0;
    const clock: Clock = { now: () => now };
    const store = createTerminalReportStore(db, clock);
    const listed = async (): Promise<boolean> => (await store.dueTerminals(["delivered"])).some((due) => dueProjectOf(due) === projectId);

    expect(await listed()).toBe(true);
    await store.recordDeliveredFailure(sweepId, { error: "the report failed", interfaceRead: false, recordUnread: false, retryAfterSeconds: 60 });

    now = T0 + 59_000;
    expect(await listed()).toBe(false);
    now = T0 + 61_000;
    expect(await listed()).toBe(true);
  });
});
