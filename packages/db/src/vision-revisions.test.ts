import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "./connection.js";
import { ClientRepository } from "./repositories/client.js";
import { ProjectRepository } from "./repositories/project.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";

// Every row here belongs to a project this suite creates under a unique name; afterAll deletes the
// project, and its versions, messages and revisions with it.
// A revision the client wrote names the message it was read from, so the trust record can always tell
// whose words changed the contract; a client revision naming none is refused.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `vision-revisions-test-${randomUUID().slice(0, 8)}`;
const OPS = JSON.stringify([{ target: "exclusion", action: "add", key: "X1", direction: "narrows", labelled: "narrows", read: null, statement: null }]);

let db: Database;
let clientId: string;
let projectId: string;
let messageId: string;

/** The message of `err` and of every error in its `cause` chain, joined. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/** The message chain of the statement's failure; a statement that succeeds fails the test. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return messageChain(e);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function insertRevision(version: number, sourceMessageId: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO vision_revisions (project_id, based_on_version, version, author, approver, direction, cause, source_message_id, ops, status)
    VALUES (${projectId}, ${version - 1}, ${version}, 'client', 'client', 'narrows', 'client-change', ${sourceMessageId}, ${OPS}::jsonb, 'applied')`);
}

async function revisionCount(): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM vision_revisions WHERE project_id = ${projectId}`);
  return z.tuple([z.object({ n: z.number() })]).parse(result.rows)[0].n;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(NAME)).id;
  projectId = (await new ProjectRepository(db).create(NAME, clientId)).id;
  for (const version of [1, 2, 3]) {
    await db.execute(sql`INSERT INTO vision_documents (project_id, version, vision_text, summary) VALUES (${projectId}, ${version}, 'Build it.', 'It.')`);
  }
  const result = await db.execute(sql`
    INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'inbound', 'change', 'Leave colour out.') RETURNING id`);
  messageId = z.tuple([z.object({ id: z.string() })]).parse(result.rows)[0].id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("vision_revisions", () => {
  test("a client-authored revision without the message it was read from is refused; one naming it is recorded", async () => {
    expect(await failureOf(() => insertRevision(2, null))).toMatch(/vision_revisions_client_source/);
    expect(await revisionCount()).toBe(0);
    await insertRevision(2, messageId);
    expect(await revisionCount()).toBe(1);
  });
});
