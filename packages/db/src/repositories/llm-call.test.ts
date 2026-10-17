import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { llmCalls } from "../schema/finance.js";
import { ClientRepository } from "./client.js";
import { LlmCallRepository } from "./llm-call.js";
import { ProjectRepository } from "./project.js";

// Every row here belongs to a project this suite creates under a unique name; its llm_calls rows go
// before it.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projectId: ProjectId;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const clientId = (await new ClientRepository(db).create(`llm-call-test-${NONCE}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`llm-call-test-${NONCE}-project`, clientId)).id;
});

afterAll(async () => {
  const pattern = `llm-call-test-${NONCE}-%`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("LlmCallRepository.admit", () => {
  test("the admitted row carries the trace the call was admitted in (migration 076)", async () => {
    const id = randomUUID();
    const traceId = randomUUID();
    await new LlmCallRepository(db).admit({
      id,
      projectId,
      taskId: null,
      callSite: "agent-runner",
      provider: "stub",
      model: "m",
      estimatedCostUsd: 0.01,
      traceId,
    });

    const [row] = await db.select({ traceId: llmCalls.traceId, state: llmCalls.state }).from(llmCalls).where(eq(llmCalls.id, id));
    expect(row).toEqual({ traceId, state: "pending" });
  });
});
