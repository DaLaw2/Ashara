import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { ProjectRepository, createProjectWithVision } from "./project.js";
import { VisionRepository } from "./vision.js";

// Against the shared dev database: every row here is created by this suite under
// a unique name and deleted in afterAll; nothing else is read or written.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projects: ProjectRepository;
let visions: VisionRepository;

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

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return messageChain(e);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

function vision(text: string) {
  return { visionText: text, summary: `summary of ${text}` };
}

beforeAll(() => {
  db = createDb(DATABASE_URL);
  projects = new ProjectRepository(db);
  visions = new VisionRepository(db);
});

afterAll(async () => {
  const pattern = `project-test-${NONCE}-%`;
  await db.execute(
    sql`DELETE FROM vision_documents WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`,
  );
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("Project Record vision versions", () => {
  let a: ProjectId;
  let b: ProjectId;

  beforeAll(async () => {
    a = (await createProjectWithVision(db, `project-test-${NONCE}-a`, vision("vision A1"))).project.id;
    b = (await createProjectWithVision(db, `project-test-${NONCE}-b`, vision("vision B1"))).project.id;
  });

  test("each project's first vision is version 1", async () => {
    expect((await visions.getCurrent(a))?.version).toBe(1);
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });

  test("a second vision of one project is version 2 and leaves the other at 1", async () => {
    const second = await visions.create(a, vision("vision A2"));
    expect(second.version).toBe(2);
    expect((await visions.getCurrent(a))?.visionText).toBe("vision A2");
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });

  test("reading one project never returns another project's vision", async () => {
    const readB = await visions.getCurrent(b);
    expect(readB?.projectId).toBe(b);
    expect(readB?.visionText).toBe("vision B1");
  });

  test("a project with no vision reads as null", async () => {
    const empty = await projects.create(`project-test-${NONCE}-empty`);
    expect(await visions.getCurrent(empty.id)).toBeNull();
    expect((await projects.get(empty.id))?.status).toBe("active");
  });

  test("a tender whose vision insert fails leaves no project row", async () => {
    const name = `project-test-${NONCE}-rollback`;
    await expect(
      // Postgres rejects a NUL byte in text, so the vision insert fails after the project insert.
      createProjectWithVision(db, name, { visionText: "x\u0000y", summary: "s" }),
    ).rejects.toThrow();
    const rows = await db.execute(sql`SELECT 1 FROM projects WHERE name = ${name}`);
    expect(rows.rows).toHaveLength(0);
  });
});

describe("project_id is required", () => {
  test("a work item insert without project_id fails", async () => {
    const message = await failureOf(() =>
      db.execute(
        sql`INSERT INTO work_items (id, level, status, title, run_scope) VALUES (${randomUUID()}, 'Task', 'Pending', 'no project', 'test-run')`,
      ),
    );
    expect(message).toMatch(/null value in column "project_id"/);
  });

  test("a vision insert without project_id fails", async () => {
    const message = await failureOf(() =>
      db.execute(
        sql`INSERT INTO vision_documents (version, vision_text, summary) VALUES (1, 'no project', 'no project')`,
      ),
    );
    expect(message).toMatch(/null value in column "project_id"/);
  });
});
