import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, createDb, resolveTestDatabaseUrl, type Database } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";

// Every row here belongs to a project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projects: ProjectHaltRepository;
let clientId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  projects = new ProjectHaltRepository(db);
  clientId = (await new ClientRepository(db).create(`active-projects-test-${NONCE}-client`)).id;
});

afterAll(async () => {
  const pattern = `active-projects-test-${NONCE}-%`;
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("Dispatch held until the first plan is reported", () => {
  // The first-plan report says none of the plan's tasks has started: a project dispatched while a
  // faulted post of it waits for its retry could never be reported on, so the gate's read omits it.
  test("a planned project is listed active only once its first-plan report is posted", async () => {
    const unplanned = await projects.create(`active-projects-test-${NONCE}-unplanned`, clientId);
    const planned = await projects.create(`active-projects-test-${NONCE}-planned`, clientId);
    await db.execute(sql`UPDATE projects SET first_planned_at = now() WHERE id = ${planned.id}`);

    const active = await projects.listActiveIds();
    expect(active).toContain(unplanned.id);
    expect(active).not.toContain(planned.id);

    // A report on another subject is not the first-plan report.
    await db.execute(sql`
      INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
      VALUES (${planned.id}, 'outbound', 'report', 'Your stack.', 'stack-choice')`);
    expect(await projects.listActiveIds()).not.toContain(planned.id);

    await db.execute(sql`
      INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
      VALUES (${planned.id}, 'outbound', 'report', 'Your plan.', 'first-plan')`);
    expect(await projects.listActiveIds()).toContain(planned.id);
  });
});
