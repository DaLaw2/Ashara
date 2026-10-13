import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { ClientMessageNotConsumable, ClientMessageRepository, createProjectWithTender } from "./client-message.js";
import { ProjectRepository } from "./project.js";

// Against the shared dev database: every row here belongs to a project this suite
// creates under a unique name, and is deleted in afterAll.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let messages: ClientMessageRepository;
let projectId: ProjectId;

const NotificationSchema = z.object({
  type: z.literal("client_message"),
  project_id: z.string(),
  message_id: z.string(),
});

function messageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return messageChain(e);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  messages = new ClientMessageRepository(db);
  projectId = (await new ProjectRepository(db).create(`client-message-test-${NONCE}`)).id;
});

afterAll(async () => {
  const pattern = `client-message-test-${NONCE}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("client_messages NOTIFY", () => {
  test("an inbound insert notifies ashara_events; an outbound insert does not", async () => {
    const listener = new pg.Client({ connectionString: DATABASE_URL });
    await listener.connect();
    const seen: string[] = [];
    let onSeen: () => void = () => {};
    listener.on("notification", (msg) => {
      // domain_events notifications carry a bare event id, not JSON.
      if (msg.channel !== "ashara_events" || !msg.payload?.startsWith("{")) return;
      const parsed = NotificationSchema.safeParse(JSON.parse(msg.payload));
      if (!parsed.success || parsed.data.project_id !== projectId) return;
      seen.push(parsed.data.message_id);
      onSeen();
    });
    try {
      await listener.query("LISTEN ashara_events");

      // Commit order is notification order: the inbound insert after the outbound
      // one is the fence that proves the outbound notification never came.
      const outbound = await messages.insertOutbound({
        projectId,
        kind: "report",
        body: "Progress report.",
        inReplyTo: null,
      });
      const inbound = await messages.insertInbound({
        projectId,
        kind: "change",
        body: "Add a second shop.",
        inReplyTo: null,
      });
      const delivered = new Promise<void>((resolve) => {
        onSeen = () => {
          if (seen.includes(inbound.id)) resolve();
        };
        onSeen();
      });

      await Promise.race([
        delivered,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("no notification for the inbound insert within 5s")), 5000),
        ),
      ]);
      expect(seen).toEqual([inbound.id]);
      expect(seen).not.toContain(outbound.id);
    } finally {
      await listener.end();
    }
  });
});

describe("client_messages constraints", () => {
  test("an inbound 'question' inserted directly is rejected by the direction/kind CHECK", async () => {
    const message = await failureOf(() =>
      db.execute(
        sql`INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'inbound', 'question', 'q?')`,
      ),
    );
    expect(message).toMatch(/client_messages_direction_kind/);
  });

  test("an outbound kind through insertInbound and an empty body are rejected", async () => {
    expect(
      await failureOf(() => messages.insertInbound({ projectId, kind: "report", body: "r", inReplyTo: null })),
    ).toMatch(/client_messages_direction_kind/);
    expect(
      await failureOf(() => messages.insertInbound({ projectId, kind: "stop", body: "", inReplyTo: null })),
    ).toMatch(/client_messages_body_check/);
  });

  test("an answer without in_reply_to is rejected", async () => {
    expect(
      await failureOf(() => messages.insertInbound({ projectId, kind: "answer", body: "a", inReplyTo: null })),
    ).toMatch(/client_messages_answer_replies/);
  });
});

describe("ClientMessageRepository", () => {
  test("markConsumed consumes an inbound message once and never an outbound one", async () => {
    const inbound = await messages.insertInbound({ projectId, kind: "stop", body: "Stop.", inReplyTo: null });
    const consumed = await messages.markConsumed(inbound.id);
    expect(consumed.consumedAt).toBeInstanceOf(Date);
    await expect(messages.markConsumed(inbound.id)).rejects.toBeInstanceOf(ClientMessageNotConsumable);

    const outbound = await messages.insertOutbound({ projectId, kind: "question", body: "Why?", inReplyTo: null });
    await expect(messages.markConsumed(outbound.id)).rejects.toBeInstanceOf(ClientMessageNotConsumable);
  });

  test("a tender whose message insert fails leaves no project row", async () => {
    const name = `client-message-test-${NONCE}-rollback`;
    // Postgres rejects a NUL byte in text, so the message insert fails after the project insert.
    await expect(createProjectWithTender(db, name, "x\u0000y")).rejects.toThrow();
    const rows = await db.execute(sql`SELECT 1 FROM projects WHERE name = ${name}`);
    expect(rows.rows).toHaveLength(0);
  });
});
