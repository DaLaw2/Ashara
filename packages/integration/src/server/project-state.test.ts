import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { ClientMessageRepository, acceptProject, recordClientStop } from "@ashara/engagement";
import type { ProjectId } from "@ashara/shared";
import { projectState } from "../simulator/project-state.js";

// The lifecycle (Engagement's) and the halt (Delivery's open block
// episode) are separate records, each written through its owner's guard. The state the client sees
// is unchanged for every combination the two guards can reach: 'blocked' while halted, otherwise the
// lifecycle. Each project here is driven through the guards only, and read three ways: the
// repository the web client lists from, the single read, and the oracle's own SQL.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `project-state-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;

const fault = { category: "fault", errorClass: "RecordUnreadable", reason: "a bad record" } as const;

async function newProject(): Promise<ProjectId> {
  return (await new ProjectRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId)).id;
}

async function halt(projectId: ProjectId): Promise<string> {
  return new ProjectHaltRepository(db).block(projectId, fault);
}

/** The client's stop through Engagement's guard; returns whether the stop recorded the project as paused. */
async function stop(projectId: ProjectId): Promise<boolean> {
  const message = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body: "Stop.", inReplyTo: null });
  await recordClientStop(db, { id: message.id, projectId });
  const result = await db.execute(sql`SELECT stop_found_halted AS paused FROM client_messages WHERE id = ${message.id}`);
  return z.array(z.object({ paused: z.boolean() })).length(1).parse(result.rows)[0]?.paused === true;
}

/** A passed sweep on record (what the acceptance guard requires), then Engagement's accept, in one transaction. */
async function accept(projectId: ProjectId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await tx.execute(sql`
      INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
      VALUES (${projectId}, ${"a".repeat(40)}, 'v1', '[]'::jsonb, '[]'::jsonb, true, 'all suites passed')`);
    await acceptProject(tx, projectId);
  });
}

/** The client-visible state, read the three ways; they must agree. */
async function stateOf(projectId: ProjectId): Promise<string> {
  const listed = (await new ProjectHaltRepository(db).listByClient(clientId)).find((project) => project.id === projectId)?.status;
  const single = (await new ProjectHaltRepository(db).get(projectId))?.status;
  const oracle = z
    .array(z.object({ status: z.string() }))
    .parse((await db.execute(sql`SELECT ${projectState} AS status FROM projects WHERE id = ${projectId}`)).rows)[0]?.status;
  expect(new Set([listed, single, oracle]).size).toBe(1);
  return z.string().parse(single);
}

async function openEpisodes(projectId: ProjectId): Promise<number> {
  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ n: z.number() })).parse(rows.rows)[0]?.n ?? -1;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("the client-visible project state, composed from the lifecycle and the halt", () => {
  test("active, halted, resumed: active, blocked, active", async () => {
    const projectId = await newProject();
    expect(await stateOf(projectId)).toBe("active");
    expect(await halt(projectId)).toBe("blocked");
    expect(await stateOf(projectId)).toBe("blocked");
    expect(await halt(projectId)).toBe("already-blocked");
    await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "the record was repaired");
    expect(await stateOf(projectId)).toBe("active");
    expect(await openEpisodes(projectId)).toBe(0);
  });

  test("a halted project the client stops is stopped, its halt ended, the stop recording it was paused; a stopped project is never halted", async () => {
    const projectId = await newProject();
    await halt(projectId);
    expect(await stop(projectId)).toBe(true);
    expect(await stateOf(projectId)).toBe("stopped");
    expect(await openEpisodes(projectId)).toBe(0);
    const ended = await db.execute(sql`SELECT end_kind AS "endKind" FROM project_blocks WHERE project_id = ${projectId}`);
    expect(ended.rows).toEqual([{ endKind: "client_stop" }]);
    expect(await halt(projectId)).toBe("already-blocked");
    expect(await stateOf(projectId)).toBe("stopped");
    await expect(new ProjectHaltRepository(db).unblock(projectId, "operator-a", "x")).rejects.toMatchObject({ name: "ProjectNotBlocked" });
  });

  test("an active project the client stops is stopped and the stop records no pause", async () => {
    const projectId = await newProject();
    expect(await stop(projectId)).toBe(false);
    expect(await stateOf(projectId)).toBe("stopped");
  });

  test("an accepted project is accepted, is never halted, and the client's stop ends it", async () => {
    const projectId = await newProject();
    await accept(projectId);
    expect(await stateOf(projectId)).toBe("accepted");
    expect(await halt(projectId)).toBe("already-blocked");
    expect(await stateOf(projectId)).toBe("accepted");
    expect(await stop(projectId)).toBe(false);
    expect(await stateOf(projectId)).toBe("stopped");
  });

  test("a halted project is not accepted: the guard refuses and nothing is written", async () => {
    const projectId = await newProject();
    await halt(projectId);
    await expect(accept(projectId)).rejects.toMatchObject({ name: "ProjectLifecycleRefused" });
    expect(await stateOf(projectId)).toBe("blocked");
  });

  test("the two records cannot disagree: no halt on a stopped project, no stopped project left halted", async () => {
    const projectId = await newProject();
    await stop(projectId);
    await expect(
      db.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${projectId}, 'fault', 'X', 'y')`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/is halted while its lifecycle is stopped/) } });
    expect(await stateOf(projectId)).toBe("stopped");
  });
});
