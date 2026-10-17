import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import { ClientChanges, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import type { ClientChangeStore } from "@ashara/engagement";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared";
import { createClientChangeStore } from "@ashara/server/client-change-store";

// A client's change is never left unread: the
// Liaison consumes each with one plain reply and a domain event. Every row belongs to a project
// this suite creates under a unique name, and the Liaison is narrowed to those projects.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME_PREFIX = `client-change-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

function liaison(handle: ReturnType<typeof createDb>, wrap: (store: ClientChangeStore) => ClientChangeStore = (s) => s): ClientChanges {
  const store = createClientChangeStore(handle);
  return new ClientChanges(
    wrap({ ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) }),
    memoryStepContainment(() => true),
  );
}

async function activeProject(): Promise<ProjectId> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build it.");
  ourProjects.add(project.id);
  return project.id;
}

async function sendChange(projectId: ProjectId, body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body, inReplyTo: null });
}

const ReplyRows = z.array(z.object({ body: z.string(), inReplyTo: z.string().nullable(), reportsOn: z.string().nullable() }));

async function repliesTo(changeId: string) {
  const result = await db.execute(sql`
    SELECT body, in_reply_to AS "inReplyTo", reports_on AS "reportsOn" FROM client_messages
    WHERE in_reply_to = ${changeId} AND direction = 'outbound' AND kind = 'report'`);
  return ReplyRows.parse(result.rows);
}

async function consumedAt(messageId: string) {
  const result = await db.execute(sql`SELECT consumed_at AS "consumedAt" FROM client_messages WHERE id = ${messageId}`);
  return z.array(z.object({ consumedAt: z.coerce.date().nullable() })).parse(result.rows)[0]?.consumedAt ?? null;
}

async function eventsFor(changeId: string) {
  const result = await db.execute(sql`
    SELECT event_type AS "eventType", source_context AS "sourceContext", payload FROM domain_events
    WHERE event_type = 'client_change.not_applied' AND payload->>'changeMessageId' = ${changeId}`);
  return z
    .array(z.object({ eventType: z.string(), sourceContext: z.string(), payload: z.record(z.string(), z.unknown()) }))
    .parse(result.rows);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM domain_events WHERE event_type = 'client_change.not_applied' AND payload->>'projectId' IN (SELECT id::text FROM projects WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a client's change", () => {
  test("sent mid-run gets exactly one plain reply, is consumed and recorded, and a restart does not answer it again", async () => {
    const projectId = await activeProject();
    expect(await liaison(db).runPending()).toEqual([]);

    const change = await sendChange(projectId, "Make the output JSON instead of text.");
    const outcomes = await liaison(db).runPending();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ changeId: change.id, projectId });

    const replies = await repliesTo(change.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.reportsOn).toBeNull();
    expect(replies[0]?.body).toContain("received and is kept on record");
    expect(replies[0]?.body).toContain("does not yet apply a change of direction");
    expect(replies[0]?.body).toContain("send it as a new request");
    expect(await consumedAt(change.id)).not.toBeNull();
    const events = await eventsFor(change.id);
    expect(events).toHaveLength(1);
    const [deferred] = outcomes;
    expect(events[0]).toMatchObject({ sourceContext: "engagement", payload: { projectId, replyMessageId: deferred?.kind === "deferred" ? deferred.replyId : "not deferred" } });

    // A restart: a fresh connection and a fresh Liaison find nothing open.
    const restarted = createDb(DATABASE_URL);
    try {
      expect(await liaison(restarted).runPending()).toEqual([]);
    } finally {
      await restarted.$client.end();
    }
    expect(await repliesTo(change.id)).toHaveLength(1);
    expect(await eventsFor(change.id)).toHaveLength(1);
  });

  test("a failed write leaves the change open and unanswered, and the next cycle answers it once", async () => {
    const projectId = await activeProject();
    const change = await sendChange(projectId, "Add a dark mode.");
    // The event's insert, the transaction's last write, collides with an event already recorded.
    const takenId = randomUUID();
    await db.execute(sql`
      INSERT INTO domain_events (event_id, event_type, timestamp, source_context, payload)
      VALUES (${takenId}, 'client_change.not_applied', NOW(), 'engagement', ${JSON.stringify({ projectId })}::jsonb)`);
    const failing = liaison(db, (store) => ({
      ...store,
      recordDeferred: (open, reply, event) => store.recordDeferred(open, reply, { ...event, eventId: takenId }),
    }));
    await expect(failing.runPending()).rejects.toThrow();
    expect(await repliesTo(change.id)).toHaveLength(0);
    expect(await consumedAt(change.id)).toBeNull();

    const answered = await liaison(db).runPending();
    expect(answered.map((o) => (o.kind === "deferred" ? o.changeId : o.kind))).toEqual([change.id]);
    expect(await repliesTo(change.id)).toHaveLength(1);
    expect(await consumedAt(change.id)).not.toBeNull();
  });
});
